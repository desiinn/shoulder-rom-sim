/**
 * ============================================================
 * shoulder-rom-app / script.js
 * 工業試験場 — 肩可動域チェッカー MVP
 *
 * 概要:
 * MediaPipe Pose を使いWebカメラ映像からリアルタイムに
 * 左右肩の挙上角度を計算・表示し、制限角度超過を
 * 視覚的にフィードバックするプロトタイプ。
 *
 * 外部依存:
 * - @mediapipe/pose         (CDN)
 * - @mediapipe/camera_utils (CDN)
 * - @mediapipe/drawing_utils (CDN)
 * - Google Fonts: 'Courier New' (数値表示用)
 * * Copyright 2026 Google LLC.
    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
 * ============================================================
 */

'use strict';

/* ============================================================
   1. 設定定数・変数
============================================================ */

/** 肩挙上角度の制限値 [度]。ユーザーがUIから変更できるように let に変更 */
let LIMIT_ANGLE_DEG = 70;

/** キャンバスに描画する骨格線の色 */
const SKELETON_COLOR_NORMAL  = '#00d4ff'; // 通常時：シアン
const SKELETON_COLOR_WARNING = '#ff3d3d'; // 超過時：赤

/** 骨格の線幅 [px] */
const SKELETON_LINE_WIDTH = 3;

/** ランドマーク円の半径 [px] */
const LANDMARK_RADIUS = 7;

/** 音声アラートの有効/無効状態（ブラウザ仕様に基づき初期値はfalse） */
let IS_AUDIO_ENABLED = false;

/** Web Audio API インスタンス保持用 */
let audioCtx = null;

/** 警告音の発音インターバル管理用 */
let audioIntervalId = null;

/** 警告音発音中フラグ */
let isPlayingBeep = false;


/* ============================================================
   2. DOM 要素の取得
============================================================ */
const videoEl        = document.getElementById('input-video');
const canvasEl       = document.getElementById('output-canvas');
const ctx            = canvasEl.getContext('2d');

const alertOverlay   = document.getElementById('alert-overlay');
const alertBanner    = document.getElementById('alert-banner');
const loadingMsg     = document.getElementById('loading-msg');

const angleDisplayLeft  = document.getElementById('angle-display-left');
const angleDisplayRight = document.getElementById('angle-display-right');

const poseDot        = document.getElementById('pose-status-dot');
const poseStatusText = document.getElementById('pose-status-text');

const audioToggle    = document.getElementById('audio-toggle');

// UIコントロール要素
const limitSlider     = document.getElementById('limit-slider');
const limitInput      = document.getElementById('limit-input');


/* ============================================================
   3. 初期化処理
============================================================ */

/**
 * アプリのエントリーポイント。
 * DOM 読み込み完了後に自動実行される。
 */
function initApp() {
  // 制限角度UIのバインドと初期設定
  setupLimitControl();

  // 音声コントロールのバインドと初期設定
  setupAudioControl();

  // MediaPipe Pose のセットアップ
  const pose = setupMediaPipePose();

  // カメラの起動
  startCamera(videoEl, pose);
}

// DOM 読み込み完了後に実行
document.addEventListener('DOMContentLoaded', initApp);


/* ============================================================
   4. UIからの制限角度変更イベントの設定
============================================================ */
function setupLimitControl() {
  if (!limitSlider || !limitInput) return;

  /**
   * 制限角度が変更されたときにシステム全体に反映する共通関数
   * @param {number} newLimit - 新しい制限角度値
   */
  function updateLimitAngle(newLimit) {
    if (newLimit < 30) newLimit = 30;
    if (newLimit > 150) newLimit = 150;

    // 1. グローバル変数を更新
    LIMIT_ANGLE_DEG = newLimit;

    // 2. 入力フォームの値を同期
    limitSlider.value = newLimit;
    limitInput.value  = newLimit;
  }

  // スライダー変更イベント（操作中にリアルタイム反映）
  limitSlider.addEventListener('input', (e) => {
    updateLimitAngle(parseInt(e.target.value, 10));
  });

  // 数値入力ボックス変更イベント（確定時に反映）
  limitInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value, 10);
    if (isNaN(val)) val = 70;
    updateLimitAngle(val);
  });

  // 初期値を一度反映
  updateLimitAngle(LIMIT_ANGLE_DEG);
}


/* ============================================================
   4b. 音声コントロールのバインドと初期設定
============================================================ */
function setupAudioControl() {
  if (!audioToggle) return;

  // 初期状態を反映（チェックボックスはオフ）
  audioToggle.checked = IS_AUDIO_ENABLED;

  audioToggle.addEventListener('change', async (e) => {
    IS_AUDIO_ENABLED = e.target.checked;

    // ユーザーが有効化した瞬間に AudioContext を生成・再開（ブラウザ制限解除）
    if (IS_AUDIO_ENABLED) {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
    } else {
      // 無効化された場合は即座に音を止める
      stopAlertSound();
    }
  });
}


