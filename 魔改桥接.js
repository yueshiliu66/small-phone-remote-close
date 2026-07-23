/**
 * app跳转插件(最终版)
 *
 * 功能:
 * 1. 管理多个 MCP Server(增删改查、测试连接、拉取工具列表、单个工具开关)
 * 2. 生成可粘贴进角色人设的系统提示词(告诉 AI 有哪些工具、怎么调用)
 * 3. 后台监控指定会话,解析 AI 回复里的 [tool:名字:{json参数}] 标记
 * 4. 自动执行对应 MCP 工具,把结果通过 roche.memory.write 写入该会话的
 *    事实记忆,供 AI 下一轮对话读取到
 *
 * 说明:
 * - 工具结果的写回分两条路径:
 *   ① 优先直接操作 Roche 主 IndexedDB(数据库名 Roche_db,messages 表),
 *      伪造一条"角色发来的消息"插入对话,视觉上跟真实聊天记录一样。
 *      这是参考"朋友圈"插件里"方式1"的做法——注意这是未文档化的内部
 *      实现细节,不受 Roche 官方 API 兼容性保证,版本更新可能随时失效
 *      或写坏数据。
 *   ② 如果①失败(拿不到 indexedDB、表结构变了等),自动退回官方
 *      roche.memory.write() 写入事实记忆,只是不会马上显示在聊天里,
 *      要等 AI 下一次生成回复时才会读到。
 * - 只支持 Streamable HTTP 传输;SSE 类型的 server 可以保存,但监控执行
 *   阶段暂不支持,标注为"暂不支持自动执行"。
 * - 后台常驻:GLOBAL_STATE 是模块级变量,关闭插件页面(unmount)不会清空
 *   monitorInterval,监控会持续运行,直到手动停止或整个页面刷新。
 */
