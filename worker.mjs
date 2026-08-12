/**
 * force-radar-proxy — 세력 발자국 레이더용 데이터 프록시
 *
 * KRX가 400을 뱉는 원인은 대부분 요청 형식입니다. 이 워커는 일곱 가지를 전부 막습니다.
 *   1) POST 전용 엔드포인트를 GET으로 호출
 *   2) Referer 누락 (봇으로 판정)
 *   3) Content-Type을 application/json으로 전송
 *   4) 날짜에 하이픈 포함 (20260812 만 허용)
 *   5) 6자리 단축코드 사용 (개별종목은 표준코드 KR7005930003 필요)
 *   6) User-Agent 누락
 *   7) bld 문자열 오타 → /diag 로 즉시 확인
 *
 * 배포:  npx wrangler deploy
 * 진단:  curl "https://<worker>/diag?bld=dbms/MDC/STAT/standard/MDCSTAT01501"
 */

const KRX_JSON   = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const KRX_REFER  = 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* bld 문자열은 KRX가 예고 없이 바꿉니다. 한 곳에 모아두고 /diag 로 검증하세요. */
const BLD = {
  finder:   'dbms/comm/finder/finder_stkisu',              // 종목 검색 → 표준코드(ISU_CD)
  ohlcv:    'dbms/MDC/STAT/standard/MDCSTAT01701',         // 개별종목 일별시세
  investor: 'dbms/MDC/STAT/standard/MDCSTAT02301',         // 투자자별 거래실적
  short:    'dbms/MDC/STAT/srt/MDCSTAT30601',              // 대차/공매도 잔고 추이
};

/* ── 공통 ────────────────────────────────────────── */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const fail = (msg, detail, status = 502) => json({ error: msg, detail }, status);

/** 날짜를 KRX가 받는 YYYYMMDD로. 하이픈·슬래시·Date 모두 흡수한다. */
const ymd = d => {
  if (d instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  const s = String(d).replace(/\D/g, '');
  return s.slice(0, 8);
};
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const num = v => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/* ── KRX 호출부 — 여기가 400의 핵심 ─────────────── */
export function buildKrxRequest(bld, params) {
  const form = new URLSearchParams();
  form.set('bld', bld);                       // (7) 필수
  form.set('locale', 'ko_KR');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // (4) 날짜형 파라미터는 무조건 숫자 8자리로 정규화
    form.set(k, /Dd$/.test(k) ? ymd(v) : String(v));
  }
  return {
    url: KRX_JSON,
    init: {
      method: 'POST',                          // (1)
      headers: {
        // (3) JSON 금지. 반드시 폼 인코딩
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'referer': KRX_REFER,                  // (2)
        'user-agent': UA,                      // (6)
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        'accept-language': 'ko-KR,ko;q=0.9',
      },
      body: form.toString(),
    },
    formPreview: form.toString(),
  };
}

async function krx(bld, params) {
  const { url, init, formPreview } = buildKrxRequest(bld, params);
  const res = await fetch(url, init);
  const text = await res.text();

  if (!res.ok) {
    const e = new Error(`KRX HTTP ${res.status}`);
    e.detail = { bld, sent: formPreview, status: res.status, body: text.slice(0, 400) };
    throw e;
  }
  let data;
  try { data = JSON.parse(text); }
  catch {
    const e = new Error('KRX 응답이 JSON이 아닙니다 (bld 오타이거나 차단된 경우)');
    e.detail = { bld, sent: formPreview, body: text.slice(0, 400) };
    throw e;
  }
  // KRX는 200을 주면서 본문에 오류를 담기도 한다
  if (data.CODE && data.CODE !== '00') {
    const e = new Error('KRX 오류 코드 ' + data.CODE);
    e.detail = { bld, sent: formPreview, message: data.MSG || data.MESSAGE };
    throw e;
  }
  const rows = data.output ?? data.OutBlock_1 ?? data.block1 ?? data.output1 ?? [];
  return { rows: Array.isArray(rows) ? rows : [], raw: data };
}

/* (5) 6자리 단축코드 → 표준코드. 이걸 안 하면 개별종목 조회가 전부 실패한다. */
const isuCache = new Map();
async function resolveIsu(code) {
  const short = String(code).replace(/\D/g, '').padStart(6, '0');
  if (isuCache.has(short)) return isuCache.get(short);

  const { rows } = await krx(BLD.finder, {
    mktsel: 'ALL', typeNo: '0', searchText: short,
  });
  const hit = rows.find(r => (r.short_code || r.shrt_cd || '').replace(/\D/g, '') === short) || rows[0];
  const full = hit?.full_code || hit?.std_cd || hit?.isu_cd;
  if (!full) {
    const e = new Error(`종목코드 ${short}의 표준코드를 찾지 못했습니다`);
    e.detail = { sampleRow: rows[0] ?? null, hint: 'BLD.finder 값 또는 응답 필드명을 /diag 로 확인하세요' };
    throw e;
  }
  isuCache.set(short, full);
  return full;
}

