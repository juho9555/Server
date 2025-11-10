console.log("main.js loaded successfully");

// 연결 설정 (IP 바꿔)
const WS_HOST = '192.168.0.57';   // FastAPI 서버 IP (본인 PC)
const WS_PORT = 8000;
const WS_URL  = `ws://${WS_HOST}:${WS_PORT}/ws/realtime`; // ✅ 경로 변경

const CAM_HOST = '192.168.0.100'; // Raspberry Pi (web_video_server)
const MJPEG_STREAM_URL = `http://${CAM_HOST}:8080/stream?topic=/image_raw&type=ros_compressed&width=640&height=480&quality=50`;

// DOM 캐시 & 상태
const statusIndicator = document.getElementById('status-indicator');
const statusText      = document.getElementById('status-text');
const robotStatusEl   = document.getElementById('metric-status');

const mapMain   = document.getElementById('map-main');
const videoMain = document.getElementById('video-main');
const mapSmall  = document.getElementById('map-small');
const videoSmall= document.getElementById('video-small');

const webcamFeed      = document.getElementById('webcam-feed');
const webcamSmallFeed = document.getElementById('webcam-small-feed');

const patrolControlMap   = document.getElementById('patrol-control-map');
const robotLocationCard  = document.getElementById('robot-location-card');
const manualControl      = document.getElementById('manual-control');

const elBatt = document.getElementById('metric-battery');
const elDist = document.getElementById('metric-distance');
const elTime = document.getElementById('metric-time');
const elTemp = document.getElementById('metric-temp');
const elGas  = document.getElementById('metric-gas');
const elTvoc = document.getElementById('metric-tvoc');

const mapCanvas = document.getElementById('map-canvas');
const mapCtx = mapCanvas.getContext('2d', { willReadFrequently:true });
const mapPlaceholder = document.getElementById('map-placeholder');
const robotLocation = document.getElementById('robot-location');

const statusConfigs = {
  '순찰중':   { class: 'bg-green-200 text-green-800',   icon: 'fas fa-route' },
  '복귀중':   { class: 'bg-indigo-200 text-indigo-800', icon: 'fas fa-home' },
  '충전중':   { class: 'bg-blue-200 text-blue-800',     icon: 'fas fa-charging-station' },
  '정지':     { class: 'bg-red-200 text-red-800',       icon: 'fas fa-stop-circle' },
  '임무완료': { class: 'bg-teal-200 text-teal-800',     icon: 'fas fa-check-circle' },
  '대기 중':  { class: 'bg-gray-200 text-gray-800',     icon: 'fas fa-ellipsis-h' },
  '연결 오류': { class: 'bg-red-200 text-red-800',       icon: 'fas fa-exclamation-triangle' },
  '연결 끊김': { class: 'bg-yellow-200 text-yellow-800', icon: 'fas fa-plug' }
};

function updateRobotStatus(key){
  const cfg = statusConfigs[key] || statusConfigs['대기 중'];
  robotStatusEl.innerHTML = `<i class="${cfg.icon} mr-3"></i> ${key}`;
  robotStatusEl.className = 'status-badge ' + cfg.class;
}

// WebSocket
let ws = null, isConnected = false;
let isVideoRunning = false;
let currentMainView = 'map';

let mapMeta = { w:0, h:0, res:0.05, ox:0, oy:0 };
let lastMapImage = null;
let robotPose = { x:null, y:null, yaw:0 };
let lastAmclTime = 0;
const AMCL_TIMEOUT = 2000;
let accumDist = 0, startTime = Date.now();
let mapBuffer = null;
let mapBufferCtx = null;

function connectWS(){
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    isConnected = true;
    statusIndicator.classList.replace('bg-red-500','bg-green-500');
    statusText.textContent = 'ROS 연결됨';
    statusText.classList.replace('text-red-700','text-green-700');
    updateRobotStatus('대기 중');
  };

  ws.onerror = () => {
    statusIndicator.classList.replace('bg-green-500','bg-red-500');
    statusText.textContent = 'ROS 오류 발생';
    statusText.classList.replace('text-green-700','text-red-700');
    updateRobotStatus('연결 오류');
  };

  ws.onclose = () => {
    isConnected = false;
    statusIndicator.classList.replace('bg-green-500','bg-yellow-500');
    statusText.textContent = 'ROS 연결 끊김';
    statusText.classList.replace('text-green-700','text-yellow-700');
    updateRobotStatus('연결 끊김');
    setTimeout(connectWS, 1500);
  };

  ws.onmessage = (ev) => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch(e){ return; }
    handleMessage(m);
  };
}

