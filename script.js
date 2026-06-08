/**
 * ============================================================
 * shoulder-rom-app / script.js
 * 工業試験場 — 肩可動域チェッカー MVP
 *
 * 概要:
 *   MediaPipe Pose を使いWebカメラ映像からリアルタイムに
 *   右肩の挙上角度を計算・表示し、制限角度超過を
 *   視覚的にフィードバックするプロトタイプ。
 *
 * 外部依存:
 *   - @mediapipe/pose     (CDN)
 *   - @mediapipe/camera_utils (CDN)
 *   - @mediapipe/drawing_utils (CDN)
 *
 * 拡張ポイント:
 *   - M5Stack との通信 → sendToM5Stack() 関数を追加し、
 *     onAngleUpdated() 内から呼び出すことで簡単に連携可能。
 *   - 左肩の計測追加 → LANDMARK_INDICES を変更し
 *     calculateAngle() を再利用するだけで対応できる。
 *   - 記録・ログ機能 → onAngleUpdated() でデータを配列に
 *     蓄積し、CSV ダウンロードなどに応用可能。
 * ============================================================
 */

'use strict';

/* ============================================================
   1. 設定定数（ここを変更することで動作をカスタマイズできる）
============================================================ */

/** 肩挙上角度の制限値 [度]。この値を超えると警告を出す。 */
let LIMIT_ANGLE_DEG = 70;

/**
 * MediaPipe Pose のランドマーク番号定義
 * 参照: https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 * ※ 映像は左右ミラー反転しているため、映像上の「右」が
 *    MediaPipe では LEFT_xxx になることに注意。
 *    ここでは直感的な「カメラ正面の右腕側」を使用するため
 *    実際の映像反転に合わせて LEFT を指定している。
 *    必要に応じて RIGHT / LEFT を切り替えること。
 */
const LANDMARK_INDICES = {
  RIGHT_SHOULDER: 12, // 右肩（MediaPipe 番号）
  RIGHT_ELBOW:    14, // 右肘
  RIGHT_HIP:      24, // 右腰
};

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
   2. DOM 要素の取得（一箇所にまとめて管理）
============================================================ */
const videoEl        = document.getElementById('input-video');
const canvasEl       = document.getElementById('output-canvas');
const ctx            = canvasEl.getContext('2d');

const alertOverlay   = document.getElementById('alert-overlay');
const alertBanner    = document.getElementById('alert-banner');
const loadingMsg     = document.getElementById('loading-msg');

const angleDisplay   = document.getElementById('angle-display');
const limitDisplay   = document.getElementById('limit-display');
const statusDisplay  = document.getElementById('status-display');

const poseDot        = document.getElementById('pose-status-dot');
const poseStatusText = document.getElementById('pose-status-text');

const gaugeFill      = document.getElementById('gauge-fill');
const gaugeLimitLine = document.getElementById('gauge-limit-line');
const gaugeLabelLimit = document.getElementById('gauge-label-limit');


/* ============================================================
   3. 初期化処理
============================================================ */

/**
 * アプリのエントリーポイント。
 * DOM 読み込み完了後に自動実行される。
 */
function initApp() {
  // 制限角度をUIに反映
  updateLimitUI(LIMIT_ANGLE_DEG);

  // MediaPipe Pose のセットアップ
  const pose = setupMediaPipePose();

  // カメラの起動
  startCamera(videoEl, pose);
}

// DOM 読み込み完了後に実行
document.addEventListener('DOMContentLoaded', initApp);


/* ============================================================
   4. MediaPipe Pose セットアップ
============================================================ */

/**
 * MediaPipe Pose インスタンスを生成・設定して返す。
 *
 * @returns {Pose} 設定済みの Pose インスタンス
 */