/* ── 라우트 ──────────────────────────────────────── */

/** 일별 시세 → [{date,open,high,low,close,volume}] 오래된순 */
async function routeOhlcv(code, count) {
  const isu = await resolveIsu(code);
  const { rows } = await krx(BLD.ohlcv, {
    isuCd: isu, strtDd: daysAgo(Math.ceil(count * 1.7) + 10), endDd: daysAgo(0),
    adjStkPrc: '2',                       // 수정주가 반영
  });
  return rows.map(r => ({
    date: String(r.TRD_DD || '').replace(/\D/g, ''),
    open: num(r.TDD_OPNPRC), high: num(r.TDD_HGPRC),
    low: num(r.TDD_LWPRC), close: num(r.TDD_CLSPRC),
    volume: num(r.ACC_TRDVOL),
  })).filter(c => c.date && c.close > 0)
     .sort((a, b) => a.date.localeCompare(b.date))
     .slice(-count);
}

/** 투자자별 순매수 → {foreign:[],inst:[],retail:[]} 오래된순 */
async function routeInvestor(code, days) {
  const isu = await resolveIsu(code);
  const { rows } = await krx(BLD.investor, {
    isuCd: isu, strtDd: daysAgo(Math.ceil(days * 1.8) + 7), endDd: daysAgo(0),
    inqTpCd: '2', trdVolVal: '2', askBid: '3',   // 일별 / 거래대금 / 순매수
  });
  const asc = rows
    .map(r => ({ d: String(r.TRD_DD || '').replace(/\D/g, ''), r }))
    .filter(x => x.d).sort((a, b) => a.d.localeCompare(b.d)).slice(-days);

  const pick = (r, ...keys) => {
    for (const k of keys) if (r[k] !== undefined) return num(r[k]);
    return 0;
  };
  return {
    foreign: asc.map(x => pick(x.r, 'TRDVAL4', 'FORN_NETBID', 'TRDVAL_FORN')),
    inst:    asc.map(x => pick(x.r, 'TRDVAL1', 'INVST_NETBID', 'TRDVAL_INST')),
    retail:  asc.map(x => pick(x.r, 'TRDVAL3', 'INDVD_NETBID', 'TRDVAL_INDV')),
  };
}

/** 대차잔고 추이 → [주수] 오래된순 */
async function routeShort(code, days) {
  const isu = await resolveIsu(code);
  const { rows } = await krx(BLD.short, {
    isuCd: isu, strtDd: daysAgo(Math.ceil(days * 1.8) + 10), endDd: daysAgo(0),
    mktTpCd: '1',
  });
  return rows
    .map(r => ({ d: String(r.TRD_DD || '').replace(/\D/g, ''),
                 v: num(r.BAL_QTY ?? r.LOAN_BAL_QTY ?? r.SRTSEL_BAL_QTY) }))
    .filter(x => x.d && x.v > 0)
    .sort((a, b) => a.d.localeCompare(b.d))
    .slice(-days).map(x => x.v);
}

/* ── KIS: 실시간 호가·체결 (허수율 채널용) ───────
   KRX는 실시간 호가를 주지 않습니다. 한국투자증권 OpenAPI 키가 필요합니다.
   wrangler secret put KIS_APPKEY / KIS_APPSECRET 로 등록하세요. */
let kisToken = { value: null, exp: 0 };
async function kisAuth(env) {
  if (kisToken.value && Date.now() < kisToken.exp) return kisToken.value;
  const r = await fetch('https://openapi.koreainvestment.com:9443/oauth2/tokenP', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials',
      appkey: env.KIS_APPKEY, appsecret: env.KIS_APPSECRET }),
  });
  const d = await r.json();
  if (!d.access_token) { const e = new Error('KIS 토큰 발급 실패'); e.detail = d; throw e; }
  kisToken = { value: d.access_token, exp: Date.now() + 60 * 60 * 1000 };
  return kisToken.value;
}
async function kis(env, path, trId, params) {
  const tok = await kisAuth(env);
  const u = new URL('https://openapi.koreainvestment.com:9443' + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: {
    authorization: `Bearer ${tok}`, appkey: env.KIS_APPKEY,
    appsecret: env.KIS_APPSECRET, tr_id: trId, custtype: 'P',
  }});
  const d = await r.json();
  if (!r.ok) { const e = new Error(`KIS HTTP ${r.status}`); e.detail = d; throw e; }
  return d;
}

