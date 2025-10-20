from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import json

app = FastAPI()

# serve static files from ./static
app.mount("/static", StaticFiles(directory="static"), name="static")

connected_clients = []

@app.get("/ping")
async def ping():
    return {"status": "ok"}

@app.websocket("/ws/realtime")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    print("WebSocket connected")
    try:
        while True:
            try:
                message = await websocket.receive_text()
            except Exception as e:
                print("Error receiving message from client:", e)
                break

            # log raw received (trim if very long)
            raw_preview = message if len(message) < 500 else message[:500] + "..."
            print("Received raw:", raw_preview)

            try:
                data = json.loads(message)
            except Exception as e:
                print("JSON parse error:", e)
                continue

            topic = data.get("topic")
            payload = data.get("data")

            # broadcast to all connected clients (including the sender is fine)
            remove_list = []
            for client in connected_clients:
                try:
                    await client.send_text(json.dumps({"topic": topic, "data": payload}))
                except Exception as e:
                    print("Failed to send to client:", e)
                    remove_list.append(client)
            for c in remove_list:
                try:
                    connected_clients.remove(c)
                except ValueError:
                    pass

    except WebSocketDisconnect:
        print("WebSocket disconnected")
    finally:
        try:
            connected_clients.remove(websocket)
        except ValueError:
            pass
        print("Connection closed")