function setupMediaPipePose() {
  const pose = new Pose({
    locateFile: (file) => {
      // ファイル名（.wasm や .data など）に応じて、CDNの正しい正確なパスを返すように修正
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

  // MediaPipe から結果が返ってくるたびに呼ばれるコールバックを登録
  pose.onResults(onPoseResults);

  return pose;
}

/* ============================================================
   5. カメラ起動
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
      // 毎フレーム MediaPipe Pose に映像を送る
      await poseInstance.send({ image: videoElement });
    },
    // 解像度：処理速度と精度のバランスを取る
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
   6. MediaPipe Pose 結果コールバック（上半身モード完全対応版）
============================================================ */
function onPoseResults(results) {
  // キャンバスサイズをビデオに合わせる
  syncCanvasSize(results.image);

  // キャンバスをクリアして映像フレームを描画
  ctx.save();
  // カメラ映像を左右反転
  ctx.translate(canvasEl.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);
  ctx.restore();

  // ランドマークが取得できた場合のみ処理を行う
  if (results.poseLandmarks && results.poseLandmarks.length > 0) {
    // ローディング表示を非表示にする
    hideLoadingMessage();

    // 必要な3点のランドマーク座標（左肩・右肩・右肘）を取得
    const landmarks = extractTargetLandmarks(results.poseLandmarks);

    // ★修正ポイント：landmarks が正しく取得できた（nullではない）場合のみ描画と計算を行う
    if (landmarks) {
      // 肩の挙上角度を計算（両肩基準）
      const angleDeg = calculateShoulderAngle(landmarks);

      // 骨格ラインと角度を描画
      const isOver = angleDeg > LIMIT_ANGLE_DEG;
      drawSkeleton(landmarks, isOver);
      
      // ★修正ポイント：landmarks.shoulder から landmarks.rightShoulder に変更
      drawAngleOnCanvas(landmarks.rightShoulder, angleDeg, isOver);

      // UI を更新
      onAngleUpdated(angleDeg);
    } else {
      // 画面内に肩や肘が正しく映っていない場合、UIを一瞬リセットする
      updateStatusUI('searching');
      onAngleUpdated(null);
    }

    // ポーズ検出中のステータスを表示
    updateStatusUI('active');
  } else {
    // ランドマークが見つからない場合
    updateStatusUI('searching');
    onAngleUpdated(null);
  }
}


/* ============================================================
   7. ランドマーク座標の抽出（上半身特化・両肩基準版）
============================================================ */
function extractTargetLandmarks(landmarks) {
  // LEFT_SHOULDER(11), RIGHT_SHOULDER(12), RIGHT_ELBOW(14) を使用
  const leftShoulder  = landmarks[11]; 
  const rightShoulder = landmarks[12]; 
  const rightElbow    = landmarks[14]; 

  // 可視性スコアのチェック（腰を除外し、両肩と右肘のみを必須とする）
  const VISIBILITY_THRESHOLD = 0.5;
  if (
    leftShoulder.visibility  < VISIBILITY_THRESHOLD ||
    rightShoulder.visibility < VISIBILITY_THRESHOLD ||
    rightElbow.visibility    < VISIBILITY_THRESHOLD
  ) {
    return null;
  }

  const w = canvasEl.width;
  const h_ = canvasEl.height;
  const flip = (x) => (1 - x) * w; // 左右反転

  return {
    leftShoulder:  { x: flip(leftShoulder.x),  y: leftShoulder.y * h_ },
    rightShoulder: { x: flip(rightShoulder.x), y: rightShoulder.y * h_ },
    rightElbow:    { x: flip(rightElbow.x),    y: rightElbow.y * h_ },
  };
}

/* ============================================================
   8. 肩挙上角度の計算（垂直基準軸・Tポーズ＝90度版）
============================================================ */
function calculateShoulderAngle({ leftShoulder, rightShoulder, rightElbow }) {
  // 1. 体の傾きを計算するため、両肩を結ぶベクトルを作る
  const shoulderVec = {
    x: leftShoulder.x - rightShoulder.x,
    y: leftShoulder.y - rightShoulder.y,
  };

  // 2. 両肩ベクトルに対して「垂直に真下を向く」基準ベクトルを作る（重力方向の軸）
  // 画面座標系（下が Y+）において、横ベクトル (x, y) に垂直な下向きベクトルは (-y, x) となる
  const vecA = {
    x: -shoulderVec.y,
    y: shoulderVec.x
  };

  // 3. 右肩から右肘へのベクトル（上腕の向き）
  const vecB = {
    x: rightElbow.x - rightShoulder.x,
    y: rightElbow.y - rightShoulder.y,
  };

  // 内積の計算
  const dot = vecA.x * vecB.x + vecA.y * vecB.y;

  // ベクトルの大きさ
  const magA = Math.hypot(vecA.x, vecA.y);
  const magB = Math.hypot(vecB.x, vecB.y);

  if (magA === 0 || magB === 0) return 0;

  const cosTheta = Math.max(-1, Math.min(1, dot / (magA * magB)));
  let angleDeg = (Math.acos(cosTheta) * 180) / Math.PI;

  // 4. 肘が肩より上にあるか下にあるかで、180度までの挙動を補正
  // 肘が肩より上の場合、角度が90度を超えて上がっていくように処理
  if (rightElbow.y < rightShoulder.y) {
    // 垂直軸とのなす角（減少していく値）を、90度〜180度の増加値に変換
    angleDeg = 180 - angleDeg;
  }

  return angleDeg;
}


/* ============================================================
   9. キャンバスへの描画
============================================================ */

/**
 * 肩・肘・腰の骨格ラインとランドマーク点をキャンバスに描画する。
 *
 * @param {{ shoulder, elbow, hip }} landmarks - ピクセル座標
 * @param {boolean} isOver - 制限超過フラグ
 */
function drawSkeleton({ leftShoulder, rightShoulder, rightElbow }, isOver) {
  const color = isOver ? SKELETON_COLOR_WARNING : SKELETON_COLOR_NORMAL;
  ctx.save();

  ctx.strokeStyle = color;
  ctx.lineWidth   = SKELETON_LINE_WIDTH;
  ctx.lineCap     = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur  = 8;

  // 右肩 ↔ 左肩 のライン
  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(leftShoulder.x, leftShoulder.y);
  ctx.stroke();

  // 右肩 ↔ 右肘 のライン
  ctx.beginPath();
  ctx.moveTo(rightShoulder.x, rightShoulder.y);
  ctx.lineTo(rightElbow.x, rightElbow.y);
  ctx.stroke();

  // ランドマークの点を描画
  const points = [leftShoulder, rightShoulder, rightElbow];
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, LANDMARK_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  ctx.restore();
}

/**
 * 肩座標の近くに角度数値をキャンバスに描画する。
 *
 * @param {{ x, y }} shoulderPos - 肩のピクセル座標
 * @param {number}  angleDeg    - 表示する角度 [度]
 * @param {boolean} isOver      - 制限超過フラグ
 */
function drawAngleOnCanvas(shoulderPos, angleDeg, isOver) {
  const text  = `${Math.round(angleDeg)}°`;
  const color = isOver ? '#ff6b6b' : '#00d4ff';

  ctx.save();
  ctx.font         = 'bold 22px "Courier New", monospace';
  ctx.fillStyle    = color;
  ctx.shadowColor  = color;
  ctx.shadowBlur   = 10;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'bottom';

  // 肩の少し上・右にテキストを配置
  const offsetX = 14;
  const offsetY = -12;
  ctx.fillText(text, shoulderPos.x + offsetX, shoulderPos.y + offsetY);
  ctx.restore();
}


/* ============================================================
   10. 角度更新時のUI処理
   ※ M5Stack への送信など外部連携はこの関数から呼び出すと綺麗
============================================================ */

/**
 * 角度が更新されるたびに呼ばれる。
 * UI の更新・警告表示・外部連携の起点となる関数。
 *
 * @param {number | null} angleDeg - 計算された角度 [度]。
 *   ランドマーク未検出の場合は null。
 *
 * 【拡張例: M5Stack への送信】
 *   if (angleDeg !== null) {
 *     sendToM5Stack(angleDeg); // ← 別途実装した送信関数を呼ぶ
 *   }
 */
function onAngleUpdated(angleDeg) {
  if (angleDeg === null) {
    // ランドマーク未検出
    angleDisplay.textContent = '---';
    angleDisplay.classList.remove('over');
    statusDisplay.textContent = '検出中...';
    statusDisplay.style.color = 'var(--text-muted)';
    setWarningUI(false);
    updateGauge(0, false);
    return;
  }

  const isOver = angleDeg > LIMIT_ANGLE_DEG;
  const rounded = Math.round(angleDeg);

  // 角度数値の表示
  angleDisplay.textContent = rounded;
  angleDisplay.classList.toggle('over', isOver);

  // ステータステキスト
  statusDisplay.textContent = isOver ? '超過' : '正常';
  statusDisplay.style.color = isOver
    ? 'var(--warn-color)'
    : 'var(--ok-color)';

  // 警告オーバーレイの切り替え
  setWarningUI(isOver);

  // ゲージバーの更新
  updateGauge(angleDeg, isOver);

  // --- 拡張ポイント: ここに外部連携コードを追加 ---
  // 例: sendToM5Stack(rounded, isOver);
}


/* ============================================================
   11. 警告UI の切り替え
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
   12. ゲージバーの更新
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
   13. 制限角度UIの初期設定
============================================================ */

/**
 * 制限角度に関するUI要素を初期化する。
 *
 * @param {number} limitDeg - 制限角度 [度]
 */
function updateLimitUI(limitDeg) {
  // 制限角度の数値表示
  limitDisplay.textContent = limitDeg;

  // ゲージのラベル更新
  gaugeLabelLimit.textContent = `制限: ${limitDeg}°`;

  // ゲージ上の制限マーカー位置を設定
  const percent = (limitDeg / GAUGE_MAX_ANGLE_DEG) * 100;
  gaugeLimitLine.style.left = `${percent}%`;
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
 * アスペクト比が変わった場合のみ更新する。
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
 * ローディングメッセージを非表示にする（初回検出後に一度だけ実行）。
 */
function hideLoadingMessage() {
  if (!loadingMsg.classList.contains('hidden')) {
    loadingMsg.classList.add('hidden');
  }
}

/* ============================================================
   【機能追加】UIからの制限角度変更イベントの処理
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const limitSlider     = document.getElementById('limit-slider');
  const limitInput      = document.getElementById('limit-input');
  const gaugeLabelLimit = document.getElementById('gauge-label-limit');
  const limitMarker     = document.getElementById('limit-marker');

  /**
   * 制限角度が変更されたときにシステム全体に反映する共通関数
   * @param {number} newLimit - 新しい制限角度値
   */
  function updateLimitAngle(newLimit) {
    // 適切な範囲（30〜150度）にクリップ
    if (newLimit < 30) newLimit = 30;
    if (newLimit > 150) newLimit = 150;

    // 1. 変数を更新
    LIMIT_ANGLE_DEG = newLimit;

    // 2. UIの入力値を同期
    limitSlider.value = newLimit;
    limitInput.value  = newLimit;

    // 3. 下部のゲージバーのテキスト（制限: XX°）を更新
    if (gaugeLabelLimit) {
      gaugeLabelLimit.textContent = `制限: ${newLimit}°`;
    }

    // 4. 下部のゲージバー上の赤い目盛り位置（％）を動的に計算して更新
    if (limitMarker) {
      // 0度〜180度に対する割合
      const percentage = (newLimit / 180) * 100;
      limitMarker.style.left = `${percentage}%`;
    }
  }

  // スライダーが動かされたときの処理
  if (limitSlider) {
    limitSlider.addEventListener('input', (e) => {
      updateLimitAngle(parseInt(e.target.value, 10));
    });
  }

  // 数値入力ボックスが変更されたときの処理
  if (limitInput) {
    limitInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val)) val = 70; // 不正な入力はデフォルトにリセット
      updateLimitAngle(val);
    });
  }
});


/* ============================================================
   16. 将来の拡張用スタブ関数
   （必要に応じてコメントを外して実装してください）
============================================================ */

/**
 * M5Stack や外部デバイスへ角度データを送信する関数のスタブ。
 * WebSocket や BLE などの通信ライブラリを追加実装してください。
 *
 * @param {number}  angleDeg - 現在の角度 [度]
 * @param {boolean} isOver   - 制限超過フラグ
 */
// function sendToM5Stack(angleDeg, isOver) {
//   // 例: WebSocket を使って M5Stack に送信
//   // if (ws && ws.readyState === WebSocket.OPEN) {
//   //   ws.send(JSON.stringify({ angle: angleDeg, over: isOver }));
//   // }
// }

/**
 * 計測データをログとして記録するスタブ。
 * CSV ダウンロードや IndexedDB 保存などに応用してください。
 *
 * @param {number} angleDeg - 記録する角度 [度]
 * @param {Date}   timestamp - 計測時刻
 */
// function logMeasurement(angleDeg, timestamp = new Date()) {
//   // measurementLog.push({ time: timestamp.toISOString(), angle: angleDeg });
// }