function handleMessage(m){
  switch(m.type.trim()){
    case 'map':       drawMap(m); break;
    case 'amcl_pose': onPose(m);  break;
    case 'distance':
      if (m.meters != null)
        elDist.textContent = `${m.meters.toFixed(2)} m`;
      break;
    case 'time':
      if (m.minutes != null)
        elTime.textContent = `${m.minutes.toFixed(1)} min`;
      break
    case 'battery':
      if (m.percentage != null) elBatt.textContent = `${m.percentage}%`;
      break;
    case 'state':
      if (m.text) updateRobotStatus(m.text);
      break;
    default: break;
  }
}

function onPose(m){
  robotPose.x = m.x; robotPose.y = m.y; robotPose.yaw = m.yaw || 0;
  const xf = (typeof m.x === 'number') ? m.x.toFixed(2) : m.x;
  const yf = (typeof m.y === 'number') ? m.y.toFixed(2) : m.y;
  robotLocation.textContent = `X=${xf} m, Y=${yf} m`;
  drawRobot();
  lastAmclTime = Date.now();
}

function worldToPixel(x, y) {
  // 맵의 원본 좌표 → 픽셀 좌표 (추가 회전 없이)
  const px = (x - mapMeta.ox) / mapMeta.res;
  const py = mapMeta.h - (y - mapMeta.oy) / mapMeta.res; // y축 반전만 적용
  return { x: px, y: py };
}


function drawMap(m){
  const w = m.width, h = m.height, gray = m.gray;
  if (!Array.isArray(gray) || gray.length !== w*h) return;

  // 오프스크린 버퍼 준비
  if (!mapBuffer) {
    mapBuffer = document.createElement('canvas');
    mapBufferCtx = mapBuffer.getContext('2d');
  }
  if (mapBuffer.width !== w || mapBuffer.height !== h) {
    mapBuffer.width = w;
    mapBuffer.height = h;
  }

  // ImageData 작성
  const imgData = new ImageData(w, h);
  for (let i=0, j=0; i<gray.length; i++, j+=4){
    const g = gray[i] | 0;
    imgData.data[j]   = g;
    imgData.data[j+1] = g;
    imgData.data[j+2] = g;
    imgData.data[j+3] = 255;
  }
  mapBufferCtx.putImageData(imgData, 0, 0);

  // 메타 업데이트 (로봇 좌표 변환용)
  mapMeta = { 
    w, h, 
    res: m.res ?? mapMeta.res, 
    ox: m.origin?.x ?? 0, 
    oy: m.origin?.y ?? 0 
  };

  drawRobot();
}

// === 화면에 비율 유지해서 ‘가운데’ 그리기 ===
let drawRobot = function(){
  if (!mapBuffer) return;

  // 캔버스 실제 픽셀 크기를 ‘보이는 크기’로 맞춤
  const viewW = mapCanvas.clientWidth;
  const viewH = mapCanvas.clientHeight;
  if (mapCanvas.width !== viewW || mapCanvas.height !== viewH) {
    mapCanvas.width = viewW;
    mapCanvas.height = viewH;
  }

  // 비율 유지 스케일 + 중앙 오프셋 계산
  const scale = Math.min(viewW / mapMeta.w, viewH / mapMeta.h);
  const offX  = Math.floor((viewW - mapMeta.w * scale) / 2);
  const offY  = Math.floor((viewH - mapMeta.h * scale) / 2);

  // 지우고 변환 적용
  // ✅ drawRobot 수정 버전
mapCtx.setTransform(1,0,0,1,0,0);
mapCtx.clearRect(0, 0, viewW, viewH);
mapCtx.setTransform(scale, 0, 0, scale, offX, offY);

mapCtx.save();
mapCtx.translate(mapMeta.w / 2, mapMeta.h / 2);
mapCtx.rotate(-Math.PI / 2); // 시계 방향으로 90도 회전 (맵 정렬)
mapCtx.translate(-mapMeta.w / 2, -mapMeta.h / 2);

// --- 맵 그리기 ---
mapCtx.drawImage(mapBuffer, 0, 0);

// ✅ 로봇 아이콘 (원형)
if (robotPose.x != null) {
  const p = worldToPixel(robotPose.x, robotPose.y);
  const size = 5; // 원 크기 (px)

  mapCtx.save();
  mapCtx.translate(p.x, p.y);
  mapCtx.fillStyle = '#ef4444'; // 빨간색
  mapCtx.beginPath();
  mapCtx.arc(0, 0, size, 0, 2 * Math.PI); // 중심 (0,0), 반지름 size
  mapCtx.fill();
  mapCtx.lineWidth = 2;
  mapCtx.strokeStyle = 'white';
  mapCtx.stroke();
  mapCtx.restore();
}

mapCtx.restore(); // transform 초기화
  
};
// 뷰 토글 & 웹캠
window.toggleMainView = function(view){
  if (view === currentMainView) return;

  if (view === 'map') {
    mapMain.classList.remove('hidden');
    videoMain.classList.add('hidden');
    mapSmall.classList.add('hidden');
    videoSmall.classList.remove('hidden');
    patrolControlMap.classList.remove('hidden');
    robotLocationCard.classList.remove('hidden');
    manualControl.classList.add('hidden');
    currentMainView = 'map';
  } else if (view === 'video') {
    videoMain.classList.remove('hidden');
    mapMain.classList.add('hidden');
    videoSmall.classList.add('hidden');
    mapSmall.classList.remove('hidden');   // ✅ 이거는 그대로 둬
    manualControl.classList.remove('hidden');
    patrolControlMap.classList.add('hidden');
    robotLocationCard.classList.add('hidden');
    currentMainView = 'video';
    if (!isVideoRunning) toggleVideoFeed(true);
  }
};

