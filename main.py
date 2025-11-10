from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import asyncio, time, roslibpy, base64, json
import numpy as np
import math
import time

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

ROSBRIDGE_IP = "192.168.0.100"
ros = roslibpy.Ros(host=ROSBRIDGE_IP, port=9090)
ros.run()

print("⏳ ROSBridge 연결 중...")
while not ros.is_connected:
    time.sleep(1)
print("✅ ROSBridge 연결 성공!")

# FastAPI 메인 루프 선언
main_loop = asyncio.get_event_loop()

latest_state = {"text": "대기 중"}

# ============================================
# ✅ ROS Subscriptions
# ============================================
amcl_topic = roslibpy.Topic(ros, "/amcl_pose", "geometry_msgs/PoseWithCovarianceStamped")
map_topic  = roslibpy.Topic(ros, "/map", "nav_msgs/OccupancyGrid")
batt_topic = roslibpy.Topic(ros, "/battery_state", "sensor_msgs/msg/BatteryState")

latest_amcl, latest_map, latest_batt, prev_amcl_pos = None, None, None, None
total_distance = 0.0 # 누적 이동 거리
start_time = None # 순찰 시작 시간 (초기엔 None)


def amcl_callback(msg):
    global latest_amcl, prev_amcl_pos, total_distance
    latest_amcl = msg

    pos = msg["pose"]["pose"]["position"]
    x, y = pos["x"], pos["y"]

    # 이전 좌표와 비교해 거리 누적
    if prev_amcl_pos is not None:
        dx = x - prev_amcl_pos["x"]
        dy = y - prev_amcl_pos["y"]
        dist = math.sqrt(dx**2 + dy**2)
        # 너무 작은 노이즈(로봇 흔들림)는 무시
        if dist > 0.001:
            total_distance += dist

    prev_amcl_pos = {"x": x, "y": y}

def map_callback(msg):   # OccupancyGrid
    global latest_map
    latest_map = msg

def batt_callback(msg):  # BatteryState
    global latest_batt
    latest_batt = msg

amcl_topic.subscribe(amcl_callback)
map_topic.subscribe(map_callback)
batt_topic.subscribe(batt_callback)

# ============================================
# ✅ /cmd_vel 퍼블리셔 & 서브스크라이버
# ============================================
cmdvel_pub = roslibpy.Topic(ros, "/cmd_vel", "geometry_msgs/Twist")   # 🔸 추가됨
cmdvel_sub = roslibpy.Topic(ros, "/cmd_vel", "geometry_msgs/Twist")

# ✅ 메인 루프 버전만 유지
def cmdvel_callback(msg):
    global latest_state, main_loop
    lin = msg["linear"]["x"]
    ang = msg["angular"]["z"]

    if abs(lin) < 0.01 and abs(ang) < 0.01:
        new_state = "정지"
    elif abs(lin) > abs(ang):
        new_state = "전진중" if lin > 0 else "후진중"
    else:
        new_state = "회전중"

    if latest_state["text"] != new_state:
        latest_state["text"] = new_state
        for c in clients:
            try:
                asyncio.run_coroutine_threadsafe(
                    c.send_json({"type": "state", "text": new_state}),
                    main_loop
                )
            except Exception as e:
                print("⚠️ 상태 전송 실패:", e)

cmdvel_sub.subscribe(cmdvel_callback)

# ============================================
# ✅ /patrol 명령 퍼블리셔
# ============================================
patrol_pub = roslibpy.Topic(ros, "/patrol/cmd", "std_msgs/String")

# ============================================
# ✅ WebSocket 통신
# ============================================
clients = []

async def broadcast(data: dict):
    """모든 클라이언트에 브로드캐스트"""
    dead = []
    for ws in clients:
        try:
            await ws.send_json(data)
        except:
            dead.append(ws)
    for d in dead:
        if d in clients:
            clients.remove(d)

