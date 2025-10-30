from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import json
from PIL import Image

app = FastAPI()

# --- CORS 허용 ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Static files ---
app.mount("/static", StaticFiles(directory="static"), name="static")

connected_clients = []
map_info = None
map_path = "static/save_4.png"  # 실제 맵 이미지 경로


# === 변환 함수 ===
def transform_to_pixel(pose, map_info, map_image_path):
    img = Image.open(map_image_path)
    width, height = img.size

    resolution = map_info.get("resolution", 0.05)
    origin_x, origin_y, _ = map_info.get("origin", [0.0, 0.0, 0.0])

    x = pose.get("x", 0.0)
    y = pose.get("y", 0.0)

    # ROS 좌표 → 이미지 좌표 변환
    px = (x - origin_x) / resolution
    py = height - ((y - origin_y) / resolution)

    # 범위 제한
    px = max(0, min(width, px))
    py = max(0, min(height, py))
    return int(px), int(py)


@app.get("/ping")
async def ping():
    return {"status": "ok"}


# === WebSocket 메인 ===
@app.websocket("/ws/realtime")
async def websocket_endpoint(websocket: WebSocket):
    global map_info
    await websocket.accept()
    connected_clients.append(websocket)
    print("✅ WebSocket connected")

    try:
        while True:
            try:
                message = await websocket.receive_text()
            except Exception as e:
                print("Error receiving message from client:", e)
                break

            # 1️⃣ JSON 데이터인 경우
            try:
                data = json.loads(message)

                # (1) YAML 정보 수신
                if data.get("type") == "map_yaml":
                    map_info = data["data"]
                    print("📡 Received map YAML info:", map_info)

                # (2) 로봇 좌표 수신 + 변환
                elif data.get("type") == "robot_pose" and map_info:
                    px, py = transform_to_pixel(data["data"], map_info, map_path)
                    print(f"🧭 Robot pixel position: ({px}, {py})")

                    # 브라우저로 전송
                    robot_pixel_msg = json.dumps({
                        "topic": "robot_pixel",
                        "data": {"px": px, "py": py}
                    })

                    # 연결된 모든 클라이언트에게 전송
                    for client in connected_clients:
                        try:
                            await client.send_text(robot_pixel_msg)
                        except Exception as e:
                            print("Failed to send to client:", e)
                            connected_clients.remove(client)

                # (3) 그 외 일반 JSON 데이터 (odom, tf 등)
                else:
                    outgoing = json.dumps(data)
                    for client in connected_clients:
                        try:
                            await client.send_text(outgoing)
                        except Exception as e:
                            print("Failed to send to client:", e)
                            connected_clients.remove(client)

            # 2️⃣ JSON 파싱 실패 → Base64 이미지(map) 같은 순수 문자열
            except json.JSONDecodeError:
                outgoing = message
                for client in connected_clients:
                    try:
                        await client.send_text(outgoing)
                    except Exception as e:
                        print("Failed to send to client:", e)
                        connected_clients.remove(client)

    except WebSocketDisconnect:
        print("❌ WebSocket disconnected")

    finally:
        if websocket in connected_clients:
            connected_clients.remove(websocket)
        print("🔌 Connection closed")