document.getElementById('map-small').addEventListener('click', () => {
  toggleMainView('map');
});


window.toggleVideoFeed = function(forceStart){
  const newState = (typeof forceStart === 'boolean') ? forceStart : !isVideoRunning;
  const button = document.querySelector('.btn-action[onclick="toggleVideoFeed()"]');
  if (newState) {
    webcamFeed.src = MJPEG_STREAM_URL;
    webcamSmallFeed.src = MJPEG_STREAM_URL;
    document.getElementById('video-placeholder')?.classList.add('hidden');
    if (button){
      button.innerHTML = '<i class="fas fa-camera-slash mr-2"></i> 웹캠 스트리밍 중지';
      button.classList.replace('bg-blue-500','bg-red-500');
      button.classList.replace('hover:bg-blue-600','hover:bg-red-600');
    }
    isVideoRunning = true;
  } else {
    webcamFeed.src = '';
    webcamSmallFeed.src = '';
    document.getElementById('video-placeholder')?.classList.remove('hidden');
    if (button){
      button.innerHTML = '<i class="fas fa-camera mr-2"></i> 웹캠 스트리밍 시작';
      button.classList.replace('bg-red-500','bg-blue-500');
      button.classList.replace('hover:bg-red-600','hover:bg-blue-600');
    }
    isVideoRunning = false;
  }
};

// 제어 명령 (WS 프로토콜)
function wsSend(obj){ if(isConnected) ws.send(JSON.stringify(obj)); }

window.publishCommand = function(command){
  if (!isConnected) return;
  if (currentMainView !== 'video' && command !== 'stop' && command !== 'manual_stop'){
    customAlert('수동 제어(방향키)는 웹캠 모드에서만 가능합니다.');
    return;
  }
  const speed = 0.4, turn = 0.8;
  let lin=0, ang=0;
  switch(command){
    case 'forward':  lin= speed; break;
    case 'backward': lin=-speed; break;
    case 'left':     ang= turn;  break;
    case 'right':    ang=-turn;  break;
    case 'stop':
      updateRobotStatus('정지');
      wsSend({type:'cmd_vel', linear:0.0, angular:0.0});
      return;
    default: break;
  }
  wsSend({type:'cmd_vel', linear:lin, angular:ang});
};

window.publishMission = function(missionType){
  if (!isConnected){ customAlert('ROS 서버에 연결되어야 미션 명령을 보낼 수 있습니다.'); return; }
  let newStatus = '';
  if (missionType === 'return'){ newStatus='복귀중'; wsSend({type:'patrol', action:'return'}); }
  else if (missionType === 'repeat'){ newStatus='순찰중'; wsSend({type:'patrol', action:'repeat'}); }
  else if (missionType === 'single'){ newStatus='순찰중'; wsSend({type:'patrol', action:'single'}); }
  if (newStatus) updateRobotStatus(newStatus);
  customAlert(
    missionType==='return' ? '복귀 명령을 전송했습니다.' :
    missionType==='repeat' ? '반복 순찰을 시작합니다.' :
    '1회 순찰을 시작합니다.'
  );
};

// 커스텀 알림
window.customAlert = function(message){
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = `
    <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white p-6 rounded-xl shadow-2xl max-w-md w-full">
        <p class="text-xl font-bold text-blue-600 mb-4 flex items-center">
          <i class="fas fa-info-circle mr-2"></i> 시스템 알림
        </p>
        <p class="text-gray-700 mb-6">${message}</p>
        <button onclick="this.closest('.fixed').remove()" class="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg w-full transition">확인</button>
      </div>
    </div>`;
  document.body.appendChild(tempDiv);
};

// Init
window.onload = function(){
  connectWS();
  toggleMainView('map');
  toggleVideoFeed(false);
};