/** 호가 → {ts, asks:[{price,size}], bids:[...]} */
async function routeOrderbook(env, code) {
  const d = await kis(env, '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
    'FHKST01010200', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
  const o = d.output1 || {};
  const asks = [], bids = [];
  for (let i = 1; i <= 10; i++) {
    const ap = num(o[`askp${i}`]), as = num(o[`askp_rsqn${i}`]);
    const bp = num(o[`bidp${i}`]), bs = num(o[`bidp_rsqn${i}`]);
    if (ap > 0) asks.push({ price: ap, size: as });
    if (bp > 0) bids.push({ price: bp, size: bs });
  }
  return { timestamp: Date.now(), asks, bids };
}

/** 체결 틱 → [{ts,price,volume,side}] */
async function routeTrades(env, code) {
  const d = await kis(env, '/uapi/domestic-stock/v1/quotations/inquire-ccnl',
    'FHKST01010300', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
  const base = new Date(); const rows = d.output || [];
  return rows.map(r => {
    const hhmmss = String(r.stck_cntg_hour || '000000').padStart(6, '0');
    const t = new Date(base);
    t.setHours(+hhmmss.slice(0, 2), +hhmmss.slice(2, 4), +hhmmss.slice(4, 6), 0);
    return { ts: t.getTime(), price: num(r.stck_prpr), volume: num(r.cntg_vol),
             side: num(r.prdy_vrss) >= 0 ? 'bid' : 'ask' };
  }).filter(t => t.price > 0);
}

/* ── 진입점 ──────────────────────────────────────── */
export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const code = (url.searchParams.get('code') || '005930').replace(/\D/g, '');
    const n = k => Math.max(1, Math.min(500, Number(url.searchParams.get(k)) || 0));

    // 같은 요청은 10분 캐시 — KRX를 반복 호출하면 차단됩니다
    const cache = caches.default;
    const cacheable = ['/ohlcv', '/investor', '/short'].includes(p);
    if (cacheable) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }

    try {
      let out;
      switch (p) {
        case '/':
        case '/health':
          return json({ ok: true, routes: ['/ohlcv', '/investor', '/short', '/orderbook', '/trades', '/diag'] });

        /* 400의 정체를 한 번에 보여주는 진단 창구 */
        case '/diag': {
          const bld = url.searchParams.get('bld') || BLD.finder;
          const extra = {};
          for (const [k, v] of url.searchParams) if (!['bld'].includes(k)) extra[k] = v;
          if (!Object.keys(extra).length) Object.assign(extra, { mktsel: 'ALL', typeNo: '0', searchText: code });
          const { formPreview } = buildKrxRequest(bld, extra);
          try {
            const { rows, raw } = await krx(bld, extra);
            return json({ ok: true, bld, sent: formPreview, rowCount: rows.length,
                          firstRow: rows[0] ?? null, keys: Object.keys(raw) });
          } catch (e) {
            return json({ ok: false, bld, sent: formPreview,
                          message: e.message, detail: e.detail ?? null }, 200);
          }
        }

        case '/ohlcv':     out = await routeOhlcv(code, n('count') || 120); break;
        case '/investor':  out = await routeInvestor(code, n('days') || 20); break;
        case '/short':     out = await routeShort(code, n('days') || 30); break;
        case '/orderbook':
          if (!env.KIS_APPKEY) return fail('KIS 키가 등록되지 않았습니다',
            'wrangler secret put KIS_APPKEY / KIS_APPSECRET', 501);
          out = await routeOrderbook(env, code); break;
        case '/trades':
          if (!env.KIS_APPKEY) return fail('KIS 키가 등록되지 않았습니다',
            'wrangler secret put KIS_APPKEY / KIS_APPSECRET', 501);
          out = await routeTrades(env, code); break;
        default:
          return json({ error: '없는 경로입니다', path: p }, 404);
      }

      const res = json(out, 200, cacheable ? { 'cache-control': 'public, max-age=600' } : {});
      if (cacheable) ctx.waitUntil(cache.put(req, res.clone()));
      return res;

    } catch (e) {
      return fail(e.message, e.detail ?? null);
    }
  },
};
