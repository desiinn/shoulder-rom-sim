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
 * 
 * Copyright 2026 Google LLC.
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
const statusDisplay  = document.getElementById('status-display');

const poseDot        = document.getElementById('pose-status-dot');
const poseStatusText = document.getElementById('pose-status-text');

// 追加したUIコントロール要素
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
   5. MediaPipe Pose セットアップ
============================================================ */

/**
 * MediaPipe Pose インスタンスを生成・設定して返す。
 *
 * @returns {Pose} 設定済みの Pose インスタンス
 */
function setupMediaPipePose() {
  const pose = new Pose({
    locateFile: (file) => {
      return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
    },
  });

  pose.setOptions({
    modelComplexity:   1,       // 0=軽量, 1=標準, 2=高精度
    smoothLandmarks:   true,    // ランドマークのブレを平滑化
    enableSegmentation: false,  // セグメンテーション不要なので無効
    minDetectionConfidence: 0.5,
    minTrackingConfidence:  0.5,
  });

  pose.onResults(onPoseResults);
  return pose;
}


/* ============================================================
   6. カメラ起動
============================================================ */

/**
 * Webカメラを起動し、MediaPipe Camera Utils でフレームを
 * Pose に送り続けるループを開始する。
 *
 * @param {HTMLVideoElement} videoElement - 入力映像要素
 * @param {Pose}             poseInstance - MediaPipe Pose インスタンス
 */
function startCamera(videoElement, poseInstance) {
  const camera = new Camera(videoElement, {
    onFrame: async () => {
      await poseInstance.send({ image: videoElement });
    },
    width:  640,
    height: 480,
    facingMode: 'user', // インカメラを優先
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
      // 左右それぞれの角度を計算
      const angleLeft  = calculateShoulderAngle(landmarks, 'left');
      const angleRight = calculateShoulderAngle(landmarks, 'right');

      // どちらか一方でも制限値を超えていたら警告対象とする
      const maxAngle = Math.max(angleLeft, angleRight);
      const isOver = maxAngle > LIMIT_ANGLE_DEG;

      // 骨格と各角度を画面に描画
      drawSkeleton(landmarks, isOver);
      drawAngleOnCanvas(landmarks.leftShoulder, angleLeft, angleLeft > LIMIT_ANGLE_DEG, 'left');
      drawAngleOnCanvas(landmarks.rightShoulder, angleRight, angleRight > LIMIT_ANGLE_DEG, 'right');

      onAngleUpdated(angleLeft, angleRight);
    } else {
      updateStatusUI('searching');
      onAngleUpdated(null, null);
    }

    updateStatusUI('active');
  } else {
    updateStatusUI('searching');
    onAngleUpdated(null, null);
  }
}

/* ============================================================
   8. ランドマーク座標の抽出（両腕対応・上半身特化版）
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
   9. 肩挙上角度の計算（垂直基準軸・下限リミッター付き左右汎用版）
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
   10. キャンバスへの描画（両腕対応版）
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
   11. 角度更新時のUI処理（両腕対応版）
============================================================ */
function onAngleUpdated(angleLeft, angleRight) {
  if (angleLeft === null || angleRight === null) {
    if (angleDisplayLeft)  angleDisplayLeft.textContent = '---';
    if (angleDisplayRight) angleDisplayRight.textContent = '---';
    statusDisplay.textContent = '検出中...';
    statusDisplay.style.color = 'var(--text-muted)';
    setWarningUI(false);
    return;
  }

  const maxAngle = Math.max(angleLeft, angleRight);
  const isOver = maxAngle > LIMIT_ANGLE_DEG;

  // 数値表示の更新および制限超過時の個別カラー変更
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

  statusDisplay.textContent = isOver ? '超過' : '正常';
  statusDisplay.style.color = isOver ? 'var(--warn-color)' : 'var(--ok-color)';

  setWarningUI(isOver);
}


/* ============================================================
   12. 警告UI の切り替え
============================================================ */

/**
 * 可動域超過時に赤いオーバーレイとバナーを表示する。
 *
 * @param {boolean} isOver - true のとき警告状態にする
 */
function setWarningUI(isOver) {
  alertOverlay.classList.toggle('active', isOver);
  alertBanner.classList.toggle('active', isOver);
}


/* ============================================================
   14. ステータスバッジの更新
============================================================ */

/**
 * ヘッダーのステータス表示を更新する。
 *
 * @param {'active' | 'searching' | 'error'} state - 状態文字列
 */
function updateStatusUI(state) {
  const configs = {
    active:    { dot: 'active', text: '姿勢検出中' },
    searching: { dot: '',       text: '人物を探しています...' },
    error:     { dot: 'warn',   text: 'カメラエラー' },
  };
  const cfg = configs[state] || configs.searching;

  poseDot.className   = `status-dot ${cfg.dot}`;
  poseStatusText.textContent = cfg.text;
}


/* ============================================================
   15. ユーティリティ関数
============================================================ */

/**
 * キャンバスのサイズを描画する映像に合わせて同期する。
 *
 * @param {HTMLVideoElement | HTMLImageElement} image - 映像ソース
 */
function syncCanvasSize(image) {
  if (
    canvasEl.width  !== image.width ||
    canvasEl.height !== image.height
  ) {
    canvasEl.width  = image.width  || 640;
    canvasEl.height = image.height || 480;
  }
}

/**
 * ローディングメッセージを非表示にする。
 */
function hideLoadingMessage() {
  if (!loadingMsg.classList.contains('hidden')) {
    loadingMsg.classList.add('hidden');
  }
}


/* ============================================================
   16. 将来の拡張用スタブ関数
============================================================ */

/**
 * M5Stack や外部デバイスへ角度データを送信する関数のスタブ。
 *
 * @param {number}  angleDeg - 現在の角度 [度]
 * @param {boolean} isOver   - 制限超過フラグ
 */
function sendToM5Stack(angleDeg, isOver) {
  // TODO: フェーズ2で実装予定
}

/**
 * 計測データをログとして記録するスタブ。
 *
 * @param {number} angleDeg - 記録する角度 [度]
 */
function logMeasurement(angleDeg) {
  // TODO: ログ・CSV出力機能用スタブ
}