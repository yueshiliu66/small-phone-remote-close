from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
import httpx
import os
import urllib.parse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BARK_KEY    = os.getenv("BARK_KEY", "")
BARK_SERVER = os.getenv("BARK_SERVER", "https://api.day.app")

# ============================================================
# 预设场景（想加新场景直接在这里加一行）
# ============================================================
SCENES = {
    "睡前":  {"app": "健康",    "title": "🌙 睡前模式", "body": "准备休息了"},
    "专注":  {"app": "备忘录",  "title": "🎯 专注模式", "body": "保持专注"},
    "回桌面":{"app": "时钟",    "title": "🏠 回桌面",   "body": "返回主界面"},
}


# ============================================================
# 核心推送函数
# ============================================================
async def push_shortcut(
    shortcut_name: str,
    input_text: str = "",
    title: str = "📱 远程指令",
    body: str = "",
):
    if not BARK_KEY:
        raise ValueError("未配置 BARK_KEY 环境变量")

    shortcut_url = f"shortcuts://run-shortcut?name={urllib.parse.quote(shortcut_name)}"
    if input_text:
        shortcut_url += f"&input={urllib.parse.quote(input_text)}"

    payload = {
        "device_key": BARK_KEY,
        "title": title,
        "body": body or input_text or shortcut_name,
        "url": shortcut_url,
        "sound": "minuet",
        "level": "active",
    }

    async with httpx.AsyncClient(timeout=10.0) as c:
        resp = await c.post(f"{BARK_SERVER}/push", json=payload)
        resp.raise_for_status()


# ============================================================
# ① MCP 端点（plugin.js 对接）
# ============================================================
@app.post("/mcp")
async def mcp_endpoint(request: Request):
    body = await request.json()
    method = body.get("method")
    req_id = body.get("id")

    # MCP 握手
    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "scene-mcp", "version": "1.0.0"}
            }
        }

    # 返回工具列表
    if method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "go_scene",
                        "description": "切换手机场景，跳转到对应App。当对话涉及睡觉、专注、运动、娱乐等状态时主动调用。",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "scene": {
                                    "type": "string",
                                    "description": "场景名称，可选值：睡前、专注、娱乐、回桌面、运动"
                                }
                            },
                            "required": ["scene"]
                        }
                    }
                ]
            }
        }

    # 工具调用
    if method == "tools/call":
        tool_name = body.get("params", {}).get("name")
        args = body.get("params", {}).get("arguments", {})

        if tool_name == "go_scene":
            scene_name = args.get("scene", "")
            scene = SCENES.get(scene_name)

            if not scene:
                return {
                    "jsonrpc": "2.0", "id": req_id,
                    "result": {
                        "content": [{"type": "text",
                                     "text": f"没有「{scene_name}」这个场景，可用的有：{list(SCENES.keys())}"}],
                        "isError": False
                    }
                }

            # 立刻推送，立刻返回，不挂起等待
            try:
                await push_shortcut(
                    shortcut_name="跳转App",
                    input_text=scene["app"],
                    title=scene["title"],
                    body=scene["body"],
                )
                msg = f"✅ 已触发「{scene_name}」场景，正在跳转到 {scene['app']}"
            except Exception as e:
                msg = f"⚠️ 推送失败：{str(e)}"

            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": msg}],
                    "isError": False
                }
            }

        return {
            "jsonrpc": "2.0", "id": req_id,
            "error": {"code": -32601, "message": f"未知工具: {tool_name}"}
        }

    return {
        "jsonrpc": "2.0", "id": req_id,
        "error": {"code": -32601, "message": f"未知方法: {method}"}
    }


# ============================================================
# ② 直接触发预设场景（不经过MCP，备用）
#    GET /scene/睡前
# ============================================================
@app.get("/scene/{name}")
async def trigger_scene(name: str):
    scene = SCENES.get(name)
    if not scene:
        return {"status": "error", "message": f"可用场景：{list(SCENES.keys())}"}

    try:
        await push_shortcut(
            shortcut_name="跳转App",
            input_text=scene["app"],
            title=scene["title"],
            body=scene["body"],
        )
        return {"status": "ok", "scene": name, "jumping_to": scene["app"]}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============================================================
# ③ 跳转任意App（动态指定）
#    POST /open_app  body: {"app": "微信"}
# ============================================================
@app.post("/open_app")
async def open_app(request: Request):
    body = await request.json()
    app_name = body.get("app", "").strip()
    if not app_name:
        return {"status": "error", "message": "请传 app 字段"}

    try:
        await push_shortcut(
            shortcut_name="跳转App",
            input_text=app_name,
            title="📱 打开App",
            body=f"→ {app_name}",
        )
        return {"status": "ok", "jumping_to": app_name}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============================================================
# ④ 健康检查 / 查看可用场景
# ============================================================
@app.get("/")
async def health():
    return {"status": "running", "scenes": list(SCENES.keys())}
