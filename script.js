/**
 * ============================================================
 * shoulder-rom-app / script.js
 * 工業試験場 — 肩可動域チェッカー MVP
 *
 * 概要:
 * MediaPipe Pose を使いWebカメラ映像からリアルタイムに
 * 右肩の挙上角度を計算・表示し、制限角度超過を
 * 視覚的にフィードバックするプロトタイプ。
 *
 * 外部依存:
 * - @mediapipe/pose         (CDN)
 * - @mediapipe/camera_utils (CDN)
 * - @mediapipe/drawing_utils (CDN)
 *
 * 拡張ポイント:
 * - M5Stack ととの通信 → sendToM5Stack() 関数を追加し、
 * onAngleUpdated() 内から呼び出すことで簡単に連携可能。
 * - 左肩の計測追加 → LANDMARK_INDICES を変更し
 * calculateAngle() を再利用するだけで対応できる。
 * - 記録・ログ機能 → onAngleUpdated() でデータを配列に
 * 蓄積し、CSV ダウンロードなどに応用可能。
 * ============================================================
 */

'use strict';

/* ============================================================
   1. 設定定数・変数
============================================================ */

/** 肩挙上角度の制限値 [度]。ユーザーがUIから変更できるように let に変更 */
let LIMIT_ANGLE_DEG = 70;

/** ゲージの角度スケール上限 [度] */
const GAUGE_MAX_ANGLE_DEG = 180;

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

const gaugeFill      = document.getElementById('gauge-fill');
const gaugeLabelLimit = document.getElementById('gauge-label-limit');

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

    // 3. ゲージのテキストラベルを更新
    if (gaugeLabelLimit) {
      gaugeLabelLimit.textContent = `制限: ${newLimit}°`;
    }

    // 4. CSS変数を書き換えて、ゲージ上の赤ライン（#gauge-limit-line）を滑らかに動かす
    document.documentElement.style.setProperty('--limit-angle', newLimit);
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
  // LEFT_SHOULDER(11), RIGHT_SHOULDER(12), LEFT_ELBOW(13), RIGHT_ELBOW(14) を使用
  const leftShoulder  = landmarks[11]; 
  const rightShoulder = landmarks[12]; 
  const leftElbow     = landmarks[13];
  const rightElbow    = landmarks[14]; 

  // 両肩、両肘すべてが信頼度50%以上で映っていることを条件とする
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

  // ✅ 基準軸：画面の「真下」を向く固定ベクトル
  //    カメラ座標系では Y が下方向なので (0, 1) が「重力方向」に相当する
  const vecA = { x: 0, y: 1 };

  // 肩 → 肘 へのベクトル
  const vecB = {
    x: elbow.x - shoulder.x,
    y: elbow.y - shoulder.y,
  };

  const dot  = vecA.x * vecB.x + vecA.y * vecB.y;
  const magB = Math.hypot(vecB.x, vecB.y);

  if (magB === 0) return 0;

  // vecA の大きさは常に 1 なので magA の計算不要
  const cosTheta = Math.max(-1, Math.min(1, dot / magB));
  const angleDeg = (Math.acos(cosTheta) * 180) / Math.PI;

  // ✅ 補正ロジック不要・クリップのみ
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

  // 両肩を結ぶライン
  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(leftShoulder.x, leftShoulder.y);
  ctx.stroke();

  // 右腕のライン（右肩 ↔ 右肘）
  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(rightElbow.x, rightElbow.y);
  ctx.stroke();

  // 左腕のライン（左肩 ↔ 左肘）
  ctx.beginPath();
  ctx.moveTo(leftShoulder.x, leftShoulder.y);
  ctx.lineTo(leftElbow.x, leftElbow.y);
  ctx.stroke();

  // ランドマークの点を描画
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
  // 左肩の場合はテキストを右詰めに、右肩の場合は左詰めに調整して重なりを防ぐ
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
    updateGauge(0, false);
    return;
  }

  // 左右どちらか高い方の角度を基準に判定
  const maxAngle = Math.max(angleLeft, angleRight);
  const isOver = maxAngle > LIMIT_ANGLE_DEG;

  // 数値表示の更新
  if (angleDisplayLeft) {
    angleDisplayLeft.textContent = Math.round(angleLeft);
    angleDisplayLeft.style.color = (angleLeft > LIMIT_ANGLE_DEG) ? 'var(--warn-color)' : 'var(--text-primary)';
  }
  if (angleDisplayRight) {
    angleDisplayRight.textContent = Math.round(angleRight);
    angleDisplayRight.style.color = (angleRight > LIMIT_ANGLE_DEG) ? 'var(--warn-color)' : 'var(--text-primary)';
  }

  statusDisplay.textContent = isOver ? '超過' : '正常';
  statusDisplay.style.color = isOver ? 'var(--warn-color)' : 'var(--ok-color)';

  setWarningUI(isOver);
  updateGauge(maxAngle, isOver);
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
   13. ゲージバーの更新
============================================================ */

/**
 * 角度に応じてゲージバーの幅と色を更新する。
 *
 * @param {number}  angleDeg - 現在の角度 [度]
 * @param {boolean} isOver   - 制限超過フラグ
 */
function updateGauge(angleDeg, isOver) {
  const percent = Math.min((angleDeg / GAUGE_MAX_ANGLE_DEG) * 100, 100);
  gaugeFill.style.width = `${percent}%`;
  gaugeFill.classList.toggle('over', isOver);
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