@app.websocket("/ws/realtime")
async def websocket_endpoint(websocket: WebSocket):
    global total_distance, start_time
    await websocket.accept()
    clients.append(websocket)
    print(f"✅ 클라이언트 연결됨 (총 {len(clients)}명)")

    try:
        while True:
            # ---------------------------
            # 1️⃣ 클라이언트 → ROS 명령
            # ---------------------------
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=0.01)
                data = json.loads(msg)
                t = data.get("type")

                # 순찰 명령
                if t == "patrol":
                    action = data.get("action")
                    if action == "single":
                        patrol_pub.publish(roslibpy.Message({"data": "start_once"}))
                        latest_state["text"] = "1회 순찰 중"
                        start_time = time.time() # 순찰 시작 시간 기록
                        total_distance = 0.0 # 거리 초기화
                    elif action == "repeat":
                        patrol_pub.publish(roslibpy.Message({"data": "start_repeat"}))
                        latest_state["text"] = "반복 순찰 중"
                        start_time = time.time() # 순찰 시작 시간 기록
                        total_distance = 0.0
                    elif action == "return":
                        patrol_pub.publish(roslibpy.Message({"data": "return"}))
                        latest_state["text"] = "복귀 중"
                        start_time = None # 시간 멈춤
                    elif action == "stop":
                        patrol_pub.publish(roslibpy.Message({"data": "stop"}))
                        latest_state["text"] = "정지"
                        start_time = None # 시간 멈춤
                        cmdvel_pub.publish(roslibpy.Message({
                            "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
                            "angular": {"x": 0.0, "y": 0.0, "z": 0.0}
                        }))
                    await broadcast({"type": "state", "text": latest_state["text"]})

                # 수동 조작
                elif t == "cmd_vel":
                    lin = float(data.get("linear", 0.0))
                    ang = float(data.get("angular", 0.0))
                    twist = {
                        "linear": {"x": lin, "y": 0.0, "z": 0.0},
                        "angular": {"x": 0.0, "y": 0.0, "z": ang}
                    }
                    cmdvel_pub.publish(roslibpy.Message(twist))

            except asyncio.TimeoutError:
                pass

            # ---------------------------
            # 2️⃣ ROS → 클라이언트 데이터
            # ---------------------------
            await asyncio.sleep(0.2)

            # AMCL
            if latest_amcl:
                pos = latest_amcl["pose"]["pose"]["position"]
                ori = latest_amcl["pose"]["pose"]["orientation"]
                siny_cosp = 2 * (ori["w"] * ori["z"] + ori["x"] * ori["y"])
                cosy_cosp = 1 - 2 * (ori["y"] ** 2 + ori["z"] ** 2)
                yaw = math.atan2(siny_cosp, cosy_cosp)
                await websocket.send_json({
                    "type": "amcl_pose",
                    "x": pos["x"],
                    "y": pos["y"],
                    "yaw": yaw
                })

                await websocket.send_json({
                    "type": "distance",
                    "meters": round(total_distance, 2)
                })

            else:
                await websocket.send_json({
                    "type": "time",
                    "minutes": 0.0
                })

            # 배터리
            if latest_batt:
                p = latest_batt.get("percentage", 0)
                if p <= 1: p *= 100
                await websocket.send_json({
                    "type": "battery",
                    "percentage": int(round(p, 1))
                })

            # 지도
            if latest_map:
                info = latest_map["info"]
                data = latest_map["data"]
                width, height = info["width"], info["height"]
                res = info["resolution"]
                origin = info["origin"]["position"]

                arr = np.array(data, dtype=np.int8).reshape(height, width)
                arr = np.flipud(arr)
                gray = np.zeros_like(arr, dtype=np.uint8)
                gray[arr == -1] = 205
                gray[arr == 0] = 255
                gray[arr > 0] = 0

                await websocket.send_json({
                    "type": "map",
                    "width": width,
                    "height": height,
                    "res": res,
                    "origin": {"x": origin["x"], "y": origin["y"]},
                    "gray": gray.flatten().tolist()
                })

            # 상태
            await websocket.send_json({
                "type": "state",
                "text": latest_state["text"]
            })

    except WebSocketDisconnect:
        print("❌ 클라이언트 연결 종료")
    finally:
        if websocket in clients:
            clients.remove(websocket)

@app.on_event("shutdown")
def shutdown_event():
    amcl_topic.unsubscribe()
    batt_topic.unsubscribe()
    map_topic.unsubscribe()
    cmdvel_sub.unsubscribe()
    cmdvel_pub.unadvertise()
    patrol_pub.unadvertise()
    ros.terminate()
    print("🛑 ROSBridge 연결 종료")
