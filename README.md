## Raspberry Pi <-> FastAPI Server <-> Web 연결

## 개발 타임라인 (주호)

<details>
<summary>10.14일</summary>
  
### 1단계: 기본 서버 실행
- `main.py` 초기 구현
- FastAPI 서버 띄우고 WebSocket 연결 확인
- Web 브라우저에서 `/static/dashboard.html` 접속 시 "Waiting for /map data..." 표시
- 핵심 포인트:
  - `/ping` GET 확인 가능
  - WebSocket 연결 성공 (`WebSocket connected` 로그)

### 2단계: `/map` 토픽 데이터 수신
- 라즈베리파이 `map_sender.py` 작성
- `/map` 토픽 구독 및 WebSocket 송신
- 서버 로그에서 수신 확인 (`Received raw: { ... }`)
- `dashboard.html`에서 맵 정보 표시:
  - 가로, 세로 (m)
  - 총 면적 (m²)
  - 탐지율 (%)
  - 해상도 (m)
  - 원점 좌표
  - 데이터 예시 일부 표시
- 데이터 처리:
  - `-1`: 미탐지 구역
  - `0`: 탐지 구역
  - `100`: 벽
 
  <img width="937" height="335" alt="image" src="https://github.com/user-attachments/assets/39ccea26-a677-465a-aebf-4acb579ec67a" />


### 3단계: `/battery_state` 토픽 시도
- 라즈베리파이 `battery_sender.py` 작성
- 문제:
  - 콜백이 너무 빠르게 호출됨 (0.1초 간격)
  - 웹에서 실시간 표시 어려움
- 임시 보류, 이후 재구현 계획

### 4단계: `dashboard.html` 개선
- 한글 표시 적용
- `map` 토픽 데이터:
  - 실시간 가로, 세로, 총 면적, 탐지율 계산
- `battery_state` 토픽 placeholder 생성
- 스타일 적용 (폰트, 박스, pre 태그)

---
## 파일 구조
```
Server/  
├─ main.py # FastAPI + WebSocket 서버  
├─ static/  
│ └─ dashboard.html # 대시보드 HTML  
ros2_publishers/  
├─ map_sender.py # /map 토픽 송신  
├─ battery_sender.py # /battery_state 토픽 송신  
```

---

## main.py 설명

```
python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
import json

app = FastAPI()

# /static 경로로 HTML 제공
app.mount("/static", StaticFiles(directory="static"), name="static")

connected_clients = []

@app.get("/ping")
async def ping():
    return {"status": "ok"}

@app.websocket("/ws/realtime")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)
            topic = data.get("topic")
            payload = data.get("data")

            # 모든 클라이언트에 브로드캐스트
            remove_list = []
            for client in connected_clients:
                try:
                    await client.send_text(json.dumps({"topic": topic, "data": payload}))
                except:
                    remove_list.append(client)
            for c in remove_list:
                connected_clients.remove(c)
    except WebSocketDisconnect:
        connected_clients.remove(websocket)
```

</details>