/* ============================================================
   5. MediaPipe Pose セットアップ
============================================================ */
function setupMediaPipePose() {
  const pose = new Pose({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
    },
  });

  pose.setOptions({
    modelComplexity:   1,
    smoothLandmarks:   true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence:  0.5,
  });

  pose.onResults(onPoseResults);
  return pose;
}


/* ============================================================
   6. カメラ起動
============================================================ */
function startCamera(videoElement, poseInstance) {
  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await poseInstance.send({ image: videoElement });
    },
    width:  640,
    height: 480,
    facingMode: 'user',
  });

  camera.start().catch((err) => {
    console.error('[Camera] 起動に失敗しました:', err);
    updateStatusUI('error');
  });
}


/* ============================================================
   7. MediaPipe Pose 結果コールバック（両腕対応版）
============================================================ */
function onPoseResults(results) {
  syncCanvasSize(results.image);

  ctx.save();
  ctx.translate(canvasEl.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);
  ctx.restore();

  if (results.poseLandmarks && results.poseLandmarks.length > 0) {
    hideLoadingMessage();

    const landmarks = extractTargetLandmarks(results.poseLandmarks);

    if (landmarks) {
      const angleLeft  = calculateShoulderAngle(landmarks, 'left');
      const angleRight = calculateShoulderAngle(landmarks, 'right');

      const maxAngle = Math.max(angleLeft, angleRight);
      const isOver = maxAngle > LIMIT_ANGLE_DEG;

      drawSkeleton(landmarks, isOver);
      drawAngleOnCanvas(landmarks.leftShoulder, angleLeft, angleLeft > LIMIT_ANGLE_DEG, 'left');
      drawAngleOnCanvas(landmarks.rightShoulder, angleRight, angleRight > LIMIT_ANGLE_DEG, 'right');

      onAngleUpdated(angleLeft, angleRight);
    } else {
      updateStatusUI('searching');
      onAngleUpdated(null, null);
    }
  } else {
    updateStatusUI('searching');
    onAngleUpdated(null, null);
  }
}


/* ============================================================
   8. ランドマーク座標の抽出
============================================================ */
function extractTargetLandmarks(landmarks) {
  const leftShoulder  = landmarks[11]; 
  const rightShoulder = landmarks[12]; 
  const leftElbow     = landmarks[13];
  const rightElbow    = landmarks[14]; 

  const VISIBILITY_THRESHOLD = 0.5;
  if (
    leftShoulder.visibility  < VISIBILITY_THRESHOLD ||
    rightShoulder.visibility < VISIBILITY_THRESHOLD ||
    leftElbow.visibility     < VISIBILITY_THRESHOLD ||
    rightElbow.visibility    < VISIBILITY_THRESHOLD
  ) {
    return null;
  }

  const w = canvasEl.width;
  const h_ = canvasEl.height;
  const flip = (x) => (1 - x) * w;

  return {
    leftShoulder:  { x: flip(leftShoulder.x),  y: leftShoulder.y * h_ },
    rightShoulder: { x: flip(rightShoulder.x), y: rightShoulder.y * h_ },
    leftElbow:     { x: flip(leftElbow.x),     y: leftElbow.y * h_ },
    rightElbow:    { x: flip(rightElbow.x),    y: rightElbow.y * h_ },
  };
}


/* ============================================================
   9. 肩挙上角度の計算
============================================================ */
function calculateShoulderAngle({ leftShoulder, rightShoulder, leftElbow, rightElbow }, side = 'right') {
  const elbow   = (side === 'left') ? leftElbow   : rightElbow;
  const shoulder = (side === 'left') ? leftShoulder : rightShoulder;

  const vecA = { x: 0, y: 1 };
  const vecB = {
    x: elbow.x - shoulder.x,
    y: elbow.y - shoulder.y,
  };

  const dot  = vecA.x * vecB.x + vecA.y * vecB.y;
  const magB = Math.hypot(vecB.x, vecB.y);

  if (magB === 0) return 0;

  const cosTheta = Math.max(-1, Math.min(1, dot / magB));
  const angleDeg = (Math.acos(cosTheta) * 180) / Math.PI;

  return Math.max(0, angleDeg);
}


