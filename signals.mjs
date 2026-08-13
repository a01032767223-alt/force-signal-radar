/* 세력 신호 계산 엔진 — 순수 함수. 입력은 모두 오래된순 배열. */

export const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

/** 값 v를 [a,b] 구간에 대해 0~100으로 사상. a→0, b→100 (a>b면 역방향) */
export function mapRange(v, a, b) {
  if (a === b) return 50;
  return clamp(((v - a) / (b - a)) * 100);
}

/** 최소제곱 기울기 (x는 0..n-1) */
export function slope(arr) {
  const n = arr.length; if (n < 2) return 0;
  const mx = (n - 1) / 2, my = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (arr[i] - my); den += (i - mx) ** 2; }
  return den ? num / den : 0;
}

/** OBV 누적 */
export function obv(candles) {
  let v = 0; const out = [0];
  for (let i = 1; i < candles.length; i++) {
    const d = Math.sign(candles[i].close - candles[i - 1].close);
    v += d * candles[i].volume;
    out.push(v);
  }
  return out;
}

/* ── 채널 1. 매집 강도 ─────────────────────────────
   거래량은 마르고(dryness), 물량은 쌓이고(OBV 다이버전스),
   저점은 계단식으로 올라오는(higher lows) 상태의 결합. */
export function accumulation(candles) {
  if (candles.length < 60) return null;
  const recent = candles.slice(-20), prior = candles.slice(-60, -20);

  // (a) 거래량 침체: 최근 20일 / 직전 40일. 0.55배 이하면 만점, 1.15배면 0점
  const vr = mean(recent.map(c => c.volume)) / (mean(prior.map(c => c.volume)) || 1);
  const dryness = mapRange(vr, 1.15, 0.55);

  // (b) OBV 다이버전스: OBV는 오르는데 가격은 안 오르는 정도
  const o = obv(candles).slice(-20);
  const p = recent.map(c => c.close);
  const norm = s => { const r = Math.max(...s) - Math.min(...s); return r ? slope(s) / r * s.length : 0; };
  const diverge = mapRange(norm(o) - norm(p), -0.35, 0.55);

  // (c) 저점 절상: 20일을 4구간으로 쪼개 최저가가 올라간 횟수
  const seg = [0, 1, 2, 3].map(i => Math.min(...recent.slice(i * 5, i * 5 + 5).map(c => c.low)));
  let ups = 0; for (let i = 1; i < 4; i++) if (seg[i] > seg[i - 1]) ups++;
  const higherLows = (ups / 3) * 100;

  return Math.round(clamp(dryness * 0.34 + diverge * 0.42 + higherLows * 0.24));
}

/* ── 채널 2. 분산 경보 ─────────────────────────────
   "가장 많이 사는 날"에 윗꼬리가 길고 종가가 하단에 남는가.
   거래량 상위 25% 날만 본다. */
export function distribution(candles) {
  if (candles.length < 40) return null;
  const win = candles.slice(-40);
  const desc = [...win].sort((a, b) => b.volume - a.volume);
  const cut = desc[Math.max(0, Math.ceil(win.length * 0.25) - 1)].volume;
  const heavy = win.filter(c => c.volume >= cut);
  if (heavy.length < 3) return null;

  const wick = mean(heavy.map(c => {
    const r = c.high - c.low; return r ? (c.high - c.close) / r : 0;
  }));                                   // 윗꼬리 비율 (0~1)
  const bearish = heavy.filter(c => c.close < c.open).length / heavy.length;
  const closePos = 1 - mean(heavy.map(c => {
    const r = c.high - c.low; return r ? (c.close - c.low) / r : 0.5;
  }));                                   // 종가가 하단일수록 1

  return Math.round(clamp(wick * 100 * 0.42 + bearish * 100 * 0.28 + closePos * 100 * 0.30));
}

/* ── 채널 3. 호가 허수율 ───────────────────────────
   호가가 줄어든 이유는 둘 중 하나다 — 체결됐거나, 취소됐거나.
   그 구간에 체결가가 해당 호가에 닿지 않았다면 체결로는 설명이 안 된다.
   즉 "가격이 오지도 않았는데 사라진 물량"의 비중을 센다.
   snapshots: [{ts, asks:[{price,size}], bids:[...]}], trades: [{ts, price, volume}] */