(function () {
  "use strict";

  // ============================================================
  // 🌍 全局状态(模块级,插件页面关闭后依然存活)
  // ============================================================
  const GLOBAL_STATE = {
    roche: null,
    servers: [], // 从 roche.storage 加载
    monitorConvIds: [], // 正在监控的会话 id 列表
    lastProcessedTs: {}, // { [convId]: timestamp }
    isMonitoring: false,
    monitorInterval: null,
    sessionRefs: {}, // { [serverId]: { id: sessionId | null } }
    onLogChange: null,
    onMonitorStatusChange: null,
    logLines: [],
  };

  function log(text) {
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    GLOBAL_STATE.logLines.unshift(line);
    GLOBAL_STATE.logLines = GLOBAL_STATE.logLines.slice(0, 50);
    if (GLOBAL_STATE.onLogChange) GLOBAL_STATE.onLogChange(GLOBAL_STATE.logLines.join("\n"));
  }

  function makeId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function emptyServer() {
    return {
      id: makeId(),
      name: "",
      enabled: true,
      transport: "streamable-http",
      url: "",
      headers: [],
      toolsEnabled: null, // null = 全部启用
      cachedTools: [],
    };
  }

  // ============================================================
  // 💾 持久化(roche.storage,插件私有)
  // ============================================================
  async function loadServers(roche) {
    const list = await roche.storage.get("mcpServers");
    return Array.isArray(list) ? list : [];
  }
  async function saveServers(roche, servers) {
    await roche.storage.set("mcpServers", servers);
  }
  async function loadMonitorConvIds(roche) {
    const list = await roche.storage.get("mcpMonitorConvIds");
    return Array.isArray(list) ? list : [];
  }
  async function saveMonitorConvIds(roche, ids) {
    await roche.storage.set("mcpMonitorConvIds", ids);
  }
  async function loadLastProcessedTs(roche) {
    const map = await roche.storage.get("mcpLastProcessedTs");
    return map && typeof map === "object" ? map : {};
  }
  async function saveLastProcessedTs(roche, map) {
    await roche.storage.set("mcpLastProcessedTs", map);
  }
  async function loadMonitorEnabled(roche) {
    const v = await roche.storage.get("mcpMonitorEnabled");
    return v === true;
  }
  async function saveMonitorEnabled(roche, enabled) {
    await roche.storage.set("mcpMonitorEnabled", enabled);
  }

  // ============================================================
  // 📡 MCP JSON-RPC(Streamable HTTP)
  // ============================================================
  async function rawRpc(server, method, params, sessionRef) {
    const headers = { "Content-Type": "application/json" };
    (server.headers || []).forEach((h) => {
      if (h.key) headers[h.key] = h.value || "";
    });
    if (sessionRef.id) headers["Mcp-Session-Id"] = sessionRef.id;

    const resp = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now() + Math.random(),
        method,
        params: params || {},
      }),
    });
    const sid = resp.headers.get("Mcp-Session-Id");
    if (sid) sessionRef.id = sid;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  async function ensureSession(server) {
    if (!GLOBAL_STATE.sessionRefs[server.id]) {
      GLOBAL_STATE.sessionRefs[server.id] = { id: null };
    }
    const sessionRef = GLOBAL_STATE.sessionRefs[server.id];
    if (!sessionRef.initialized) {
      await rawRpc(
        server,
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "roche-mcp-tool-bridge", version: "1.0.0" },
        },
        sessionRef
      );
      sessionRef.initialized = true;
    }
    return sessionRef;
  }

  async function testAndListTools(server) {
    if (server.transport === "sse") {
      throw new Error("调试面板暂时只支持直接测试 Streamable HTTP,SSE 类型请直接保存后在正式对话里验证");
    }
    const sessionRef = { id: null };
    const startedAt = Date.now();
    await rawRpc(
      server,
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "roche-mcp-tool-bridge", version: "1.0.0" },
      },
      sessionRef
    );
    const list = await rawRpc(server, "tools/list", {}, sessionRef);
    const latency = Date.now() - startedAt;
    const tools = (list.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
    return { tools, latency };
  }

  async function callServerTool(server, toolName, args) {
    const sessionRef = await ensureSession(server);
    try {
      return await rawRpc(server, "tools/call", { name: toolName, arguments: args || {} }, sessionRef);
    } catch (e) {
      // 会话可能过期,重新握手重试一次
      sessionRef.initialized = false;
      sessionRef.id = null;
      const retryRef = await ensureSession(server);
      return await rawRpc(server, "tools/call", { name: toolName, arguments: args || {} }, retryRef);
    }
  }

  // ============================================================
  // 💬 直接往 Roche 主 IndexedDB 插入一条"消息",伪装成聊天记录
  // 参考朋友圈插件的"方式1直接IndexedDB注入" —— 未文档化,有风险
  // ============================================================
  function openRocheDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("Roche_db");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function addMsgRecord(db, store, msg) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readwrite").objectStore(store).add(msg);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 尝试拿会话对应的角色信息,让插入的消息 senderId 尽量真实
  async function resolveSenderId(roche, convId) {
    try {
      const conv = await roche.conversation.get(convId);
      return (conv && (conv.contactId || conv.id)) || "mcp-tool-bridge";
    } catch (e) {
      return "mcp-tool-bridge";
    }
  }

  // 把工具执行结果直接插入聊天记录(方式①),失败则退回 memory.write(方式②)
  async function writeToolResult(roche, convId, call, result) {
    const text = `🔧 [${call.name}] ${JSON.stringify(result)}`;
    try {
      const db = await openRocheDb();
      const senderId = await resolveSenderId(roche, convId);
      const now = Date.now();
      const msg = {
        id: now + Math.floor(Math.random() * 1000),
        isMe: false,
        text,
        senderId,
        timestamp: now,
        senderName: "MCP 工具",
        conversationId: convId,
      };
      await addMsgRecord(db, "messages", msg);
      db.close();
      log(`💬 已直接插入聊天记录: ${text.slice(0, 80)}`);
      return { ok: true, method: "indexeddb" };
    } catch (e) {
      log(`⚠️ 直接插入聊天失败(${e.message}),退回 memory.write`);
      try {
        await roche.memory.write({
          conversationId: convId,
          summaryText: `[工具结果] ${call.name}(${JSON.stringify(call.args)}): ${JSON.stringify(result)}`,
          who: ["系统"],
          action: `执行了工具 ${call.name}`,
          when: "刚刚",
          where: "聊天中",
          source: "plugin",
        });
        return { ok: true, method: "memory" };
      } catch (e2) {
        log(`❌ memory.write 也失败: ${e2.message}`);
        return { ok: false, error: e2.message };
      }
    }
  }

  function isToolEnabled(server, toolName) {
    const f = server.toolsEnabled;
    return f === null || f === undefined || f.includes(toolName);
  }

  // 在所有启用的 server 里找一个提供了这个工具名、且该工具被启用的 server
  function findServerForTool(servers, toolName) {
    for (const s of servers) {
      if (!s.enabled) continue;
      if (s.transport === "sse") continue; // 暂不支持自动执行
      const tool = (s.cachedTools || []).find((t) => t.name === toolName);
      if (tool && isToolEnabled(s, toolName)) return s;
    }
    return null;
  }

  // ============================================================
  // 📝 生成系统提示词
  // ============================================================
  function buildSystemPrompt(servers) {
    const lines = [];
    lines.push("【工具调用能力】");
    lines.push('你可以使用下列工具获取信息或执行操作。需要用工具时,在回复中插入标记:');
    lines.push('[tool:工具名:{"参数名":"参数值"}]');
    lines.push("标记会被程序自动执行,不需要在回复里额外解释。执行结果会作为记忆提供给你,可能在下一轮才能看到。");
    lines.push("可用工具:");
    for (const s of servers) {
      if (!s.enabled || s.transport === "sse") continue;
      for (const t of s.cachedTools || []) {
        if (!isToolEnabled(s, t.name)) continue;
        const props = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [];
        lines.push(`- ${t.name}: ${t.description || ""}${props.length ? `（参数: ${props.join(", ")}）` : "（无参数）"}`);
      }
    }
    lines.push("");
    lines.push("规则:");
    lines.push("1. 只在确实需要该信息/操作时才调用,不要每次回复都调用");
    lines.push("2. 一次回复里可以包含多个工具标记");
    lines.push("3. 参数必须是合法 JSON,没有参数就写 {}");
    return lines.join("\n");
  }

  // ============================================================
  // 🔍 解析 AI 回复里的工具调用标记
  // ============================================================
  const TAG_PATTERN = /\[tool\s*:\s*([a-zA-Z0-9_]+)\s*:\s*(\{[\s\S]*?\})\]/g;

  function parseToolCalls(text) {
    if (!text) return [];
    const calls = [];
    const re = new RegExp(TAG_PATTERN);
    let m;
    while ((m = re.exec(text)) !== null) {
      let args = {};
      try {
        args = JSON.parse(m[2]);
      } catch (e) {
        continue;
      }
      calls.push({ name: m[1], args, raw: m[0] });
    }
    return calls;
  }

  // 判断一条消息是不是"对方"(角色/AI)发的,不是用户自己发的。
  // Roche 真实消息 schema 用的是 isMe 布尔字段(参考朋友圈插件写入时用的字段),
  // 不是 role/type 这种 OpenAI 式约定。isMe 缺失时退回比对 senderId 与
  // 该会话当前使用的用户人设 id(conversation.myActivePersonaId)。
  function isFromOther(msg, conv) {
    if (typeof msg.isMe === "boolean") return !msg.isMe;
    if (conv && conv.myActivePersonaId && msg.senderId) {
      return msg.senderId !== conv.myActivePersonaId;
    }
    // 两种判定依据都没有,为避免把用户自己的消息误当成 AI 指令,保守起见跳过
    return false;
  }

  // ============================================================
  // 👀 后台监控:轮询指定会话的最新消息,执行工具调用,写回记忆
  // ============================================================
  async function checkConversation(roche, convId) {
    const msgs = await roche.memory.getShortTerm({ conversationId: convId, limit: 10 });
    if (!msgs || !msgs.length) return;

    let conv = null;
    try {
      conv = await roche.conversation.get(convId);
    } catch (e) {
      /* 拿不到就退化成只信 isMe 字段 */
    }

    const lastTs = GLOBAL_STATE.lastProcessedTs[convId] || 0;
    let maxTs = lastTs;

    for (const msg of msgs) {
      const ts = msg.timestamp || 0;
      if (ts <= lastTs) continue;
      maxTs = Math.max(maxTs, ts);

      const text = msg.text || msg.content || "";
      const isOther = isFromOther(msg, conv);

      if (!isOther) {
        if (text.indexOf("[tool:") !== -1) {
          log(`ℹ️ 跳过一条含 [tool: 的消息,判定为用户自己发的(isMe=${msg.isMe})`);
        }
        continue;
      }

      const calls = parseToolCalls(text);
      if (!calls.length) {
        if (text.indexOf("[tool:") !== -1) {
          log(`⚠️ 检测到 [tool: 标记但解析失败,原文: ${text.slice(0, 80)}`);
        }
        continue;
      }

      log(`会话 ${convId} 检测到 ${calls.length} 个工具调用`);

      for (const call of calls) {
        const server = findServerForTool(GLOBAL_STATE.servers, call.name);
        if (!server) {
          log(`⚠️ 未找到提供 ${call.name} 的已启用 server`);
          continue;
        }
        try {
          const result = await callServerTool(server, call.name, call.args);
          log(`✅ ${call.name} -> ${JSON.stringify(result).slice(0, 120)}`);

          // go_scene 工具：直接跳转快捷指令（全自动，无需点击）
          if (call.name === "go_scene") {
            const sceneMap = {
              "睡前": "去睡觉", "专注": "去专注",
              "娱乐": "去娱乐", "回桌面": "去桌面", "运动": "去运动",
            };
            const shortcut = sceneMap[call.args && call.args.scene];
            if (shortcut) window.location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(shortcut)}`;
          }


          await writeToolResult(roche, convId, call, result);
        } catch (e) {
          log(`❌ ${call.name} 调用失败: ${e.message}`);
        }
      }
    }

    if (maxTs > lastTs) {
      GLOBAL_STATE.lastProcessedTs[convId] = maxTs;
      await saveLastProcessedTs(roche, GLOBAL_STATE.lastProcessedTs);
    }
  }

  async function checkAllConversations() {
    const roche = GLOBAL_STATE.roche;
    if (!roche || !GLOBAL_STATE.monitorConvIds.length) return;
    for (const convId of GLOBAL_STATE.monitorConvIds) {
      try {
        await checkConversation(roche, convId);
      } catch (e) {
        log(`⚠️ 监控会话 ${convId} 异常: ${e.message}`);
      }
    }
  }

  function startMonitor() {
    // 只清理已有的 interval,不调用会打印"已停止"日志的 stopMonitor()
    if (GLOBAL_STATE.monitorInterval) clearInterval(GLOBAL_STATE.monitorInterval);
    GLOBAL_STATE.isMonitoring = true;
    GLOBAL_STATE.monitorInterval = setInterval(checkAllConversations, 4000);
    if (GLOBAL_STATE.onMonitorStatusChange) GLOBAL_STATE.onMonitorStatusChange(true);
    log("监控已启动");
    if (GLOBAL_STATE.roche) saveMonitorEnabled(GLOBAL_STATE.roche, true).catch(() => {});
  }

  function stopMonitor() {
    if (GLOBAL_STATE.monitorInterval) clearInterval(GLOBAL_STATE.monitorInterval);
    GLOBAL_STATE.monitorInterval = null;
    GLOBAL_STATE.isMonitoring = false;
    if (GLOBAL_STATE.onMonitorStatusChange) GLOBAL_STATE.onMonitorStatusChange(false);
    log("监控已停止");
    if (GLOBAL_STATE.roche) saveMonitorEnabled(GLOBAL_STATE.roche, false).catch(() => {});
  }

  // ============================================================
  // 🖼️ 插件 UI
  // ============================================================
  window.RochePlugin.register({
    id: "mcp-tool-bridge",
    name: "app跳转工具桥接",
    version: "1.0.0",
    apps: [
      {
        id: "mcp-tool-bridge-home",
        name: "app跳转工具桥接",
        icon: "settings",
        iconImage: "",

        async mount(container, roche) {
          GLOBAL_STATE.roche = roche;
          GLOBAL_STATE.servers = await loadServers(roche);
          GLOBAL_STATE.monitorConvIds = await loadMonitorConvIds(roche);
          GLOBAL_STATE.lastProcessedTs = await loadLastProcessedTs(roche);

          // 恢复上次的监控开关状态。如果用户之前是"开启"的,
          // 且已经勾了要监控的会话,这里自动重新启动,不需要手动再点一次。
          // 只在当前确实没在跑的时候恢复,避免脚本本来就常驻运行时被重复启动。
          if (!GLOBAL_STATE.isMonitoring) {
            const shouldResume = await loadMonitorEnabled(roche);
            if (shouldResume && GLOBAL_STATE.monitorConvIds.length > 0) {
              startMonitor();
              log("检测到上次监控是开启状态,已自动恢复");
            }
          }

          const state = {
            view: "list", // list | edit | monitor
            editing: null,
            editTab: "basic", // basic | tools
            testStatus: "idle",
            testMessage: "",
            conversations: [],
          };

          const style = document.createElement("style");
          style.textContent = `
            .rmtb-root { font-family: sans-serif; height: 100%; overflow-y: auto; background: #111214; color: #eee; padding: 12px; box-sizing: border-box; }
            .rmtb-root * { box-sizing: border-box; }
            .rmtb-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 8px; }
            .rmtb-title { font-size: 17px; font-weight: 600; flex: 1; }
            .rmtb-back, .rmtb-add, .rmtb-nav-btn { background: #2a2b2f; color: #eee; border: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; }
            .rmtb-add { background: #3b6ef0; }
            .rmtb-nav-btn.active { background: #3b6ef0; }
            .rmtb-empty { color: #666; font-size: 13px; text-align: center; padding: 40px 0; }
            .rmtb-server-item { background: #1b1c1f; border-radius: 12px; padding: 12px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .rmtb-server-info { flex: 1; min-width: 0; }
            .rmtb-server-name { font-size: 14px; font-weight: 600; }
            .rmtb-server-url { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .rmtb-server-meta { font-size: 11px; color: #666; margin-top: 2px; }
            .rmtb-dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:4px; }
            .rmtb-dot.on { background:#4ade80; } .rmtb-dot.off { background:#666; }
            .rmtb-tabs { display: flex; border-bottom: 1px solid #2a2b2f; margin-bottom: 16px; }
            .rmtb-tab { flex: 1; text-align: center; padding: 10px 0; font-size: 14px; color: #999; }
            .rmtb-tab.active { color: #6ea8fe; border-bottom: 2px solid #3b6ef0; font-weight: 600; }
            .rmtb-field { margin-bottom: 16px; }
            .rmtb-label { font-size: 15px; font-weight: 600; display: block; margin-bottom: 2px; }
            .rmtb-hint { font-size: 12px; color: #888; margin-bottom: 8px; display: block; }
            .rmtb-input { width: 100%; background: #1b1c1f; color: #eee; border: 1px solid #333; border-radius: 10px; padding: 12px; font-size: 14px; }
            .rmtb-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; display:inline-block; }
            .rmtb-switch input { opacity: 0; width: 0; height: 0; }
            .rmtb-slider { position: absolute; cursor: pointer; inset: 0; background: #444; border-radius: 24px; transition: 0.15s; }
            .rmtb-slider:before { content: ""; position: absolute; height: 18px; width: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.15s; }
            .rmtb-switch input:checked + .rmtb-slider { background: #3b6ef0; }
            .rmtb-switch input:checked + .rmtb-slider:before { transform: translateX(20px); }
            .rmtb-segment { display: flex; border: 1px solid #333; border-radius: 10px; overflow: hidden; }
            .rmtb-segment-btn { flex: 1; text-align: center; padding: 10px; font-size: 13px; background: #1b1c1f; color: #ccc; }
            .rmtb-segment-btn.active { background: #2a3a6e; color: #9ec2ff; }
            .rmtb-header-row-btn { width: 100%; background: #2a2b2f; color: #eee; border: none; border-radius: 10px; padding: 12px; font-size: 14px; text-align: center; }
            .rmtb-header-row { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
            .rmtb-header-row input { flex: 1; }
            .rmtb-header-remove { background: #7a2a2a; color: #fff; border: none; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
            .rmtb-btn-row { display: flex; gap: 8px; margin-top: 20px; }
            .rmtb-btn { flex: 1; border: none; border-radius: 10px; padding: 12px; font-size: 14px; }
            .rmtb-btn.primary { background: #3b6ef0; color: #fff; }
            .rmtb-btn.secondary { background: #2a2b2f; color: #eee; }
            .rmtb-btn.danger { background: #7a2a2a; color: #fff; }
            .rmtb-status { font-size: 13px; margin-top: 8px; line-height: 1.5; }
            .rmtb-status.success { color: #4ade80; }
            .rmtb-status.error { color: #f87171; }
            .rmtb-status.testing { color: #fbbf24; }
            .rmtb-tool-row { background: #1b1c1f; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .rmtb-tool-name { font-size: 13px; font-weight: 600; }
            .rmtb-tool-desc { font-size: 11px; color: #888; margin-top: 2px; }
            .rmtb-conv-row { background: #1b1c1f; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .rmtb-log { font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow: auto; background:#1b1c1f; border-radius:10px; padding:10px; margin:0; }
          `;
          container.appendChild(style);

          const root = document.createElement("div");
          root.className = "rmtb-root";
          container.appendChild(root);

          function escapeHtml(str) {
            return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }

          async function persistServers() {
            await saveServers(roche, GLOBAL_STATE.servers);
          }

          // ---------------- 顶部导航 ----------------
          function renderTopNav() {
            const nav = document.createElement("div");
            nav.className = "rmtb-header";
            const title = document.createElement("div");
            title.className = "rmtb-title";
            title.textContent = "app跳转工具桥接";
            nav.appendChild(title);

            const serversBtn = document.createElement("button");
            serversBtn.className = "rmtb-nav-btn" + (state.view === "list" || state.view === "edit" ? " active" : "");
            serversBtn.textContent = "服务器";
            serversBtn.onclick = () => { state.view = "list"; render(); };
            nav.appendChild(serversBtn);

            const monitorBtn = document.createElement("button");
            monitorBtn.className = "rmtb-nav-btn" + (state.view === "monitor" ? " active" : "");
            monitorBtn.textContent = "监控";
            monitorBtn.onclick = async () => {
              state.view = "monitor";
              state.conversations = await roche.conversation.list();
              render();
            };
            nav.appendChild(monitorBtn);

            const closeBtn = document.createElement("button");
            closeBtn.className = "rmtb-back";
            closeBtn.textContent = "返回";
            closeBtn.onclick = () => roche.ui.closeApp();
            nav.appendChild(closeBtn);

            root.appendChild(nav);
          }

          // ---------------- 服务器列表 ----------------
          function renderList() {
            const addBtn = document.createElement("button");
            addBtn.className = "rmtb-add";
            addBtn.style.width = "100%";
            addBtn.style.marginBottom = "12px";
            addBtn.textContent = "+ 添加 MCP Server";
            addBtn.onclick = () => openEdit(null);
            root.appendChild(addBtn);

            if (GLOBAL_STATE.servers.length === 0) {
              const empty = document.createElement("div");
              empty.className = "rmtb-empty";
              empty.textContent = '还没有添加 MCP Server,点上方"+ 添加"';
              root.appendChild(empty);
              return;
            }

            GLOBAL_STATE.servers.forEach((server) => {
              const item = document.createElement("div");
              item.className = "rmtb-server-item";

              const info = document.createElement("div");
              info.className = "rmtb-server-info";
              const toolCount =
                server.toolsEnabled === null || server.toolsEnabled === undefined
                  ? `全部工具(${(server.cachedTools || []).length})`
                  : `${server.toolsEnabled.length}/${(server.cachedTools || []).length} 个工具已启用`;
              info.innerHTML = `
                <div class="rmtb-server-name">${escapeHtml(server.name || "未命名")}</div>
                <div class="rmtb-server-url">${escapeHtml(server.url)}</div>
                <div class="rmtb-server-meta">
                  <span class="rmtb-dot ${server.enabled ? "on" : "off"}"></span>${server.enabled ? "已启用" : "已禁用"}
                  · ${server.transport === "sse" ? "SSE(不支持自动执行)" : "Streamable HTTP"} · ${toolCount}
                </div>
              `;
              info.onclick = () => openEdit(server);
              item.appendChild(info);

              const switchLabel = document.createElement("label");
              switchLabel.className = "rmtb-switch";
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.checked = server.enabled;
              checkbox.onchange = async (e) => {
                server.enabled = e.target.checked;
                await persistServers();
                render();
              };
              const slider = document.createElement("span");
              slider.className = "rmtb-slider";
              switchLabel.appendChild(checkbox);
              switchLabel.appendChild(slider);
              item.appendChild(switchLabel);

              root.appendChild(item);
            });

            const promptBtn = document.createElement("button");
            promptBtn.className = "rmtb-btn primary";
            promptBtn.style.width = "100%";
            promptBtn.style.marginTop = "12px";
            promptBtn.textContent = "生成并复制系统提示词";
            promptBtn.onclick = async () => {
              const prompt = buildSystemPrompt(GLOBAL_STATE.servers);
              try {
                await navigator.clipboard.writeText(prompt);
                roche.ui.toast("已复制,粘贴到角色人设末尾");
              } catch (e) {
                roche.ui.toast("复制失败: " + e.message);
              }
            };
            root.appendChild(promptBtn);
          }

          // ---------------- 服务器编辑 ----------------
          function openEdit(server) {
            state.editing = server ? JSON.parse(JSON.stringify(server)) : emptyServer();
            if (!state.editing.cachedTools) state.editing.cachedTools = [];
            state.editTab = "basic";
            if (state.editing.cachedTools.length > 0) {
              state.testStatus = "success";
              state.testMessage = `上次测试成功,缓存了 ${state.editing.cachedTools.length} 个工具(点"重新测试"可刷新)`;
            } else {
              state.testStatus = "idle";
              state.testMessage = "";
            }
            state.view = "edit";
            render();
          }

          async function doTestAndListTools() {
            if (!state.editing.url) {
              state.testStatus = "error";
              state.testMessage = "请先填服务器地址";
              render();
              return;
            }
            state.testStatus = "testing";
            state.testMessage = "连接中...";
            render();
            try {
              const { tools, latency } = await testAndListTools(state.editing);
              state.editing.cachedTools = tools;
              state.testStatus = "success";
              state.testMessage = `连接成功,延迟 ${latency}ms,发现 ${tools.length} 个工具`;
            } catch (e) {
              state.testStatus = "error";
              state.testMessage = "连接失败:" + e.message;
            }
            render();
          }

          function toggleTool(toolName, checked) {
            if (state.editing.toolsEnabled === null || state.editing.toolsEnabled === undefined) {
              state.editing.toolsEnabled = state.editing.cachedTools.map((t) => t.name);
            }
            const set = new Set(state.editing.toolsEnabled);
            if (checked) set.add(toolName);
            else set.delete(toolName);
            state.editing.toolsEnabled = Array.from(set);
            render();
          }

          async function saveEditing() {
            if (!state.editing.name.trim()) return roche.ui.toast("请填名称");
            if (!state.editing.url.trim()) return roche.ui.toast("请填服务器地址");
            const cleaned = { ...state.editing };
            const idx = GLOBAL_STATE.servers.findIndex((s) => s.id === cleaned.id);
            if (idx === -1) GLOBAL_STATE.servers.push(cleaned);
            else GLOBAL_STATE.servers[idx] = cleaned;
            await persistServers();
            state.view = "list";
            roche.ui.toast("已保存");
            render();
          }

          async function deleteEditing() {
            const ok = await roche.ui.confirm({
              title: "删除这个 MCP Server?",
              message: `将删除 "${state.editing.name || "未命名"}",此操作不可撤销。`,
            });
            if (!ok) return;
            GLOBAL_STATE.servers = GLOBAL_STATE.servers.filter((s) => s.id !== state.editing.id);
            await persistServers();
            state.view = "list";
            render();
          }

          function renderEdit() {
            const header = document.createElement("div");
            header.innerHTML = `<div class="rmtb-title" style="margin-bottom:12px;">${state.editing.name ? escapeHtml(state.editing.name) : "新 MCP Server"}</div>`;
            root.appendChild(header);

            const tabs = document.createElement("div");
            tabs.className = "rmtb-tabs";
            const basicTab = document.createElement("div");
            basicTab.className = "rmtb-tab" + (state.editTab === "basic" ? " active" : "");
            basicTab.textContent = "基础设置";
            basicTab.onclick = () => { state.editTab = "basic"; render(); };
            const toolsTab = document.createElement("div");
            toolsTab.className = "rmtb-tab" + (state.editTab === "tools" ? " active" : "");
            toolsTab.textContent = "工具";
            toolsTab.onclick = () => { state.editTab = "tools"; render(); };
            tabs.appendChild(basicTab);
            tabs.appendChild(toolsTab);
            root.appendChild(tabs);

            if (state.editTab === "basic") renderBasicTab();
            else renderToolsTab();

            const btnRow = document.createElement("div");
            btnRow.className = "rmtb-btn-row";
            const isExisting = GLOBAL_STATE.servers.some((s) => s.id === state.editing.id);
            if (isExisting) {
              const delBtn = document.createElement("button");
              delBtn.className = "rmtb-btn danger";
              delBtn.textContent = "删除";
              delBtn.onclick = deleteEditing;
              btnRow.appendChild(delBtn);
            }
            const backBtn = document.createElement("button");
            backBtn.className = "rmtb-btn secondary";
            backBtn.textContent = "返回";
            backBtn.onclick = () => { state.view = "list"; render(); };
            btnRow.appendChild(backBtn);
            const saveBtn = document.createElement("button");
            saveBtn.className = "rmtb-btn primary";
            saveBtn.textContent = "保存";
            saveBtn.onclick = saveEditing;
            btnRow.appendChild(saveBtn);
            root.appendChild(btnRow);
          }

          function renderBasicTab() {
            const enableField = document.createElement("div");
            enableField.className = "rmtb-field";
            enableField.style.display = "flex";
            enableField.style.alignItems = "center";
            enableField.style.justifyContent = "space-between";
            enableField.innerHTML = `<div><span class="rmtb-label">启用</span><span class="rmtb-hint" style="margin-bottom:0">是否启用此 MCP 服务器</span></div>`;
            const switchLabel = document.createElement("label");
            switchLabel.className = "rmtb-switch";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = state.editing.enabled;
            checkbox.onchange = (e) => { state.editing.enabled = e.target.checked; };
            const slider = document.createElement("span");
            slider.className = "rmtb-slider";
            switchLabel.appendChild(checkbox);
            switchLabel.appendChild(slider);
            enableField.appendChild(switchLabel);
            root.appendChild(enableField);

            const nameField = document.createElement("div");
            nameField.className = "rmtb-field";
            nameField.innerHTML = `<span class="rmtb-label">名称</span><span class="rmtb-hint">MCP 服务器的显示名称</span>`;
            const nameInput = document.createElement("input");
            nameInput.className = "rmtb-input";
            nameInput.placeholder = "名称";
            nameInput.value = state.editing.name;
            nameInput.oninput = (e) => { state.editing.name = e.target.value; };
            nameField.appendChild(nameInput);
            root.appendChild(nameField);

            const transportField = document.createElement("div");
            transportField.className = "rmtb-field";
            transportField.innerHTML = `<span class="rmtb-label">传输类型</span><span class="rmtb-hint">目前只有 Streamable HTTP 支持自动执行</span>`;
            const segment = document.createElement("div");
            segment.className = "rmtb-segment";
            const httpBtn = document.createElement("div");
            httpBtn.className = "rmtb-segment-btn" + (state.editing.transport === "streamable-http" ? " active" : "");
            httpBtn.textContent = (state.editing.transport === "streamable-http" ? "✓ " : "") + "Streamable HTTP";
            httpBtn.onclick = () => { state.editing.transport = "streamable-http"; render(); };
            const sseBtn = document.createElement("div");
            sseBtn.className = "rmtb-segment-btn" + (state.editing.transport === "sse" ? " active" : "");
            sseBtn.textContent = (state.editing.transport === "sse" ? "✓ " : "") + "SSE";
            sseBtn.onclick = () => { state.editing.transport = "sse"; render(); };
            segment.appendChild(httpBtn);
            segment.appendChild(sseBtn);
            transportField.appendChild(segment);
            root.appendChild(transportField);

            const urlField = document.createElement("div");
            urlField.className = "rmtb-field";
            urlField.innerHTML = `<span class="rmtb-label">服务器地址</span><span class="rmtb-hint">${state.editing.transport === "sse" ? "SSE" : "流式 HTTP"} 服务器的 URL 地址</span>`;
            const urlInput = document.createElement("input");
            urlInput.className = "rmtb-input";
            urlInput.placeholder = "http://127.0.0.1:端口/mcp";
            urlInput.value = state.editing.url;
            urlInput.oninput = (e) => { state.editing.url = e.target.value; };
            urlField.appendChild(urlInput);
            root.appendChild(urlField);

            const headersField = document.createElement("div");
            headersField.className = "rmtb-field";
            headersField.innerHTML = `<span class="rmtb-label">自定义请求头</span><span class="rmtb-hint">比如 Authorization</span>`;
            (state.editing.headers || []).forEach((h, i) => {
              const row = document.createElement("div");
              row.className = "rmtb-header-row";
              const keyInput = document.createElement("input");
              keyInput.className = "rmtb-input";
              keyInput.placeholder = "Header 名";
              keyInput.value = h.key || "";
              keyInput.oninput = (e) => { state.editing.headers[i].key = e.target.value; };
              const valInput = document.createElement("input");
              valInput.className = "rmtb-input";
              valInput.placeholder = "值";
              valInput.value = h.value || "";
              valInput.oninput = (e) => { state.editing.headers[i].value = e.target.value; };
              const removeBtn = document.createElement("button");
              removeBtn.className = "rmtb-header-remove";
              removeBtn.textContent = "删除";
              removeBtn.onclick = () => { state.editing.headers.splice(i, 1); render(); };
              row.appendChild(keyInput);
              row.appendChild(valInput);
              row.appendChild(removeBtn);
              headersField.appendChild(row);
            });
            const addHeaderBtn = document.createElement("button");
            addHeaderBtn.className = "rmtb-header-row-btn";
            addHeaderBtn.textContent = "+ 添加请求头";
            addHeaderBtn.onclick = () => {
              state.editing.headers = state.editing.headers || [];
              state.editing.headers.push({ key: "", value: "" });
              render();
            };
            headersField.appendChild(addHeaderBtn);
            root.appendChild(headersField);

            const testBtn = document.createElement("button");
            testBtn.className = "rmtb-btn secondary";
            testBtn.style.width = "100%";
            testBtn.textContent =
              state.editing.cachedTools && state.editing.cachedTools.length > 0 ? "重新测试连接" : "测试连接并拉取工具列表";
            testBtn.onclick = doTestAndListTools;
            root.appendChild(testBtn);

            if (state.testMessage) {
              const statusEl = document.createElement("div");
              statusEl.className = "rmtb-status " + state.testStatus;
              statusEl.textContent = state.testMessage;
              root.appendChild(statusEl);
            }
          }

          function renderToolsTab() {
            if (!state.editing.cachedTools || state.editing.cachedTools.length === 0) {
              const empty = document.createElement("div");
              empty.className = "rmtb-empty";
              empty.textContent = '还没有工具列表,先去"基础设置"里测试连接';
              root.appendChild(empty);
              return;
            }
            const bulkRow = document.createElement("div");
            bulkRow.className = "rmtb-btn-row";
            bulkRow.style.marginTop = "0";
            bulkRow.style.marginBottom = "12px";
            const enableAllBtn = document.createElement("button");
            enableAllBtn.className = "rmtb-btn secondary";
            enableAllBtn.textContent = "全部启用";
            enableAllBtn.onclick = () => { state.editing.toolsEnabled = null; render(); };
            const disableAllBtn = document.createElement("button");
            disableAllBtn.className = "rmtb-btn danger";
            disableAllBtn.textContent = "全部禁用";
            disableAllBtn.onclick = () => { state.editing.toolsEnabled = []; render(); };
            bulkRow.appendChild(enableAllBtn);
            bulkRow.appendChild(disableAllBtn);
            root.appendChild(bulkRow);

            state.editing.cachedTools.forEach((tool) => {
              const row = document.createElement("div");
              row.className = "rmtb-tool-row";
              row.innerHTML = `<div><div class="rmtb-tool-name">${escapeHtml(tool.name)}</div><div class="rmtb-tool-desc">${escapeHtml(tool.description || "(无描述)")}</div></div>`;
              const switchLabel = document.createElement("label");
              switchLabel.className = "rmtb-switch";
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.checked = isToolEnabled(state.editing, tool.name);
              checkbox.onchange = (e) => toggleTool(tool.name, e.target.checked);
              const slider = document.createElement("span");
              slider.className = "rmtb-slider";
              switchLabel.appendChild(checkbox);
              switchLabel.appendChild(slider);
              row.appendChild(switchLabel);
              root.appendChild(row);
            });
          }

          // ---------------- 监控页 ----------------
          function renderMonitor() {
            const statusDiv = document.createElement("div");
            statusDiv.className = "rmtb-status " + (GLOBAL_STATE.isMonitoring ? "success" : "");
            statusDiv.textContent = GLOBAL_STATE.isMonitoring ? "✅ 监控运行中" : "未监控";
            root.appendChild(statusDiv);

            const toggleBtn = document.createElement("button");
            toggleBtn.className = "rmtb-btn " + (GLOBAL_STATE.isMonitoring ? "danger" : "primary");
            toggleBtn.style.width = "100%";
            toggleBtn.style.margin = "10px 0";
            toggleBtn.textContent = GLOBAL_STATE.isMonitoring ? "停止监控" : "启动监控";
            toggleBtn.onclick = () => {
              if (GLOBAL_STATE.isMonitoring) stopMonitor();
              else {
                if (!GLOBAL_STATE.monitorConvIds.length) {
                  roche.ui.toast("请先勾选要监控的会话");
                  return;
                }
                startMonitor();
              }
              render();
            };
            root.appendChild(toggleBtn);

            const listLabel = document.createElement("div");
            listLabel.className = "rmtb-label";
            listLabel.style.marginTop = "12px";
            listLabel.textContent = "选择要监控的会话";
            root.appendChild(listLabel);

            if (!state.conversations.length) {
              const empty = document.createElement("div");
              empty.className = "rmtb-empty";
              empty.textContent = "没有可选的会话";
              root.appendChild(empty);
            }

            state.conversations.forEach((c) => {
              const row = document.createElement("div");
              row.className = "rmtb-conv-row";
              const label = c.name || c.title || c.handle || c.id;
              row.innerHTML = `<div>${escapeHtml(label)}${c.isGroup ? " (群聊)" : ""}</div>`;
              const switchLabel = document.createElement("label");
              switchLabel.className = "rmtb-switch";
              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.checked = GLOBAL_STATE.monitorConvIds.includes(c.id);
              checkbox.onchange = async (e) => {
                const set = new Set(GLOBAL_STATE.monitorConvIds);
                if (e.target.checked) set.add(c.id);
                else set.delete(c.id);
                GLOBAL_STATE.monitorConvIds = Array.from(set);
                await saveMonitorConvIds(roche, GLOBAL_STATE.monitorConvIds);
              };
              const slider = document.createElement("span");
              slider.className = "rmtb-slider";
              switchLabel.appendChild(checkbox);
              switchLabel.appendChild(slider);
              row.appendChild(switchLabel);
              root.appendChild(row);
            });

            const logLabel = document.createElement("div");
            logLabel.className = "rmtb-label";
            logLabel.style.marginTop = "16px";
            logLabel.textContent = "运行日志";
            root.appendChild(logLabel);

            const logPre = document.createElement("pre");
            logPre.className = "rmtb-log";
            logPre.textContent = GLOBAL_STATE.logLines.join("\n");
            root.appendChild(logPre);

            GLOBAL_STATE.onLogChange = (text) => { logPre.textContent = text; };
            GLOBAL_STATE.onMonitorStatusChange = () => render();
          }

          function render() {
            root.innerHTML = "";
            renderTopNav();
            if (state.view === "list") renderList();
            else if (state.view === "edit") renderEdit();
            else renderMonitor();
          }

          render();
          container.__rmtbCleanup = () => style.remove();
        },

        async unmount(container) {
          // 只清理 UI 相关回调和 DOM,不停止后台监控(后台常驻)
          GLOBAL_STATE.onLogChange = null;
          GLOBAL_STATE.onMonitorStatusChange = null;
          if (container.__rmtbCleanup) container.__rmtbCleanup();
          container.replaceChildren();
        },
      },
    ],
  });

  // 调试接口
  window.__mcpToolBridge = {
    state: GLOBAL_STATE,
    parseToolCalls,
    buildSystemPrompt,
    startMonitor,
    stopMonitor,
    testAndListTools,
    callServerTool,
  };
})();