/* ============================================================
   10. キャンバスへの描画
============================================================ */
function drawSkeleton({ leftShoulder, rightShoulder, leftElbow, rightElbow }, isOver) {
  const color = isOver ? SKELETON_COLOR_WARNING : SKELETON_COLOR_NORMAL;
  ctx.save();

  ctx.strokeStyle = color;
  ctx.lineWidth   = SKELETON_LINE_WIDTH;
  ctx.lineCap     = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur  = 8;

  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(leftShoulder.x, leftShoulder.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(rightElbow.x, rightElbow.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(leftShoulder.x, leftShoulder.y);
  ctx.lineTo(leftElbow.x, leftElbow.y);
  ctx.stroke();

  const points = [leftShoulder, rightShoulder, leftElbow, rightElbow];
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, LANDMARK_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  ctx.restore();
}

function drawAngleOnCanvas(shoulderPos, angleDeg, isOver, side = 'right') {
  const text  = `${Math.round(angleDeg)}°`;
  const color = isOver ? '#ff6b6b' : '#00d4ff';

  ctx.save();
  ctx.font         = 'bold 22px "Courier New", monospace';
  ctx.fillStyle    = color;
  ctx.shadowColor  = color;
  ctx.shadowBlur   = 10;
  ctx.textAlign    = (side === 'left') ? 'right' : 'left';
  ctx.textBaseline = 'bottom';

  const offsetX = (side === 'left') ? -14 : 14;
  const offsetY = -12;
  ctx.fillText(text, shoulderPos.x + offsetX, shoulderPos.y + offsetY);
  ctx.restore();
}


/* ============================================================
   11. 角度更新時のUI処理
============================================================ */
function onAngleUpdated(angleLeft, angleRight) {
  if (angleLeft === null || angleRight === null) {
    if (angleDisplayLeft)  angleDisplayLeft.textContent = '---';
    if (angleDisplayRight) angleDisplayRight.textContent = '---';
    setWarningUI(false);
    return;
  }

  const maxAngle = Math.max(angleLeft, angleRight);
  const isOver = maxAngle > LIMIT_ANGLE_DEG;

  if (angleDisplayLeft) {
    angleDisplayLeft.textContent = Math.round(angleLeft);
    if (angleLeft > LIMIT_ANGLE_DEG) {
      angleDisplayLeft.classList.add('over');
    } else {
      angleDisplayLeft.classList.remove('over');
    }
  }
  if (angleDisplayRight) {
    angleDisplayRight.textContent = Math.round(angleRight);
    if (angleRight > LIMIT_ANGLE_DEG) {
      angleDisplayRight.classList.add('over');
    } else {
      angleDisplayRight.classList.remove('over');
    }
  }

  // 統合されたヘッダー側へ状態を通知
  updateStatusUI(isOver ? 'over' : 'active');
  setWarningUI(isOver);
}


/* ============================================================
   12. 警告UI の切り替え
============================================================ */
function setWarningUI(isOver) {
  alertOverlay.classList.toggle('active', isOver);
  alertBanner.classList.toggle('active', isOver);

  if (isOver) {
    startAlertSound();
  } else {
    stopAlertSound();
  }
}


/* ============================================================
   13. アラート音声制御（Web Audio API）
============================================================ */
function startAlertSound() {
  if (!IS_AUDIO_ENABLED || !audioCtx || isPlayingBeep) return;
  isPlayingBeep = true;

  audioIntervalId = setInterval(() => {
    if (!IS_AUDIO_ENABLED || audioCtx.state === 'suspended') return;

    try {
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      osc.type = 'triangle';        // 三角波
      osc.frequency.setValueAtTime(660, audioCtx.currentTime); // 660Hz

      gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime); 
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15); 

      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      console.error('[Audio] 発音エラー:', e);
    }
  }, 400);
}

function stopAlertSound() {
  isPlayingBeep = false;
  if (audioIntervalId) {
    clearInterval(audioIntervalId);
    audioIntervalId = null;
  }
}


/* ============================================================
   14. ステータスバッジの更新
============================================================ */
function updateStatusUI(state) {
  const configs = {
    over:      { dot: 'warn',   text: '制限超過' },
    active:    { dot: 'active', text: '姿勢検出中' },
    searching: { dot: '',       text: '人物探索中' },
    error:     { dot: 'warn',   text: 'カメラエラー' },
  };
  const cfg = configs[state] || configs.searching;

  poseDot.className   = `status-dot ${cfg.dot}`;
  poseStatusText.textContent = cfg.text;
}


/* ============================================================
   15. ユーティリティ関数
============================================================ */
function syncCanvasSize(image) {
  if (
    canvasEl.width  !== image.width ||
    canvasEl.height !== image.height
  ) {
    canvasEl.width  = image.width  || 640;
    canvasEl.height = image.height || 480;
  }
}

function hideLoadingMessage() {
  if (!loadingMsg.classList.contains('hidden')) {
    loadingMsg.classList.add('hidden');
  }
}


/* ============================================================
   16. 将来の拡張用スタブ関数
============================================================ */
function sendToM5Stack(angleDeg, isOver) {
  // TODO: フェーズ3で実装予定
}

function logMeasurement(angleDeg) {
  // TODO: ログ・CSV出力機能用スタブ
}