export const DEPTH = 5;   // 판정 대상 호가 깊이
export function spoofRate(snapshots, trades) {
  if (snapshots.length < 3) return null;
  let removed = 0, unexecuted = 0;

  // 구간 안에 체결이 하나도 안 잡히면 (스냅샷·체결 시각이 어긋난 경우)
  // 전체 체결의 가격범위로 대신 판정한다. 허수로 몰기보다 놓치는 쪽이 안전하다.
  const all = trades.filter(t => Number.isFinite(t.price));
  const gHi = all.length ? Math.max(...all.map(t => t.price)) : -Infinity;
  const gLo = all.length ? Math.min(...all.map(t => t.price)) : Infinity;

  // 최우선호가에서 먼 구간은 체결과 무관하게 늘 바뀐다. 근접 5호가만 본다.
  const near = (book, side) => [...book]
    .sort((a, b) => side === 'asks' ? a.price - b.price : b.price - a.price)
    .slice(0, DEPTH);

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1], cur = snapshots[i];
    const win = all.filter(t => t.ts >= prev.ts && t.ts <= cur.ts);
    const hi = win.length ? Math.max(...win.map(t => t.price)) : gHi;
    const lo = win.length ? Math.min(...win.map(t => t.price)) : gLo;

    for (const side of ['asks', 'bids']) {
      const now = new Map(cur[side].map(l => [l.price, l.size]));
      for (const l of near(prev[side], side)) {
        const after = now.get(l.price) ?? 0;
        if (after >= l.size) continue;
        const gone = l.size - after;
        removed += gone;
        // 매도호가는 체결가가 그 가격 이상 올라와야, 매수호가는 그 이하로 내려와야 체결 가능
        const reached = side === 'asks' ? hi >= l.price : lo <= l.price;
        if (!reached) unexecuted += gone;
      }
    }
  }
  if (removed <= 0) return 0;
  return Math.round(clamp((unexecuted / removed) * 100));
}

/* ── 채널 4. 큰손 수급 연속성 ──────────────────────
   foreign/inst: 일별 순매수 금액 배열(오래된순). 동반 매수일수록 높다. */
export function smartMoney(foreign, inst) {
  if (!foreign?.length || !inst?.length) return null;
  const f = foreign.slice(-20), n = inst.slice(-20);
  const both = f.map((v, i) => (v > 0 && n[i] > 0) ? 1 : (v < 0 && n[i] < 0) ? -1 : 0);

  let streak = 0;                       // 최근 동반 순매수 연속일
  for (let i = both.length - 1; i >= 0 && both[i] === 1; i--) streak++;

  const ratio = both.filter(v => v === 1).length / both.length;
  const netTilt = mapRange(
    (f.slice(-5).reduce((a, b) => a + b, 0) + n.slice(-5).reduce((a, b) => a + b, 0)) /
    (mean([...f, ...n].map(Math.abs)) * 10 || 1), -1, 1);

  return Math.round(clamp(ratio * 100 * 0.34 + Math.min(streak, 5) / 5 * 100 * 0.30 + netTilt * 0.36));
}

/* ── 채널 5. 대차잔고 증가율 ───────────────────────
   balances: 일별 대차잔고 주수(오래된순). 20일 전 대비 증가율을 0~100 사상. */
export function shortBuild(balances) {
  if (!balances || balances.length < 21) return null;
  const now = balances.at(-1), was = balances.at(-21);
  if (!was) return null;
  const pct = (now / was - 1) * 100;
  return Math.round(mapRange(pct, -12, 35));   // -12%↓ = 0, +35%↑ = 100
}

/* ── 채널 6. 거래소 순입금 / 고래 체결 편향 ────────
   (a) netflow 데이터가 있으면 그것으로,
   (b) 없으면 대형 체결의 매도 편향으로 대체 추정.
   trades: [{volume, price, side:'ask'|'bid'}]  side='ask' = 매도 체결 */
export function exchangeFlow({ netflow, trades }) {
  if (netflow?.length >= 8) {
    const s = netflow.slice(-7).reduce((a, b) => a + b, 0);
    const scale = mean(netflow.map(Math.abs)) * 7 || 1;
    return { value: Math.round(mapRange(s / scale, -1.2, 1.2)), method: 'netflow' };
  }
  if (trades?.length >= 30) {
    const sorted = [...trades].sort((a, b) => b.volume - a.volume);
    const whales = sorted.slice(0, Math.max(10, Math.floor(trades.length * 0.1)));
    const sellVol = whales.filter(t => t.side === 'ask').reduce((a, t) => a + t.volume, 0);
    const total = whales.reduce((a, t) => a + t.volume, 0) || 1;
    return { value: Math.round(mapRange(sellVol / total, 0.30, 0.72)), method: 'whale-bias' };
  }
  return null;
}

/* ── 종합 점수 ─────────────────────────────────────
   가점: 매집, 큰손 수급 / 감점: 분산, 허수, 대차, 순입금
   결측 채널은 가중치에서 제외하고 재정규화한다. */
export function composite(ch) {
  const W = {
    accum: [0.34, +1], smart: [0.26, +1],
    distrib: [0.20, -1], spoof: [0.06, -1],
    short: [0.08, -1], flow: [0.14, -1],
  };
  let num = 0, den = 0;
  for (const [k, [w, sign]] of Object.entries(W)) {
    const v = ch[k];
    if (v == null || Number.isNaN(v)) continue;
    num += w * (sign > 0 ? v : 100 - v);
    den += w;
  }
  if (!den) return null;
  return Math.round(clamp(num / den));
}

export function verdict(score) {
  if (score == null) return { label: '판정 불가', tone: 'mut', phase: -1 };
  if (score >= 72) return { label: '매집 우세', tone: 'up', phase: 0 };
  if (score >= 55) return { label: '상승 견인', tone: 'up', phase: 1 };
  if (score >= 38) return { label: '분산 경계', tone: 'warn', phase: 2 };
  return { label: '이탈 국면', tone: 'down', phase: 3 };
}

/* ── 눌림목 판정 ──────────────────────────────────────
   index.html의 detectPullback과 완전히 동일한 로직을 유지한다.
   한쪽만 고치고 잊어버리면 테스트가 실제 배포본과 다른 걸 검증하게 되므로,
   수정 시 반드시 양쪽을 함께 바꿀 것. */
export function detectPullback(candles) {
  if (!candles || candles.length < 25) return { state: 'insufficient' };
  const win = candles.slice(-21);
  const today = win.at(-1);
  const peakIdx = win.reduce((bi, c, i) => (c.close > win[bi].close ? i : bi), 0);
  const peak = win[peakIdx];
  const daysElapsed = win.length - 1 - peakIdx;

  if (daysElapsed === 0)
    return { state: 'none', daysElapsed: 0, dropPct: 0, peakDate: peak.date, peakClose: peak.close };

  const dropPct = Math.round(((peak.close - today.close) / peak.close) * 1000) / 10;
  const ma20 = mean(candles.slice(-20).map(c => c.close));
  const supportHeld = today.close >= ma20 * 0.97;

  const since = win.slice(peakIdx + 1);
  const avgVolBase = mean(candles.slice(-40, -20).map(c => c.volume)) || 1;
  const avgVolSince = mean(since.map(c => c.volume));
  const volumeContraction = avgVolSince < avgVolBase * 0.85;

  const yesterday = win.at(-2);
  const reboundToday = today.close > yesterday.close &&
    today.volume > mean(since.slice(0, -1).map(c => c.volume) || [today.volume]) * 1.15;

  let state;
  if (!supportHeld || dropPct > 18 || daysElapsed > 15) state = 'breakdown';
  else if (dropPct < 2) state = 'watching';
  else if (reboundToday) state = 'ending';
  else state = 'active';

  return { state, daysElapsed, dropPct, volumeContraction, supportHeld,
    peakDate: peak.date, peakClose: peak.close, todayClose: today.close, ma20: Math.round(ma20) };
}

