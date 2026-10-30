#!/usr/bin/env node
/**
 * 擒龙手 · 黄大侠拐点战法 云端监控引擎（零依赖，Node >= 18）
 *
 * 用法：
 *   node monitor.mjs scan <noon|evening|night>   采集日线→判信号→持仓到位检查→写pending/ledger/nav
 *   node monitor.mjs remind <noon|evening|morning>  推送到期入场信号到飞书
 *   node monitor.mjs feedback                     解析GitHub Issue评论反馈（读环境变量）
 *   node monitor.mjs nav                          重建 docs/index.html 净值面板
 *   node monitor.mjs contracts                    合约换月维护（到期切换主力）
 *   node monitor.mjs pool                         月度品种池筛选（每月1日，口径见 settings.pool_screen）
 *
 * 环境变量：
 *   FEISHU_WEBHOOK   飞书群机器人 Webhook（缺失时仅打印不发送，便于本地测试）
 *   FEISHU_SECRET    飞书机器人签名校验密钥（可选）
 *   TODAY_OVERRIDE   强制指定"今天"（YYYY-MM-DD，本地回测用）
 *   FORCE_TRADING_DAY=1  跳过交易日判定（本地调试用）
 *   COMMENT_AUTHOR / COMMENT_BODY  feedback 模式读取
 *   REPO_OWNER       仓库 owner 登录名（仅其评论生效）
 *   NO_WAIT_SCAN=1   remind 跳过"等待扫描完成"的防竞态轮询（本地调试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const J = (...p) => path.join(ROOT, ...p);
const readJson = (p, dft) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dft; } };
const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };

const POOL = readJson(J('config/pool.json'), []);
const CANDIDATES = readJson(J('config/candidates.json'), POOL); // 全市场候选品种全集（月度筛池用）
const BLACKOUT = readJson(J('config/blackout.json'), { dates: {} });
const SETTINGS = readJson(J('config/settings.json'), { risk_pct: 0.03, margin_cap: 0.8, max_zone_signals: 3, min_history: 60 });
let CONTRACTS = readJson(J('config/contracts.json'), {});
const SPEC = Object.fromEntries(POOL.map(s => [s.code, s]));

const WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const FSECRET = process.env.FEISHU_SECRET || '';
const TODAY_OVERRIDE = process.env.TODAY_OVERRIDE || '';
const FORCE_TD = process.env.FORCE_TRADING_DAY === '1';
// 手动 Run workflow（workflow_dispatch）视为用户显式强制执行，绕过所有幂等守卫（2026-10-29）。
// 外部定时踢腿器（cron-job.org 等）走的也是 workflow_dispatch，但它需要参与幂等去重，
// 故仅在 DISPATCH_FORCE=1 时才绕过；外部触发传 force=0（或省略）即走正常守卫（2026-10-29）。
const IS_MANUAL = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.DISPATCH_FORCE === '1';

/* ---------------- 时间（全部按北京时间 CST 处理） ---------------- */
const CST = 8 * 3600 * 1000;
const nowCST = () => new Date(Date.now() + CST);
const todayStr = () => TODAY_OVERRIDE || nowCST().toISOString().slice(0, 10);
const nowStr = () => nowCST().toISOString().slice(0, 16).replace('T', ' ');
const d2s = d => d.toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d2s(d); };
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const weekday = ds => new Date(ds + 'T00:00:00Z').getUTCDay(); // 0周日 6周六
const pad2 = n => String(n).padStart(2, '0');

/* ---------------- 网络 ---------------- */
async function httpGet(url, timeout = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://finance.sina.com.cn' },
      signal: ac.signal
    });
    return await r.text();
  } finally { clearTimeout(t); }
}

/** 新浪期货主力连续日线，最后一根为当日实时bar（盘中为未完结bar） */
async function fetchDaily(sym) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20d=/InnerFuturesNewService.getDailyKLine?symbol=' + sym;
  const t = await httpGet(url);
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i < 0 || j < 0) return [];
  return JSON.parse(t.slice(i, j + 1)).map(x => ({
    d: x.d, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +(x.v || 0),
    p: +(x.p || 0),            // 持仓量（月度筛池算沉淀保证金用）
    s: +(x.s || 0)             // 结算价（缺失时回退收盘价）
  })).filter(b => b.d && isFinite(b.c));
}

/** 新浪期货主力连续3分钟K线（约最近1023根，用于ATR止损宽度） */
async function fetch3min(sym) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getFewMinLine?symbol=' + sym + '&type=3';
  const t = await httpGet(url);
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i < 0 || j < 0) return [];
  return JSON.parse(t.slice(i, j + 1)).map(x => ({ d: x.d, o: +x.o, h: +x.h, l: +x.l, c: +x.c }))
    .filter(b => b.d && isFinite(b.c));
}

/** 末尾ATR(n)：用于信号止损宽度（V2优化：区极值±0.5×ATR14，回测PF 1.29→1.46） */
function atrLast(bars, n = 14) {
  if (!bars || bars.length < 2) return 0;
  let s = 0, cnt = 0;
  for (let k = Math.max(1, bars.length - n); k < bars.length; k++) {
    s += Math.max(bars[k].h - bars[k].l,
      Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
    cnt++;
  }
  return cnt ? s / cnt : 0;
}

/** 当日交易K线雏形（3分钟聚合）：昨夜夜盘(归属今日) + 今日白天。
 *  夜盘归属规则：交易日T的夜盘开在上一交易日prevTd的日历日晚21:00后（周五夜盘归属周一）；
 *  凌晨0-3点的bar（部分品种深夜盘）归属其日历日当天。 */
function partialDayBar(m3, today, prevTd) {
  if (!m3 || !m3.length) return null;
  const sel = m3.filter(b => {
    const ds = b.d.slice(0, 10), hh = +b.d.slice(11, 13);
    return (ds === today && hh >= 9) || (ds === today && hh < 3) || (ds === prevTd && hh >= 21);
  });
  if (!sel.length) return null;
  return { d: today, o: sel[0].o, h: Math.max(...sel.map(b => b.h)), l: Math.min(...sel.map(b => b.l)), c: sel[sel.length - 1].c };
}

/** 持仓估值价：优先3分钟K线最新收盘（新浪日线盘中不更新，会直接沿用昨结导致浮盈浮亏失真），失败回退日线收盘。
 *  传 contract（持仓单自己的合约）时，换月后旧合约持仓只按自己的合约序列估值，不串新主力价格 */
async function liveLastPx(sym, fallback, contract) {
  const spec = specOf(sym);
  const own = contract && contractOf(sym) !== contract;
  const cc = own ? tradeSinaCode(sym, contract) : (contractSinaCode(spec) || sym);
  try { const m3 = await fetch3min(cc); if (m3.length) return m3[m3.length - 1].c; } catch { }
  if (!own) { try { const m3 = await fetch3min(sym); if (m3.length) return m3[m3.length - 1].c; } catch { } }
  try { const b = await fetchDaily(cc); if (b.length) return b[b.length - 1].c; } catch { }
  if (!own && fallback) return fallback;
  return null;
}

/* ---------------- 指标：EMA 三色K ---------------- */
function ema(vals, n) {
  const a = 2 / (n + 1); const out = []; let e = vals[0];
  for (const v of vals) { e = a * v + (1 - a) * e; out.push(e); }
  return out;
}
function addColor(bars) {
  const c = bars.map(b => b.c);
  const e5 = ema(c, 5), e10 = ema(c, 10), e20 = ema(c, 20);
  bars.forEach((b, i) => {
    b.color = (e5[i] > e10[i] && e5[i] > e20[i]) ? 'R'
      : (e5[i] < e10[i] && e5[i] < e20[i]) ? 'G' : 'W';
  });
  return bars;
}

/* ---------------- 日线信号状态机（移植自回测引擎，日线适配版） ----------------
 * 三色K定趋势 → 首K锚定/收盘破锚确认 → 回调创新低计数 → K2触发线
 * → 日线破触发线 = 操作区激活 = K3信号（每区一次，激活即提醒）
 * 提醒后由用户在下时段用3分钟K线新鲜转色入场；创新高/低作废
 * 含：创新高作废补丁、只做第一次回调(zoneUsed)、每区最多3次信号(外层限制)
 */
function replayDaily(daily, spec) {
  addColor(daily);
  const tick = spec.tick;
  let trend = 'none', anchorR = null, anchorG = null, flip = null;
  let base = null, baseJust = false;
  let pull = { n: 0, run: null, k2: null };
  let zoneUsed = false, trig = null, zone = null;
  const signals = [];

  for (let i = 1; i < daily.length; i++) {
    const B = daily[i];
    baseJust = false;

    // 1) 趋势状态机
    if (trend === 'none') {
      if (B.color === 'R') {
        if (!anchorR) anchorR = B;
        else if (B.c > anchorR.h) {
          trend = 'long'; flip = null; base = { px: B.h, idx: i }; baseJust = true;
          pull = { n: 0, run: null, k2: null }; zoneUsed = false;
        }
      }
      if (trend === 'none' && B.color === 'G') {
        if (!anchorG) anchorG = B;
        else if (B.c < anchorG.l) {
          trend = 'short'; flip = null; base = { px: B.l, idx: i }; baseJust = true;
          pull = { n: 0, run: null, k2: null }; zoneUsed = false;
        }
      }
    } else if (trend === 'long') {
      if (B.color === 'G') {
        if (!flip) flip = B;
        else if (B.c < flip.l) {
          trend = 'short'; flip = null; base = { px: B.l, idx: i }; baseJust = true;
          pull = { n: 0, run: null, k2: null }; zoneUsed = false; trig = null; zone = null;
        }
      } else if (B.color === 'R') flip = null;
    } else {
      if (B.color === 'R') {
        if (!flip) flip = B;
        else if (B.c > flip.h) {
          trend = 'long'; flip = null; base = { px: B.h, idx: i }; baseJust = true;
          pull = { n: 0, run: null, k2: null }; zoneUsed = false; trig = null; zone = null;
        }
      } else if (B.color === 'G') flip = null;
    }

    // 2) 创新高作废补丁：触发线未激活时创新高/低，重置基准与回调计数
    if (trig && !zoneUsed && base &&
      ((trend === 'long' && B.h > base.px) || (trend === 'short' && B.l < base.px))) {
      trig = null;
      base = { px: trend === 'long' ? B.h : B.l, idx: i };
      pull = { n: 0, run: null, k2: null };
    }

    // 3) 回调计数与K2形成（平底合并：不创新低/高的bar跳过）
    if ((trend === 'long' || trend === 'short') && !zoneUsed && !trig && !baseJust && base) {
      if (trend === 'long') {
        if (B.h > base.px) { base = { px: B.h, idx: i }; pull = { n: 0, run: null, k2: null }; }
        else if (pull.run === null || B.l < pull.run) {
          pull.run = B.l; pull.n++;
          if (pull.n === 2) pull.k2 = B;
        }
      } else {
        if (B.l < base.px) { base = { px: B.l, idx: i }; pull = { n: 0, run: null, k2: null }; }
        else if (pull.run === null || B.h > pull.run) {
          pull.run = B.h; pull.n++;
          if (pull.n === 2) pull.k2 = B;
        }
      }
      if (pull.k2 && !trig) trig = trend === 'long' ? pull.k2.l : pull.k2.h;
    }

    // 4) 触发：本bar破K2极值 → 激活操作区（K2形成当日不可能自破，天然滞后一根）
    if (trig && !zone && !zoneUsed && (trend === 'long' || trend === 'short')) {
      if (trend === 'long' && B.l < trig) {
        zone = { dir: 'long', seg: B.l, born: B.d, trigPx: trig, justBorn: true };
        zoneUsed = true; trig = null;
      } else if (trend === 'short' && B.h > trig) {
        zone = { dir: 'short', seg: B.h, born: B.d, trigPx: trig, justBorn: true };
        zoneUsed = true; trig = null;
      }
    }

    // 5) 操作区内：作废判定 + 激活即信号（每区一次）+ 跟踪极值
    if (zone) {
      if (trend !== zone.dir) zone = null;
      else if (zone.dir === 'long' && base && B.h > base.px) zone = null;   // 创新高作废
      else if (zone.dir === 'short' && base && B.l < base.px) zone = null;
      else {
        zone.seg = zone.dir === 'long' ? Math.min(zone.seg, B.l) : Math.max(zone.seg, B.h);
        if (zone.justBorn) {
          // 操作区激活 = K3信号：提醒用户"下一时段起盯3分钟K线新鲜转色入场"
          // （先通过作废判定再发信号，保证信号发出时操作区仍有效）
          zone.justBorn = false;
          const ref = B.c;
          const stop = zone.dir === 'long' ? zone.seg - 3 * tick : zone.seg + 3 * tick;
          const R = zone.dir === 'long' ? ref - stop : stop - ref;
          // 逆色激活过滤（2026-10-21，settings.filter_opp_color）：激活当根bar收反向色
          // （多头信号收绿/空头信号收红）不生成信号——破位当天日线已转反向，多为下跌/上涨启动而非回调结束。
          // 一年回测：逆色激活31信号/23笔 胜率17.4%/PF0.97/净-196元（菜粕RM701 2026-10-20即此类）；
          // 过滤后整体胜率37.7%→42.4%，PF1.64→1.86，净盈亏+15766→+15962元。
          const oppColor = (zone.dir === 'long' && B.color === 'G') || (zone.dir === 'short' && B.color === 'R');
          if (R > 0 && !(SETTINGS.filter_opp_color && oppColor)) {
            signals.push({
              date: B.d, dir: zone.dir, kind: 'activate',
              zoneId: `${zone.born}|${zone.dir}|${zone.trigPx}`,
              ref, stop, R,
              t3: zone.dir === 'long' ? ref + 3 * R : ref - 3 * R,
              t5: zone.dir === 'long' ? ref + 5 * R : ref - 5 * R,
              seg: zone.seg,
              voidPx: base ? base.px : null   // 作废基准：多头创新高/空头创新低即失效
            });
          }
        }
      }
    }
  }
  return {
    signals, bars: daily,
    // 供"未来三日展望"使用：pullN/pullRun=回调进度，zone=当前存活操作区
    term: {
      trend, base, trig, zoneUsed,
      pullN: pull.n, pullRun: pull.run,
      zone: zone ? { dir: zone.dir, seg: zone.seg, born: zone.born, trigPx: zone.trigPx } : null
    }
  };
}

/* ---------------- 未来 N 个交易日信号展望（收盘日报用） ----------------
 * 依据 K3 段内进度推算每个品种"最快还要几步才能出信号"及对应点位：
 *   已激活(zone)      → 等 3 分钟转色入场，T+0
 *   已有触发线(trig)  → 破位即激活，T+1
 *   回调 n≥1 无 trig  → 先创新极值形成触发线，再破位，T+2
 *   回调 n=0          → 需三步，T+3（仅列示最接近的）
 * 段内额度已用(zoneUsed)的品种在趋势翻转前无资格，单独计数不列示。
 */
async function tradingDaysAfter(d, n) {
  const out = [];
  let x = d;
  for (let i = 0; i < n; i++) { x = await nextTradingDay(x); out.push(x); }
  return out;
}
async function forecastWindow(today, horizon = 3) {
  const dates = await tradingDaysAfter(today, horizon);
  const rows = [], active = [];
  let usedCnt = 0, failCnt = 0;
  for (const spec of POOL) {
    let bars;
    try { bars = await fetchDailySmart(spec); } catch (e) { failCnt++; continue; }
    if (!bars || bars.length < SETTINGS.min_history) { failCnt++; continue; }
    let term;
    try { ({ term } = replayDaily(bars.map(b => ({ ...b })), spec)); } catch (e) { failCnt++; continue; }
    if (!term || (term.trend !== 'long' && term.trend !== 'short')) continue;
    const last = bars[bars.length - 1];
    const dir = term.trend === 'long' ? 'long' : 'short';   // 多头段回调做多／空头段反弹做空

    if (term.zone) {
      // 超期作废：有效期 = 激活日次一交易日收盘，超过即失去入场资格
      const zExpiry = await nextTradingDay(term.zone.born);
      if (today > zExpiry) { usedCnt++; continue; }
      active.push({
        name: spec.name, contract: spec.contract, dir: term.zone.dir,
        seg: term.zone.seg, born: term.zone.born, expiry: zExpiry
      });
      continue;
    }
    if (term.zoneUsed) { usedCnt++; continue; }

    let eta, gate, stage;
    if (term.trig) { eta = 1; gate = term.trig; stage = '破位即激活'; }
    else if ((term.pullN || 0) >= 1) { eta = 2; gate = term.pullRun; stage = '先形成触发线'; }
    else { eta = 3; gate = null; stage = '需攒两段回调'; }
    if (eta > horizon) continue;

    // 门槛方向：空头段需向上突破（正幅度），多头段需向下破位（负幅度）
    const need = gate == null ? null : (dir === 'short' ? gate - last.c : last.c - gate);
    if (need != null && need < 0) continue;   // 已越过门槛（等下一根确认），保险跳过
    const pct = need == null ? null : (dir === 'short' ? 100 * need / last.c : -100 * need / last.c);
    rows.push({
      name: spec.name, contract: spec.contract, dir, eta, gate, stage,
      close: last.c, pct, etaDate: dates[eta - 1]
    });
  }
  // 先按最快出信号日，再按距门槛的绝对幅度（方向无关）
  const absPct = r => r.pct == null ? 9e9 : Math.abs(r.pct);
  rows.sort((a, b) => (a.eta - b.eta) || (absPct(a) - absPct(b)));
  return { rows, active, usedCnt, failCnt, dates };
}
function fmtForecast(fc, today) {
  if (!fc) return '';
  const L = [];
  L.push(`**未来${fc.dates.length}个交易日信号展望**（截至 ${today} 收盘，按最快出信号日排序）`);
  if (fc.active.length) {
    L.push('', `**已激活·待入场（${fc.active.length}）**：` + fc.active.map(a =>
      `${a.name} ${a.contract} ${a.dir === 'long' ? '多' : '空'}（${a.born} 激活，损基 ${a.seg}，有效期至 ${a.expiry} 收盘）`).join('；') +
      '　→ 切 3 分钟图等新鲜转色入场');
  }
  if (fc.rows.length) {
    L.push('');
    for (const r of fc.rows.slice(0, 8)) {
      const mark = r.gate == null ? '' : (r.dir === 'short' ? `H>${r.gate}` : `L<${r.gate}`);
      const dist = r.pct == null ? '—' : `${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}%`;
      L.push(`${r.eta === 1 ? '①' : r.eta === 2 ? '②' : '③'} ${r.name} ${r.contract}｜${r.dir === 'long' ? '回调做多' : '反弹做空'}｜${r.stage} ${mark}（${dist}）→ 最快 ${r.etaDate}`);
    }
  } else {
    L.push('', '全池无品种在窗口内具备出信号条件（均在额度已用或需重新攒回调）');
  }
  L.push('', `段内额度已用 ${fc.usedCnt} 个：翻段前无资格。破位当日收反向色不发信号（逆色过滤）；创新低/高会重置段并清零回调计数。`);
  return L.join('\n');
}

/* ---------------- 交易日历（静态日历优先 → timor.tech + 本地缓存 → 兜底周一至周五） ----------------
 * 2026-10 教训：GitHub Actions（海外节点）访问 timor.tech（国内接口）不稳定，
 * API 失败后兜底逻辑会把"工作日遇法定节假日"（如10月1日周四/2日周五）误判为交易日并发出心跳。
 * 故引入 config/holidays_static.json 静态年度日历作为最高优先级，覆盖期内完全不依赖网络。 */
let HOLIDAYS = readJson(J('data/holidays.json'), {});
const STATIC_CAL = readJson(J('config/holidays_static.json'), null);
async function holidayType(ds) {
  // ① 静态日历（覆盖期内的权威来源）
  if (STATIC_CAL && ds >= STATIC_CAL.from && ds <= STATIC_CAL.to) {
    const wd0 = weekday(ds);
    const staticVerdict = (STATIC_CAL.holidays && STATIC_CAL.holidays[ds]) ? 2
      : ((wd0 === 0 || wd0 === 6) ? 1 : 0);
    const predicted = STATIC_CAL.predicted_from && ds >= STATIC_CAL.predicted_from;
    if (!predicted) return staticVerdict;                    // 官方数据区：直接采用
    // 预测区（2027年，正式安排发布前）：在线API单向佐证——仅当API明确返回节假日时采信，
    // 否则以静态预测为准（API未收录次年安排前会对节假日误报工作日，不可信）
    try {
      const t = await httpGet('https://timor.tech/api/holiday/info/' + ds, 10000);
      const j = JSON.parse(t);
      if (j && j.type && j.type.type === 2) return 2;
    } catch { /* 网络失败，用静态预测 */ }
    return staticVerdict;
  }
  // ② 本地缓存（仅保存 API 权威结果）
  if (HOLIDAYS[ds] !== undefined) return HOLIDAYS[ds];
  // ③ 在线 API
  let type = null;
  try {
    const t = await httpGet('https://timor.tech/api/holiday/info/' + ds, 10000);
    const j = JSON.parse(t);
    if (j && j.type && typeof j.type.type === 'number') type = j.type.type; // 0工作日 1周末 2节假日 3调休
  } catch { /* 网络失败 */ }
  if (type === null) {
    // ④ 兜底：周一至周五视为工作日。【不写缓存】——兜底不是权威结果，持久化会污染后续运行
    return (weekday(ds) >= 1 && weekday(ds) <= 5) ? 0 : 1;
  }
  HOLIDAYS[ds] = type;
  return type;
}
/** 期货交易日：周一至周五 且 非法定节假日（周六调休工作日也不开盘） */
async function isTradingDay(ds) {
  if (FORCE_TD) return true;
  const wd = weekday(ds);
  if (wd === 0 || wd === 6) return false;
  const t = await holidayType(ds);
  return t !== 2;
}
async function nextTradingDay(ds) {
  let d = addDays(ds, 1);
  for (let k = 0; k < 20; k++) {
    if (await isTradingDay(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}
/** 上一交易日（ morning 提醒时段等待前一夜盘扫描时使用） */
async function prevTradingDay(ds) {
  let d = addDays(ds, -1);
  for (let k = 0; k < 20; k++) {
    if (await isTradingDay(d)) return d;
    d = addDays(d, -1);
  }
  return d;
}
/** 禁提醒日：手工黑名单 或 重大假日前一交易日（距下一交易日≥4天且间隔内含法定节假日） */
async function isBlackout(ds) {
  if (BLACKOUT.dates && BLACKOUT.dates[ds]) return BLACKOUT.dates[ds];
  const nxt = await nextTradingDay(ds);
  if (dayDiff(ds, nxt) >= 4) {
    for (let d = addDays(ds, 1); d < nxt; d = addDays(d, 1)) {
      if (await holidayType(d) === 2) return `重大假日前一交易日（下一交易日${nxt}）`;
    }
  }
  return null;
}

/* ---------------- 合约换月（交割月前一月1日切换） ---------------- */
function parseContract(spec, code) {
  const digits = code.slice(spec.prefix.length);
  if (spec.exch === 'czce') return { y: 2020 + +digits[0], m: +digits.slice(1) };
  return { y: 2000 + +digits.slice(0, 2), m: +digits.slice(2) };
}
function fmtContract(spec, y, m) {
  return spec.exch === 'czce'
    ? spec.prefix + (y % 10) + pad2(m)
    : spec.prefix + pad2(y % 100) + pad2(m);
}
/** 新浪具体合约代码：一律4位年（郑商所官方3位码 FG701 仅用于展示，新浪接口只认 FG2701） */
const fetchCode = (spec, y, m) => spec.prefix + pad2(y % 100) + pad2(m);
function nextInCycle(spec, y, m) {
  const ms = spec.months;
  const i = ms.indexOf(m);
  return i >= 0 && i < ms.length - 1 ? { y, m: ms[i + 1] } : { y: y + 1, m: ms[0] };
}
const rolloverDate = (y, m) => m === 1 ? `${y - 1}-12-01` : `${y}-${pad2(m - 1)}-01`;

/** 名义交割日 = 交割月15日（各所最后交易日近似，用于筛池口径） */
const deliveryDate = (y, m) => `${y}-${pad2(m)}-15`;
/**
 * 挑选代表合约：months 周期中"距名义交割日 ≥ minDays 天"的最近一档；
 * 若最近一档不足 minDays 天（含主力交割<59天的情形），自动顺延下一档。
 * 返回 { y, m, code, days }
 */
function pickContract(spec, today, minDays) {
  const ms = (spec.months || [1, 5, 9]).slice().sort((a, b) => a - b);
  let y = +today.slice(0, 4), m0 = +today.slice(5, 7);
  for (let round = 0; round < 3; round++) {          // 最多向后找3年
    for (const m of ms) {
      if (round === 0 && m < m0) continue;           // 今年只找当月及以后
      const days = dayDiff(today, deliveryDate(y, m));
      if (days >= minDays) return { y, m, code: fmtContract(spec, y, m), days };
    }
    y++; m0 = 1;
  }
  const m = ms[0];                                    // 兜底（不应到达）
  return { y, m, code: fmtContract(spec, y, m), days: dayDiff(today, deliveryDate(y, m)) };
}
/** 新品种入池时的合约条目初始化（与 pickContract 同一口径） */
function initContract(spec, today, minDays = 60) {
  const c = pickContract(spec, today, minDays);
  const nxt = nextInCycle(spec, c.y, c.m);
  return { main: c.code, next: fmtContract(spec, nxt.y, nxt.m), rollover: rolloverDate(c.y, c.m) };
}

function advanceContracts(today) {
  let changed = false;
  for (const spec of POOL) {
    let c = CONTRACTS[spec.code];
    if (!c) continue;
    let guard = 0;
    while (today >= c.rollover && guard++ < 12) {
      const cur = parseContract(spec, c.next);
      const nxt = nextInCycle(spec, cur.y, cur.m);
      c = CONTRACTS[spec.code] = {
        main: c.next,
        next: fmtContract(spec, nxt.y, nxt.m),
        rollover: rolloverDate(cur.y, cur.m)
      };
      changed = true;
      console.log(`  换月 ${spec.name}: main=${c.main} next=${c.next} rollover=${c.rollover}`);
    }
  }
  if (changed) writeJson(J('config/contracts.json'), CONTRACTS);
  return changed;
}
const contractOf = code => (CONTRACTS[code] && CONTRACTS[code].main) || code;

/* ---------------- 具体合约取数（2026-10-14 修复） ----------------
 * 背景：主连C0是未复权拼接序列，换月后与具体合约价格系统性偏离（玉米同日差30点），
 * 导致状态机信号与用户实际交易/看图的C2701口径不一致。统一改为具体合约优先、主连兜底。 */
const specOf = sym => POOL.find(s => s.code === sym) || SPEC[sym];
/** 品种当前主力合约的新浪取数码（如 C0→C2701、CF0→CF2701），无映射时返回原码 */
function contractSinaCode(spec) {
  if (!spec) return null;
  const c = contractOf(spec.code);
  if (!c || c === spec.code) return spec.code;
  try { const { y, m } = parseContract(spec, c); return fetchCode(spec, y, m); } catch { return spec.code; }
}
/** 日线：先取具体合约，数据不足20根（新合约历史短）回退主连 */
async function fetchDailySmart(spec) {
  const cc = contractSinaCode(spec);
  if (cc && cc !== spec.code) {
    try { const b = await fetchDaily(cc); if (b.length >= 20) return b; } catch { }
  }
  return fetchDaily(spec.code);
}
/** 持仓单自己的合约（展示码如 UR701）→ 新浪取数码（UR2701）：换月后旧合约持仓仍按自己的合约跟踪 */
function tradeSinaCode(sym, contract) {
  const spec = specOf(sym);
  if (!spec || !contract) return contractSinaCode(spec);
  try { const { y, m } = parseContract(spec, contract); return fetchCode(spec, y, m); } catch { return contractSinaCode(spec); }
}
/** 报价网格取整：按品种最小变动价位（玉米1点/铁矿0.5/PTA 2点/棉花5点…）。
 *  止损用保守方向（空头向上取整、多头向下取整——离入场更远，R只增不减）；入场价与R均为网格倍数时3R/5R自动落网格 */
function gridRound(px, tick, dir) {
  if (!tick || !isFinite(px)) return px;
  const eps = 1e-9;
  const v = dir === 'short' ? Math.ceil(px / tick - eps) : Math.floor(px / tick + eps);
  return Math.round(v * tick * 100) / 100;
}

/** 单手单边手续费（元）= 固定值 或 成交金额×比例，再乘券商系数 fee_mult */
function feePerLot(spec, price) {
  const fix = spec.fee_fix || 0;
  const rate = spec.fee_rate ? price * spec.mult * spec.fee_rate : 0;
  return (fix + rate) * (SETTINGS.fee_mult || 1);
}

/* ---------------- 飞书 ---------------- */
function feishuSign() {
  if (!FSECRET) return {};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const s = timestamp + '\n' + FSECRET;
  const sign = crypto.createHmac('sha256', s).update('').digest('base64');
  return { timestamp, sign };
}
async function feishuSend(card) {
  const body = JSON.stringify({ msg_type: 'interactive', card, ...feishuSign() });
  if (!WEBHOOK) {
    console.log('  [DRY-RUN 飞书]', body.slice(0, 400));
    return true;
  }
  try {
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const j = await r.json();
    if (j.code !== 0 && j.StatusCode !== 0) { console.log('  飞书发送失败:', body.slice(0, 120), JSON.stringify(j)); return false; }
    return true;
  } catch (e) { console.log('  飞书发送异常:', e.message); return false; }
}
const ftext = (content) => ({ tag: 'div', text: { tag: 'lark_md', content } });
function cardSignal(p, expiry, prio) {
  const dirTxt = p.dir === 'long' ? "<font color='red'>做多 ↑</font>" : "<font color='green'>做空 ↓</font>";
  const colorTxt = p.dir === 'long' ? '转红(R)' : '转绿(G)';
  const els = [
    ftext(`**品种合约**：${p.name} ${p.contract}\n**开仓方向**：${dirTxt}\n**建议手数**：${p.lots} 手`),
    ftext(`**参考价**：${p.ref}（${p.date} 触发时价）\n**止损点位**：${p.stop}（操作区极值±0.5×ATR14，1R=${p.R}点≈${Math.round(p.R * p.mult)}元/手）\n**3R点位**：${p.t3}\n**5R点位**：${p.t5}`),
    ftext(`**操作**：从下一交易时段起盯3分钟K线——出现新鲜${colorTxt}即可入场；一直未转色、或收到"设置作废"通知，则放弃\n信号编号 **#${p.id}**｜反馈有效期至 **${expiry || '?'} 15:00**\n入场后到 GitHub 置顶 Issue 回复：\n**成交 #${p.id}** [实际价] [手数]　或　**未入场 #${p.id}**`)
  ];
  if (prio) {
    const tag = prio.rank === 1 ? '★ 建议优先' : `第 ${prio.rank} 顺位`;
    els.splice(1, 0, ftext(`**⚠ 本时段共 ${prio.total} 个信号并存**：${p.name}、${p.peers}\n**优先级**：${tag}${prio.conflicts ? '（与并存信号/持仓同板块，降级）' : ''}｜单手止损风险 ≈ ${prio.risk1} 元\n资金有限时可只做优先信号，其余回复"未入场"即可，不算违规`));
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'indigo', title: { tag: 'plain_text', content: `【擒龙手】K3操作区激活 ${p.name} ${p.contract}` } },
    elements: [...els,
      { tag: 'note', elements: [{ tag: 'lark_md', content: `纪律：ATR止损｜3R平半推保本余仓追5R/反向变色｜单手版3R锁+2R｜多个信号并存时回复务必带 #编号` }] }
    ]
  };
}
/** 跟进提醒卡（2026-10-15）：已提醒但未收到成交/未入场反馈的信号，在提醒日之后的交易日重发一次 */
function cardFollowup(p, px, expiry) {
  const dirTxt = p.dir === 'long' ? "<font color='red'>做多 ↑</font>" : "<font color='green'>做空 ↓</font>";
  const colorTxt = p.dir === 'long' ? '转红(R)' : '转绿(G)';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `【擒龙手】信号跟进提醒 ${p.name} ${p.contract}` } },
    elements: [
      ftext(`**信号 #${p.id}** 已于 ${p.reminded_at || p.created || '—'} 推送，**尚未收到您的反馈**。\\n若错过首张卡片，以下为完整信息：`),
      ftext(`**品种合约**：${p.name} ${p.contract}\\n**开仓方向**：${dirTxt}\\n**建议手数**：${p.lots} 手`),
      ftext(`**原参考价**：${p.ref}｜**止损**：${p.stop}（1R=${p.R}点≈${Math.round((p.R || 0) * p.mult)}元/手）\\n**3R**：${p.t3}｜**5R**：${p.t5}\\n**当前价**：${px ?? '—'}｜**作废基准**：${p.void_px ?? '—'}`),
      ftext(`**操作**：信号仍有效时，盯3分钟K线出现新鲜${colorTxt}即可入场\\n**反馈有效期至**：${expiry || '?'} 15:00（价格${p.dir === 'long' ? '创新高' : '创新低'}破 ${p.void_px ?? '—'} 将自动作废）\\n请在 GitHub 置顶 Issue 回复：\\n**成交 #${p.id}** [实际价] [手数]　或　**未入场 #${p.id}**`),
      { tag: 'note', elements: [{ tag: 'lark_md', content: `纪律：ATR止损｜3R平半推保本余仓追5R/反向变色｜单手版3R锁+2R｜回复务必带 #编号` }] }
    ]
  };
}
function cardVoid(p, reason) {
  const isStop = reason === 'stop';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `【擒龙手】${isStop ? '止损破位作废' : '设置作废'} ${p.name} ${p.contract}` } },
    elements: [
      ftext(isStop
        ? `信号 **#${p.id}**（${p.name} ${p.contract} ${p.dir === 'long' ? '多' : '空'}）**尚未入场**，但价格已破止损位 **${p.stop}**（${p.dir === 'long' ? '跌破' : '涨破'}）。未入场即破止损，继续等待入场将致 R<0，信号失效。\n**请勿再按此信号入场**。`
        : `信号 **#${p.id}**（${p.name} ${p.contract} ${p.dir === 'long' ? '多' : '空'}）操作区已失效：价格${p.dir === 'long' ? '创新高' : '创新低'}突破基准 **${p.void_px}**。\n**请勿再按此信号入场**；若已入场，按原止损纪律执行不受影响。`),
      { tag: 'note', elements: [{ tag: 'lark_md', content: '该信号已关闭，之后的成交/未入场回复不再受理' }] }
    ]
  };
}
function cardFbAck(title, lines, template) {
  return {
    config: { wide_screen_mode: true },
    header: { template: template || 'green', title: { tag: 'plain_text', content: title } },
    elements: [ftext(lines.join('\n'))]
  };
}
function cardTouch(t, label, px, extra) {
  const tk = (SPEC[t.sym] && SPEC[t.sym].tick) || 1;   // 价格按品种tick格式化，去浮点长尾
  return {
    config: { wide_screen_mode: true },
    header: { template: 'indigo', title: { tag: 'plain_text', content: `【擒龙手】到位提醒 ${t.name} ${t.contract}` } },
    elements: [
      ftext(`**${t.name} ${t.contract} 目前已达到${label}点位 ${fmtPx(px, tk)}**\n方向：${t.dir === 'long' ? '多' : '空'}｜入场 ${fmtPx(t.entry, tk)}｜${t.lots} 手${extra ? '\n' + extra : ''}`),
      { tag: 'note', elements: [{ tag: 'lark_md', content: `单号 ${t.id}｜按信号价自动记账，实际不同请到置顶 Issue 回复：平仓 ${t.id} 实际价` }] }
    ]
  };
}
const SLOT_NAME = { noon: '午间', evening: '晚间', night: '早盘' };
function cardHeartbeat(slot, info) {
  const lines = [`**${info.today} ${SLOT_NAME[slot] || slot}时段无入场信号**，系统运行正常。`];
  lines.push(`账户权益 ≈ **${info.equity}** 元｜当前持仓 **${info.opens}** 笔`);
  if (info.lastScan) lines.push(`最近扫描：${info.lastScan}`);
  if (info.blackout) lines.push(`⚠ 今日为禁提醒日：${info.blackout}（持仓止损/3R/5R 提醒不受影响）`);
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `【擒龙手】心跳 · ${SLOT_NAME[slot] || slot}时段无信号` } },
    elements: [
      ftext(lines.join('\n')),
      { tag: 'note', elements: [{ tag: 'lark_md', content: '低频策略属正常现象，年均信号仅几十笔。不想收心跳可在 config/settings.json 设 "heartbeat": false' }] }
    ]
  };
}

/* ---------------- 账本 / 净值 ---------------- */
function equityNow(ledger, lastPx = {}) {
  let eq = ledger.capital;
  for (const t of ledger.trades) {
    if (t.status === 'closed') eq += t.pnl;
    else {
      eq += (t.realized || 0) - (t.fees || 0);
      const lp = lastPx[t.sym];
      if (lp) eq += (t.dir === 'long' ? lp - t.entry : t.entry - lp) * t.mult * t.lots;
    }
  }
  return Math.round(eq * 100) / 100;
}
/** 保证金率 = 交易所标准(spec.rate) + 期货公司加点（固定值，不考虑交易所临时调整）
 *  2026-10-14 用户定口径：统一按交易所标准+1.5个百分点统计保证金（settings.margin_broker_add） */
function marginRate(spec) { return spec.rate + (SETTINGS.margin_broker_add || 0); }
/** 价格按品种最小变动价位格式化显示（去掉浮点长尾，如玉米2148.4199…→2148）。tick>=1取整，0.5留1位，其余留2位。仅用于展示，不改账本原值 */
function fmtPx(v, tick) {
  if (v == null || !isFinite(+v)) return '-';
  const dec = tick >= 1 ? 0 : (tick >= 0.5 ? 1 : 2);
  return (+v).toFixed(dec);
}
/** 手数=以损定量：max(1, floor(权益×risk_pct/单手风险))，且多手时总保证金+已持仓保证金 ≤ 权益×margin_cap
 *  2026-10-16 增补 usedMargin：第二仓起扣除已持仓占用的保证金，避免双仓保证金超缴 */
function computeLots(equity, R, mult, margin1, usedMargin = 0) {
  const budget = SETTINGS.risk_pct * equity;
  let lots = Math.max(1, Math.floor(budget / (R * mult)));
  while (lots > 1 && margin1 * lots + usedMargin > SETTINGS.margin_cap * equity) lots--;
  return lots;
}

/* ---------------- 同时段多信号优先级（2026-10-16） ----------------
 * 数据结论（21品种一年3分钟回测）：碰撞仅约15%的提醒时段；任何规则与随机的差距在噪声范围内，
 * 但结构性原则有效：同板块品种≈同命运（只取一）、小止损/小保证金略优且不劣于随机、避免"先到先得"。
 * 评分（低者优先）：同板块冲突×10 + 单手止损风险排名 + 单手保证金排名 */
const SECTOR = {
  I: '黑色', HC: '黑色', RB: '黑色',
  L: '塑化', PP: '塑化', V: '塑化', EG: '塑化', TA: '塑化',
  SA: '化工', FG: '化工', MA: '化工', UR: '化工',
  M: '油脂', Y: '油脂', P: '油脂', RM: '油脂', OI: '油脂',
  SR: '软商品', CF: '软商品', CJ: '软商品', C: '谷物'
};
const sectorOf = code => SECTOR[String(code).slice(0, -1)] || '其他';
/** items: 同一提醒时段待推送的信号；openTrades: 当前持仓。返回 Map(id → {rank,total,peers,reason}) */
function slotPriority(items, openTrades) {
  const out = new Map();
  const n = items.length;
  if (n < 2) return out;
  const risk = p => Math.round((p.R || 0) * (p.mult || 1));      // 单手止损风险(元)
  const mgn = p => p.margin1 || 0;
  const rankMap = (key) => {
    const s = [...items].sort((a, b) => key(a) - key(b));
    return new Map(s.map((x, i) => [x.id, i]));
  };
  const rkRisk = rankMap(risk), rkMgn = rankMap(mgn);
  const openSectors = (openTrades || []).map(t => sectorOf(t.sym));
  const score = new Map();
  for (const p of items) {
    const sec = sectorOf(p.sym);
    const conflicts = items.filter(x => x !== p && sectorOf(x.sym) === sec).length
      + openSectors.filter(s => s === sec).length;
    score.set(p.id, conflicts * 10 + (rkRisk.get(p.id) || 0) + (rkMgn.get(p.id) || 0));
  }
  const order = [...items].sort((a, b) => score.get(a.id) - score.get(b.id));
  order.forEach((p, i) => {
    const conflicts = Math.floor(score.get(p.id) / 10);
    out.set(p.id, {
      rank: i + 1, total: n,
      peers: items.filter(x => x.id !== p.id).map(x => x.name).join('、'),
      risk1: risk(p), conflicts
    });
  });
  return out;
}
function closeTrade(t, px, date, reason) {
  const spec = SPEC[t.sym];
  const sgn = t.dir === 'long' ? 1 : -1;
  // 平仓侧手续费入账后，按净额结算本单盈亏
  t.fees = Math.round(((t.fees || 0) + feePerLot(spec, px) * t.lots) * 100) / 100;
  t.pnl = Math.round(((t.realized || 0) + (px - t.entry) * sgn * t.mult * t.lots - t.fees) * 100) / 100;
  t.status = 'closed';
  t.exit_date = date;
  t.exit_px = px;
  t.reason = reason;
}

/** 持仓到位检查：止损/3R/5R/反向变色（3R后启用变色离场） */
async function checkPositions(ledger, barCache, today) {
  const notes = [];
  for (const t of ledger.trades) {
    if (t.status !== 'open') continue;
    let bars = barCache.get(t.sym);
    if (t.contract && contractOf(t.sym) !== t.contract) {
      // 换月后旧合约持仓：按持仓单自己的合约取日线，止损/3R/5R/变色判定不串新主力价格
      try { const own = await fetchDaily(tradeSinaCode(t.sym, t.contract)); if (own.length) { addColor(own); bars = own; } } catch { }
    }
    if (!bars || !bars.length) continue;
    const B = bars[bars.length - 1];
    const spec = SPEC[t.sym];
    const sgn = t.dir === 'long' ? 1 : -1;
    const hitStop = t.dir === 'long' ? B.l <= t.stop : B.h >= t.stop;
    const hitT3 = t.dir === 'long' ? B.h >= t.t3 : B.l <= t.t3;
    const hitT5 = t.dir === 'long' ? B.h >= t.t5 : B.l <= t.t5;
    const flipColor = t.dir === 'long' ? B.color === 'G' : B.color === 'R';

    if (!t.half_done) {
      if (hitStop) {  // 保守：同bar同时触及止损与3R按止损计
        closeTrade(t, t.stop, B.d, '止损');
        await feishuSend(cardTouch(t, '止损', t.stop, `本单亏损 ${t.pnl} 元`));
        notes.push(`${t.name} 止损 ${t.pnl}`);
      } else if (hitT3) {
        if (t.lots0 === 1) {  // 单手追踪版：3R后止损上移至+2R，余仓追5R/变色
          t.half_done = true; t.stop = t.entry + 2 * sgn * t.R;
          await feishuSend(cardTouch(t, '3R', t.t3, '单手追踪：止损已上移至锁盈 +2R（' + t.stop + '），余仓追5R或反向变色'));
          notes.push(`${t.name} 3R（单手锁盈）`);
        } else {              // 师姐方案：3R平一半，余仓止损推保本
          const h = Math.max(1, Math.floor(t.lots / 2));
          t.realized = Math.round(((t.realized || 0) + 3 * t.R * spec.mult * h) * 100) / 100;
          t.fees = Math.round(((t.fees || 0) + feePerLot(spec, t.t3) * h) * 100) / 100;
          t.lots -= h; t.half_done = true; t.stop = t.entry;
          await feishuSend(cardTouch(t, '3R', t.t3, `已按纪律平 ${h} 手锁定 +${3 * t.R * spec.mult * h} 元，余 ${t.lots} 手止损推保本，追5R/变色`));
          notes.push(`${t.name} 3R 平半`);
        }
      }
    } else {
      if (hitStop) {
        closeTrade(t, t.stop, B.d, t.stop === t.entry ? '保本出' : '锁盈出');
        await feishuSend(cardTouch(t, t.reason === '保本出' ? '保本(移动止损)' : '锁盈止损', t.stop, `本单合计 ${t.pnl} 元`));
        notes.push(`${t.name} ${t.reason} ${t.pnl}`);
      } else if (hitT5) {
        closeTrade(t, t.t5, B.d, '5R止盈');
        await feishuSend(cardTouch(t, '5R', t.t5, `本单合计 ${t.pnl} 元`));
        notes.push(`${t.name} 5R止盈 ${t.pnl}`);
      } else if (flipColor) {
        closeTrade(t, B.c, B.d, '反向变色');
        await feishuSend(cardTouch(t, '反向变色离场', B.c, `本单合计 ${t.pnl} 元`));
        notes.push(`${t.name} 变色离场 ${t.pnl}`);
      }
    }
  }
  return notes;
}

/* ---------------- 净值面板 docs/（多页静态存档） ----------------
 * index.html=全部，year-YYYY.html=单年存档，顶部 tab 互链，纯静态无需前端JS（GitHub Pages 直接支持）。
 * 年度口径（2026-10-21 需求）：每年收益率相对"该年1月1日起始资金"（=上一年最后一个净值点，最早一年=初始本金）。
 */
function yearOf(d) { return String(d).slice(0, 4); }
function yearBase(nav, capital, year) {
  const before = nav.filter(p => p.d < year + '-01-01');
  return before.length ? before[before.length - 1].equity : capital;
}
/** 净值曲线SVG：纵轴网格状百分比刻度（相对该页起始资金），横轴具体日期刻度 */
function renderChartSVG(navData, base) {
  const W = 940, H = 300, LP = 52, RP = 16, TP = 18, BP = 34;
  if (!navData.length) return '<div style="color:#999;padding:24px;text-align:center">该区间暂无净值数据</div>';
  const pw = W - LP - RP, ph = H - TP - BP;
  const pcts = navData.map(p => 100 * (p.equity - base) / base);
  let pMin = Math.min(...pcts, 0), pMax = Math.max(...pcts, 0);
  if (pMax - pMin < 0.5) { pMax += 0.25; pMin -= 0.25; }
  const niceStep = (range, n) => { const raw = range / n; const mag = Math.pow(10, Math.floor(Math.log10(raw))); const nm = raw / mag; return (nm >= 5 ? 10 : nm >= 2 ? 5 : nm >= 1 ? 2 : 1) * mag; };
  const step = niceStep(pMax - pMin, 5);
  const x = i => LP + pw * (navData.length === 1 ? 0.5 : i / (navData.length - 1));
  const y = pc => TP + ph * (1 - (pc - pMin) / (pMax - pMin));
  let g = '';
  for (let pc = Math.ceil(pMin / step - 1e-9) * step; pc <= pMax + 1e-9; pc += step) {   // 网格线+纵轴百分比
    const yy = y(pc), is0 = Math.abs(pc) < step / 100;
    g += `<line x1="${LP}" y1="${yy.toFixed(1)}" x2="${W - RP}" y2="${yy.toFixed(1)}" stroke="${is0 ? '#bbb' : '#eee'}" stroke-width="${is0 ? 1.4 : 1}"${is0 ? '' : ' stroke-dasharray="3 3"'}/>`;
    g += `<text x="${LP - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${is0 ? '#888' : '#aaa'}">${pc > 0 ? '+' : ''}${(+pc.toFixed(2))}%</text>`;
  }
  const nL = Math.min(6, navData.length);   // 横轴日期刻度（最多6个均布）
  for (let k = 0; k < nL; k++) {
    const i = Math.round(k * (navData.length - 1) / ((nL - 1) || 1));
    g += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#999">${navData[i].d.slice(5)}</text>`;
  }
  const path = navData.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pcts[i]).toFixed(1)}`).join(' ');
  g += `<path d="${path}" fill="none" stroke="#c23531" stroke-width="2"/>`;
  g += navData.map((p, i) => { const rp = pcts[i].toFixed(1); return `<circle cx="${x(i).toFixed(1)}" cy="${y(pcts[i]).toFixed(1)}" r="2.2" fill="#c23531"><title>${p.d}  净值 ¥${p.equity}  收益 ${rp >= 0 ? '+' : ''}${rp}%</title></circle>`; }).join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" style="margin-top:8px">${g}</svg>`;
}
function renderPage(ledger, state, year) {
  const isAll = year === 'all';
  const allNav = ledger.nav || [];
  const base = isAll ? ledger.capital : yearBase(allNav, ledger.capital, year);
  const navData = isAll ? allNav : allNav.filter(p => yearOf(p.d) === year);
  const trades = isAll ? ledger.trades : ledger.trades.filter(t => yearOf(t.entry_date) === year);
  const lastEq = navData.length ? navData[navData.length - 1].equity : base;

  // 总体统计（不随页面切换）
  const gLastEq = allNav.length ? allNav[allNav.length - 1].equity : ledger.capital;
  const gPnl = Math.round((gLastEq - ledger.capital) * 100) / 100;
  const gRet = (100 * (gLastEq - ledger.capital) / ledger.capital).toFixed(1);
  let peak = ledger.capital, dd = 0;
  for (const p of allNav) { peak = Math.max(peak, p.equity); dd = Math.max(dd, peak - p.equity); }
  const allClosed = ledger.trades.filter(t => t.status === 'closed');
  const gWinRate = allClosed.length ? (100 * allClosed.filter(t => t.pnl > 0).length / allClosed.length).toFixed(0) : '-';
  const opens = ledger.trades.filter(t => t.status === 'open');
  const feeSum = Math.round(ledger.trades.reduce((a, t) => a + (t.fees || 0), 0) * 100) / 100;

  // 本页范围统计（年度重置口径）
  const rPnl = Math.round((lastEq - base) * 100) / 100;
  const rRet = base > 0 ? (100 * (lastEq - base) / base).toFixed(1) : '0';
  const rClosed = trades.filter(t => t.status === 'closed');
  const rWinRate = rClosed.length ? (100 * rClosed.filter(t => t.pnl > 0).length / rClosed.length).toFixed(0) : '-';
  const rangeLabel = isAll ? '全部（自建仓以来）' : `${year} 年（年初资金 ¥${Math.round(base).toLocaleString()}）`;

  // 年份导航（全部 + 有数据的年份）
  const years = [...new Set(allNav.map(p => yearOf(p.d)).concat(ledger.trades.map(t => yearOf(t.entry_date))))].sort();
  const tabs = ['all'].concat(years).map(y => {
    const label = y === 'all' ? '全部' : y + ' 年';
    const href = y === 'all' ? 'index.html' : 'year-' + y + '.html';
    return y === year ? `<span class="tab cur">${label}</span>` : `<a class="tab" href="${href}">${label}</a>`;
  }).join('');

  const row = (t) => {
    const stat = t.status === 'open' ? (t.half_done ? '余仓追踪' : '持仓中') : t.reason;
    const pc = t.status === 'closed' ? (t.pnl > 0 ? '#c23531' : t.pnl < 0 ? '#1a9e4b' : '#888') : '#888';
    const retryTag = t.retry ? `<span style="color:#b8860b;font-size:10px">[试错] </span>` : '';
    const tk = (SPEC[t.sym] && SPEC[t.sym].tick) || 1;
    return `<tr><td>${t.entry_date}</td><td>${t.id}</td><td>${retryTag}${t.name} ${t.contract}</td><td style="color:${t.dir === 'long' ? '#c23531' : '#1a9e4b'}">${t.dir === 'long' ? '多' : '空'}</td><td>${t.lots0}</td><td>${fmtPx(t.entry, tk)}</td><td>${fmtPx(t.stop0, tk)}</td><td>${fmtPx(t.t3, tk)}</td><td>${fmtPx(t.t5, tk)}</td><td>${stat}</td><td>${t.signal || '-'}</td><td style="color:${pc};font-weight:600">${t.status === 'closed' ? t.pnl : '-'}</td></tr>`;
  };

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>擒龙手 · 云端监控净值面板 ${isAll ? '' : year}</title>
<style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#888;font-size:12px;margin-bottom:16px}
.tabs{margin-bottom:16px}
.tab{display:inline-block;padding:6px 14px;margin:0 6px 6px 0;border-radius:8px;background:#fff;border:1px solid #e5e7eb;color:#333;text-decoration:none;font-size:13px}
.tab.cur{background:#c23531;color:#fff;border-color:#c23531;font-weight:600}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:140px}
.card b{display:block;font-size:22px;margin-top:4px}.card span{color:#888;font-size:12px}
.sec{color:#888;font-size:12px;margin:4px 0 6px;font-weight:600}
.panel{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}
th{background:#fafafa;color:#666;font-weight:600}
.up{color:#c23531}.dn{color:#1a9e4b}
</style></head><body>
<h1>擒龙手 · 黄大侠拐点战法 云端监控</h1>
<div class="sub">最近更新 ${state.last_scan || '-'}｜信号=日线全自动扫描，交易=人工执行后反馈记账｜年度收益率按"该年1月1日净值"为起始资金重算</div>
<div class="tabs">${tabs}</div>
<div class="sec">■ ${rangeLabel}</div>
<div class="cards">
<div class="card"><span>区间收益率</span><b class="${rPnl >= 0 ? 'up' : 'dn'}">${rPnl >= 0 ? '+' : ''}${rRet}%</b></div>
<div class="card"><span>区间盈亏</span><b class="${rPnl >= 0 ? 'up' : 'dn'}">${rPnl >= 0 ? '+' : ''}${rPnl.toLocaleString()}</b></div>
<div class="card"><span>期末权益</span><b>¥${Math.round(lastEq).toLocaleString()}</b></div>
<div class="card"><span>已平仓/胜率</span><b>${rClosed.length} 笔 / ${rWinRate}%</b></div>
<div class="card"><span>交易笔数</span><b>${trades.length} 笔</b></div>
</div>
<div class="sec">■ 总体（自建仓以来，本金 ¥${ledger.capital.toLocaleString()}）</div>
<div class="cards">
<div class="card"><span>当前权益</span><b>¥${Math.round(gLastEq).toLocaleString()}</b></div>
<div class="card"><span>累计盈亏</span><b class="${gPnl >= 0 ? 'up' : 'dn'}">${gPnl >= 0 ? '+' : ''}${gPnl.toLocaleString()}</b></div>
<div class="card"><span>总收益率</span><b class="${gPnl >= 0 ? 'up' : 'dn'}">${gRet}%</b></div>
<div class="card"><span>最大回撤</span><b>¥${Math.round(dd).toLocaleString()}</b></div>
<div class="card"><span>总已平仓/胜率</span><b>${allClosed.length} 笔 / ${gWinRate}%</b></div>
<div class="card"><span>当前持仓</span><b>${opens.length} 笔</b></div>
<div class="card"><span>累计手续费</span><b>¥${feeSum.toLocaleString()}</b></div>
</div>
<div class="panel"><b>净值曲线</b>（纵轴=相对${isAll ? '本金' : '年初资金'}的收益率%，横轴=日期；hover看单日明细）<br>
${renderChartSVG(navData, base)}</div>
<div class="panel"><b>交易记录 · ${rangeLabel}</b>（红涨绿跌；盈亏=已扣双边手续费净额，单位：元；平仓请按"单号"列回复）<br>
<table><thead><tr><th>日期</th><th>单号</th><th>品种合约</th><th>方向</th><th>手数</th><th>入场</th><th>止损</th><th>3R</th><th>5R</th><th>状态</th><th>信号编号</th><th>盈亏</th></tr></thead>
<tbody>${trades.slice().reverse().map(row).join('') || '<tr><td colspan="12" style="text-align:center;color:#999">该区间暂无成交记录</td></tr>'}</tbody></table></div>
</body></html>`;
}
function rebuildDashboard(ledger, state) {
  fs.mkdirSync(J('docs'), { recursive: true });
  fs.writeFileSync(J('docs/index.html'), renderPage(ledger, state, 'all'));
  const years = [...new Set((ledger.nav || []).map(p => yearOf(p.d)).concat(ledger.trades.map(t => yearOf(t.entry_date))))].sort();
  for (const y of years) fs.writeFileSync(J('docs/year-' + y + '.html'), renderPage(ledger, state, y));
}

/* ---------------- 模式：daily（收盘日报 15:15 推飞书，按当日收盘价更新） ---------------- */
/** 净值字符走势图：净值序列映射到 ▁▂▃▄▅▆▇█（飞书自定义机器人发不了图片，用文字走势替代） */
function sparkline(vals) {
  if (!vals.length) return '（暂无净值数据）';
  const blocks = '▁▂▃▄▅▆▇█';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  return vals.map(v => blocks[Math.max(0, Math.min(blocks.length - 1, Math.round((v - lo) / span * (blocks.length - 1))))]).join('');
}
function cardDaily(ledger, today, lastPx, forecastText) {
  const nav = ledger.nav || [];
  const eq = nav.length ? nav[nav.length - 1].equity : ledger.capital;
  const prevEq = nav.length > 1 ? nav[nav.length - 2].equity : ledger.capital;
  const dayPnl = Math.round((eq - prevEq) * 100) / 100;
  const pnl = Math.round((eq - ledger.capital) * 100) / 100;
  const ret = (100 * (eq - ledger.capital) / ledger.capital).toFixed(1);
  let peak = ledger.capital, dd = 0;
  for (const p of nav) { peak = Math.max(peak, p.equity); dd = Math.max(dd, peak - p.equity); }
  const ddPct = peak > 0 ? (100 * dd / peak).toFixed(1) : '0';
  const closed = ledger.trades.filter(t => t.status === 'closed');
  const wins = closed.filter(t => t.pnl > 0).length;
  const winRate = closed.length ? (100 * wins / closed.length).toFixed(0) : '-';
  const opens = ledger.trades.filter(t => t.status === 'open');
  const todayClosed = closed.filter(t => t.exit_date === today);
  const feeSum = Math.round(ledger.trades.reduce((a, t) => a + (t.fees || 0), 0) * 100) / 100;
  const recent = nav.slice(-30).map(p => p.equity);
  const lo = recent.length ? Math.min(...recent) : eq, hi = recent.length ? Math.max(...recent) : eq;
  const pct = v => (100 * (v - ledger.capital) / ledger.capital).toFixed(1);

  const openLines = opens.length ? opens.map((t, i) => {
    const lp = lastPx[t.sym];
    const f = lp ? Math.round((t.dir === 'long' ? lp - t.entry : t.entry - lp) * t.mult * t.lots) : null;
    return `${i + 1}. ${t.name} ${t.contract} ${t.dir === 'long' ? '多' : '空'} ${t.lots}手 @${t.entry}｜止损${t.stop}｜浮盈 ${f == null ? '—' : (f >= 0 ? '+' : '') + f} 元`;
  }).join('\n') : '无持仓';
  const closedLines = todayClosed.length ? todayClosed.map((t, i) =>
    `${i + 1}. ${t.name} ${t.contract} ${t.dir === 'long' ? '多' : '空'} ${t.lots0}手｜${t.reason}｜盈亏 ${t.pnl >= 0 ? '+' : ''}${t.pnl} 元`).join('\n') : '今日无平仓';

  const els = [
    ftext(`**当前权益 ¥${Math.round(eq).toLocaleString()}**（累计 ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()} 元，${ret}%）\n**当日盈亏 ${dayPnl >= 0 ? '+' : ''}${dayPnl} 元**｜最大回撤 ¥${Math.round(dd)}（-${ddPct}%）\n已平仓 ${closed.length} 笔 / 胜率 ${winRate}%｜当前持仓 ${opens.length} 笔｜累计手续费 ¥${feeSum}`),
    ftext(`**净值走势（近${recent.length}日·收盘）**\n${sparkline(recent)}\n最高 ¥${Math.round(hi)}（+${pct(hi)}%）　最低 ¥${Math.round(lo)}（${pct(lo)}%）`),
    ftext(`**当前持仓（${opens.length}）**\n${openLines}`),
    ftext(`**当日平仓（${todayClosed.length}）**\n${closedLines}`)
  ];
  if (forecastText) els.push(ftext(forecastText));
  els.push({ tag: 'note', elements: [{ tag: 'lark_md', content: '收盘口径｜展望点位为当日收盘快照，次日极值变化后门槛同步更新｜完整净值曲线见 GitHub 面板' }] });

  return {
    config: { wide_screen_mode: true },
    header: { template: pnl >= 0 ? 'green' : 'red', title: { tag: 'plain_text', content: `【擒龙手】收盘日报 ${today}` } },
    elements: els
  };
}
async function modeDaily() {
  const today = todayStr();
  if (!(await isTradingDay(today))) { console.log('非交易日，跳过收盘日报'); return; }
  const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
  const state = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  if (!IS_MANUAL && !process.env.FORCE_DAILY && state.last_daily === today) {
    console.log(`今日（${today}）收盘日报已推送过，冗余触发跳过；如需强制重推设 FORCE_DAILY=1`);
    return;
  }
  // 持仓品种取最新收盘价估值（15:05日线已发布；换月旧合约按自己合约取）
  const lastPx = {};
  for (const t of ledger.trades) if (t.status === 'open') {
    try { const lp = await liveLastPx(t.sym, null, t.contract); if (lp) lastPx[t.sym] = lp; } catch { }
  }
  const eq = equityNow(ledger, lastPx);
  ledger.nav = (ledger.nav || []).filter(p => p.d !== today);
  ledger.nav.push({ d: today, equity: eq });   // 落当日收盘净值点
  // 未来三个交易日信号展望（2026-10-28 新增）：失败不影响日报主体推送
  let fcText = '';
  try {
    const fc = await forecastWindow(today, 3);
    fcText = fmtForecast(fc, today);
    console.log(`展望：候选 ${fc.rows.length} 个，已激活 ${fc.active.length} 个，额度已用 ${fc.usedCnt} 个，取数失败 ${fc.failCnt} 个`);
  } catch (e) {
    console.log('展望生成失败（不影响日报）：' + (e.message || e));
  }
  await feishuSend(cardDaily(ledger, today, lastPx, fcText));
  state.last_daily = today;        // 幂等标记：冗余 cron 触发时据此跳过，避免重复推日报
  writeJson(J('data/state.json'), state);
  writeJson(J('data/ledger.json'), ledger);
  rebuildDashboard(ledger, state);
  console.log(`收盘日报已推送：权益 ${eq}，持仓 ${ledger.trades.filter(t => t.status === 'open').length} 笔`);
}

/* ---------------- 模式：scan ---------------- */
async function modeScan(slot) {
  const today = todayStr();
  console.log(`== scan ${slot} @ ${nowStr()} (today=${today}) ==`);
  if (!(await isTradingDay(today))) { console.log('非交易日，跳过'); return; }

  // 幂等守卫（2026-10-28）：多档 cron 冗余触发时，同一交易日同一时段只实跑一次。
  // 被守卫拦下时 state.last_scan_slot 仍保留主档写入的值，remind 的防竞态等待不受影响。
  // 自愈（2026-10-29）：标记超过 3 小时视为历史残留（调度器把昨日任务延迟到今天造成的脏标记），允许重跑。
  const _st = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  const runKey = `${today}:${slot}`;
  const _mark = _st.runs && _st.runs[runKey];
  if (!IS_MANUAL && !process.env.FORCE_SCAN && _mark) {
    const ageMin = (Date.now() - new Date(_mark.replace(' ', 'T') + ':00+08:00').getTime()) / 60000;
    if (ageMin <= 180) {
      console.log(`  本时段已扫描过（${_mark}），冗余触发跳过；如需强制重跑设 FORCE_SCAN=1`);
      return;
    }
    console.log(`  已有标记 ${_mark} 超过3小时，视为历史残留，允许重跑`);
  }

  advanceContracts(today);
  const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
  const state = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  const pending = readJson(J('data/pending.json'), { seq: 0, items: [] });

  const blackout = await isBlackout(today);
  if (blackout) console.log(`⚠ 今日禁提醒：${blackout}`);

  // 权益估算（含浮动，用最新收盘）
  const barCache = new Map();
  const min3Cache = new Map();   // 3分钟K线缓存（仅新信号触发时按需拉取，算ATR止损）
  for (const spec of POOL) {
    try {
      const bars = await fetchDailySmart(spec);
      addColor(bars);                 // 持仓"反向变色离场"检查依赖颜色字段
      barCache.set(spec.code, bars);
      const cc = contractSinaCode(spec);
      if (cc !== spec.code) console.log(`  ${spec.name} 取数合约 ${cc}`);
    } catch (e) { console.log(`  ${spec.name} 数据失败: ${e.message}`); }
  }
  const lastPx = {};
  for (const [code, bars] of barCache) if (bars.length) lastPx[code] = bars[bars.length - 1].c;
  // 持仓品种改用3分钟实时价估值（日线盘中不更新，否则浮动盈亏显示失真）
  for (const t of ledger.trades) if (t.status === 'open') {
    const lp = await liveLastPx(t.sym, lastPx[t.sym], t.contract);
    if (lp) lastPx[t.sym] = lp;
  }
  const equity = equityNow(ledger, lastPx);
  // 已持仓占用的保证金（2026-10-16）：新信号保证金检查从"权益"改为"可用保证金=权益-已用"
  const usedMargin = ledger.trades.filter(t => t.status === 'open')
    .reduce((a, t) => a + (t.margin1 || 0) * (t.lots || 1), 0);
  const availMargin = equity - usedMargin;

  // 信号扫描
  let newCnt = 0, skipCnt = { seen: 0, zone3: 0, afford: 0, dup: 0, hold: 0 };
  const prevTd = await prevTradingDay(today);   // 今日夜盘开在prevTd日历日晚间
  for (const spec of POOL) {
    const bars = barCache.get(spec.code);
    if (!bars || bars.length < SETTINGS.min_history) { console.log(`  ${spec.name} 数据不足，跳过`); continue; }
    const { signals, term } = replayDaily(bars.map(b => ({ ...b })), spec);
    const lastDate = bars[bars.length - 1].d;
    const zoneCount = {};
    for (const s of signals) zoneCount[s.zoneId] = (zoneCount[s.zoneId] || 0) + 1;

    // 盘中激活检测（2026-10-14升级）：新浪日线当日bar要到15:00后才发布，夜盘/早盘破K2触发线
    // 云端原要等15:01/次日才确认，错过当日入场窗口。现用3分钟聚合"昨夜+今昼"当日K雏形，
    // 已破触发线且未创新高/低（否则走作废补丁口径）→ 立即生成信号，提醒提前到8:00/11:45。
    if (term && term.trig && !term.zoneUsed && term.base && (term.trend === 'long' || term.trend === 'short') && today !== lastDate) {
      try {
        if (!min3Cache.has(spec.code)) {
          let m3 = [];
          try { m3 = await fetch3min(contractSinaCode(spec)); } catch { }
          if (!m3.length) m3 = await fetch3min(spec.code);
          min3Cache.set(spec.code, m3);
        }
        const pb = partialDayBar(min3Cache.get(spec.code), today, prevTd);
        if (pb) {
          const dir = term.trend;
          const breakTrig = dir === 'long' ? pb.l < term.trig : pb.h > term.trig;
          const newExtreme = dir === 'long' ? pb.h > term.base.px : pb.l < term.base.px;
          // 逆色激活过滤（同日线口径）：当日K雏形已收反向色则不生成信号
          let oppColor = false, pbColor = '';
          if (SETTINGS.filter_opp_color) {
            const seq = bars.map(b => b.c).concat([pb.c]);
            const e5 = ema(seq, 5), e10 = ema(seq, 10), e20 = ema(seq, 20);
            const li = seq.length - 1;
            pbColor = (e5[li] > e10[li] && e5[li] > e20[li]) ? 'R' : (e5[li] < e10[li] && e5[li] < e20[li]) ? 'G' : 'W';
            oppColor = (dir === 'long' && pbColor === 'G') || (dir === 'short' && pbColor === 'R');
          }
          if (breakTrig && !newExtreme && oppColor) {
            console.log(`  ${spec.name} 盘中破触发线${term.trig}，但当日K雏形收${pbColor}色（与${dir === 'long' ? '多' : '空'}反向），逆色激活不生成信号`);
          }
          if (breakTrig && !newExtreme && !oppColor) {
            const seg = dir === 'long' ? pb.l : pb.h;
            const stop0 = dir === 'long' ? seg - 3 * spec.tick : seg + 3 * spec.tick;
            const R0 = dir === 'long' ? pb.c - stop0 : stop0 - pb.c;
            if (R0 > 0) {
              signals.push({
                date: today, dir, kind: 'activate',
                zoneId: `${today}|${dir}|${term.trig}`,
                ref: pb.c, stop: stop0, R: R0,
                t3: dir === 'long' ? pb.c + 3 * R0 : pb.c - 3 * R0,
                t5: dir === 'long' ? pb.c + 5 * R0 : pb.c - 5 * R0,
                seg, voidPx: term.base.px, intraday: true
              });
              console.log(`  ◆ 盘中激活: ${spec.name} 当日K(昨夜+今昼 高${pb.h}低${pb.l}) 已破触发线${term.trig}`);
            }
          }
        }
      } catch { /* 3分钟数据不可用时保持日线口径 */ }
    }

    for (const s of signals) {
      const key = `${spec.code}|${s.date}|${s.dir}|${s.zoneId}`;
      if (state.seen[key]) continue;
      state.seen[key] = { date: s.date, alerted: false };
      if (s.date !== lastDate && s.date !== today) continue;   // 历史信号仅播种（当日=盘中激活信号）
      if (zoneCount[s.zoneId] > SETTINGS.max_zone_signals) { skipCnt.zone3++; continue; }
      if (pending.items.some(p => p.sym === spec.code && p.date === s.date && p.dir === s.dir && ['pending', 'reminded'].includes(p.status))) { skipCnt.dup++; continue; }
      if (ledger.trades.some(t => t.status === 'open' && t.sym === spec.code && t.dir === s.dir)) { skipCnt.hold++; console.log(`  ${spec.name} 已有同向持仓，同向不加仓（2026-10-16回测：同段二次信号55笔仅+679元/PF1.06，不启用）`); continue; }
      const margin1 = s.ref * spec.mult * marginRate(spec);
      if (margin1 > availMargin) { skipCnt.afford++; console.log(`  ${spec.name} 保证金${Math.round(margin1)}>可用${Math.round(availMargin)}（权益${Math.round(equity)}-已用${Math.round(usedMargin)}），不提醒`); continue; }
      if (blackout) continue;                                  // 禁提醒日仅记录
      // V2优化：止损宽度 = 区极值 ± 0.5×ATR14(3分钟)，随品种波动率自适应（原固定±3跳，回测PF 1.29→1.46）
      // 失败回退：拉不到3分钟数据则沿用日线状态机的±3跳止损
      const atrMult = SETTINGS.stop_atr_mult ?? 0.5;
      let stop = s.stop, R = s.R, t3 = s.t3, t5 = s.t5, stopNote = '3跳';
      if (atrMult > 0) {
        try {
          if (!min3Cache.has(spec.code)) {
            let m3 = [];
            try { m3 = await fetch3min(contractSinaCode(spec)); } catch { }
            if (!m3.length) m3 = await fetch3min(spec.code);
            min3Cache.set(spec.code, m3);
          }
          const a = atrLast(min3Cache.get(spec.code));
          if (a > 0) {
            const pad = atrMult * a;
            const st = s.dir === 'long' ? s.seg - pad : s.seg + pad;
            const r2 = s.dir === 'long' ? s.ref - st : st - s.ref;
            if (r2 > 0) {
              stop = Math.round(st * 100) / 100; R = r2;
              t3 = Math.round((s.dir === 'long' ? s.ref + 3 * r2 : s.ref - 3 * r2) * 100) / 100;
              t5 = Math.round((s.dir === 'long' ? s.ref + 5 * r2 : s.ref - 5 * r2) * 100) / 100;
              stopNote = `0.5×ATR14=${(Math.round(pad * 100) / 100)}`;
            }
          }
        } catch { /* 网络异常时回退3跳 */ }
      }
      // 报价网格对齐（2026-10-14）：止损按品种一跳取整（保守方向），R/3R/5R按新止损重算，消除小数点位
      if (spec.tick) {
        const g = gridRound(stop, spec.tick, s.dir);
        if (g !== stop) {
          stop = g;
          R = s.dir === 'long' ? s.ref - stop : stop - s.ref;
          t3 = Math.round((s.dir === 'long' ? s.ref + 3 * R : s.ref - 3 * R) * 100) / 100;
          t5 = Math.round((s.dir === 'long' ? s.ref + 5 * R : s.ref - 5 * R) * 100) / 100;
          stopNote += `→网格${g}`;
        }
      }
      const lots = computeLots(equity, R, spec.mult, margin1, usedMargin);
      const p = {
        id: 'S' + s.date.replaceAll('-', '') + '-' + String(++pending.seq).padStart(3, '0'),
        sym: spec.code, name: spec.name, contract: contractOf(spec.code),
        dir: s.dir, date: s.date, slot,
        ref: s.ref, stop, R: Math.round(R * 100) / 100, t3, t5,
        void_px: s.voidPx ?? null,                    // 作废基准：多头创新高/空头创新低即失效
        mult: spec.mult, lots, margin1: Math.round(margin1),
        equity: Math.round(equity),
        remind_date: slot === 'night' ? await nextTradingDay(today) : today,
        status: 'pending', created: nowStr()
      };
      pending.items.push(p);
      state.seen[key].alerted = true;
      newCnt++;
      console.log(`  ★ K3激活 ${p.name} ${p.contract} ${p.dir === 'long' ? '多' : '空'} ref=${p.ref} 止损=${p.stop}(${stopNote}) 作废基准=${p.void_px} lots=${lots} → ${slot} 时段提醒(${p.remind_date})`);
    }
  }

  // 持仓到位检查（止损/3R/5R/变色，即时提醒，不受禁提醒限制）
  const touchNotes = await checkPositions(ledger, barCache, today);
  for (const n of touchNotes) console.log('  ● ' + n);

  // 已提醒信号的生命周期管理：①设置作废（价格破基准）②破止损作废（未入场破止损）③反馈超期自动关闭
  for (const p of pending.items) {
    if (p.status !== 'reminded') continue;
    const bars = barCache.get(p.sym);
    if (bars && bars.length) {
      const since = bars.filter(b => b.d >= p.date);
      // ①破基准作废：多头创新高/空头创新低，操作区失效
      if (p.void_px != null) {
        const voidHit = since.some(b => p.dir === 'long' ? b.h > p.void_px : b.l < p.void_px);
        if (voidHit) {
          p.status = 'invalidated'; p.invalidated_at = nowStr(); p.void_reason = 'base';
          if (!blackout) await feishuSend(cardVoid(p, 'base'));
          console.log(`  ✗ 设置作废 ${p.id} ${p.name}：价格已破基准 ${p.void_px}，操作区失效`);
          continue;
        }
      }
      // ②破止损作废（2026-10-21）：未入场价格已越过止损位（多:最低价≤止损/空:最高价≥止损），
      //   继续等3分钟转红入场将使入场价劣于止损、R<0，信号失效。菜粕RM701 10-20当天2261破止损2269仍发跟进即此缺口。
      //   仅对未入场(reminded)判定；已入场持仓改走持仓止损跟踪，不受此影响。
      if (p.stop != null) {
        const stopHit = since.some(b => p.dir === 'long' ? b.l <= p.stop : b.h >= p.stop);
        if (stopHit) {
          p.status = 'invalidated'; p.invalidated_at = nowStr(); p.void_reason = 'stop';
          if (!blackout) await feishuSend(cardVoid(p, 'stop'));
          console.log(`  ✗ 止损破位作废 ${p.id} ${p.name}：未入场价格已破止损 ${p.stop}，信号失效`);
          continue;
        }
      }
    }
    const expiry = await nextTradingDay(p.remind_date);
    if (today > expiry) {
      p.status = 'expired'; p.expired_at = nowStr();
      console.log(`  ⏳ 反馈超期 ${p.id} ${p.name}（提醒日 ${p.remind_date}，有效期至 ${expiry} 收盘）`);
    }
  }

  // 净值
  const eq2 = equityNow(ledger, lastPx);
  ledger.nav = (ledger.nav || []).filter(p => p.d !== today);
  ledger.nav.push({ d: today, equity: eq2 });
  if (ledger.nav.length > 750) ledger.nav = ledger.nav.slice(-750);
  state.last_scan = nowStr();
  state.last_scan_slot = slot;   // 供 remind 防竞态等待识别本时段扫描是否已完成
  // 幂等标记：仅在整轮扫描成功走完后才写入，故主档中途失败时备份档仍会补跑（不会被误判为已完成）
  const _cut = addDays(today, -7);
  state.runs = Object.fromEntries(Object.entries(state.runs || {}).filter(([k]) => String(k).slice(0, 10) >= _cut));
  state.runs[runKey] = nowStr();

  writeJson(J('data/ledger.json'), ledger);
  writeJson(J('data/state.json'), state);
  writeJson(J('data/pending.json'), pending);
  writeJson(J('data/holidays.json'), HOLIDAYS);
  rebuildDashboard(ledger, state);
  console.log(`完成：新信号 ${newCnt}，跳过 ${JSON.stringify(skipCnt)}，权益 ${eq2}`);
}

/* ---------------- 模式：remind ---------------- */
/* ---------------- 模式：remind ---------------- */
/**
 * 防竞态等待：GitHub 定时任务有 5~20 分钟延迟，提醒任务可能先于扫描任务运行。
 * 这里通过 raw.githubusercontent.com 轮询远端 state.json（绕过本地 checkout 的旧快照），
 * 确认本时段对应的扫描已完成后再处理提醒；确认后同步拉取最新数据文件，避免漏推信号。
 * 仅在 Actions 环境（有 GITHUB_REPOSITORY）生效；本地运行或设 NO_WAIT_SCAN=1 跳过。
 */
const REMIND_EXPECT_SCAN = { noon: 'noon', evening: 'evening', morning: 'night' };
async function waitScanDone(slot, today) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || process.env.NO_WAIT_SCAN) return;
  const expectSlot = REMIND_EXPECT_SCAN[slot];
  if (!expectSlot) return;
  const expectDate = slot === 'morning' ? await prevTradingDay(today) : today;
  const rawBase = `https://raw.githubusercontent.com/${repo}/main`;
  const deadline = Date.now() + 12 * 60 * 1000;   // 最多等 12 分钟
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const r = await fetch(`${rawBase}/data/state.json?_=${Date.now()}`, { headers: { 'User-Agent': 'qls-monitor' } });
      if (r.ok) {
        const st = await r.json();
        const scanDay = String(st.last_scan || '').slice(0, 10);
        if (st.last_scan_slot === expectSlot && scanDay === expectDate) {
          if (attempt > 1) console.log(`  扫描已完成（第 ${attempt} 次探测）`);
          // 拉取扫描刚提交的最新数据，覆盖 checkout 时的旧快照
          for (const f of ['data/pending.json', 'data/state.json', 'data/ledger.json']) {
            try {
              const rf = await fetch(`${rawBase}/${f}?_=${Date.now()}`, { headers: { 'User-Agent': 'qls-monitor' } });
              if (rf.ok) writeJson(J(f), await rf.json());
            } catch { /* 单文件同步失败不致命 */ }
          }
          return;
        }
      }
    } catch { /* 网络抖动，继续等 */ }
    if (attempt === 1) console.log(`  等待 ${expectDate} ${expectSlot} 扫描完成（GitHub 延迟容忍，最长12分钟）...`);
    await new Promise(rs => setTimeout(rs, 45 * 1000));
  }
  console.log('  ⚠ 等待扫描超时，按现有数据继续——若本应有机信号未推送，请检查"盘中扫描"工作流是否失败');
}

async function modeRemind(slot) {
  const today = todayStr();
  console.log(`== remind ${slot} @ ${nowStr()} (today=${today}) ==`);
  if (!(await isTradingDay(today))) { console.log('非交易日，跳过'); return; }
  await waitScanDone(slot, today);
  // 幂等守卫（2026-10-28）：冗余 cron 触发时，同一交易日同一时段只推一次提醒。
  // 判据取自 waitScanDone 已同步的远端 state.json（remind 工作流每次都会回写推送状态）。
  const _rm = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  if (!IS_MANUAL && !process.env.FORCE_REMIND && _rm.last_remind === `${today}:${slot}`) {
    console.log(`  本时段（${slot}）提醒已推送过，冗余触发跳过；如需强制重推设 FORCE_REMIND=1`);
    return;
  }
  const pending = readJson(J('data/pending.json'), { seq: 0, items: [] });
  const blackout = await isBlackout(today);
  let sent = 0, expired = 0;

  // 同时段多信号优先级（2026-10-16）：≥2个信号同槽推送时，卡内标注建议优先级（板块分散+小止损+小保证金）
  const expectScan = REMIND_EXPECT_SCAN[slot] || slot;
  const eligible = pending.items.filter(p => p.status === 'pending' && p.remind_date === today && p.slot === expectScan);
  let prio = new Map();
  if (eligible.length >= 2 && !blackout) {
    let openTrades = [];
    try { const lg = readJson(J('data/ledger.json'), { trades: [] }); openTrades = lg.trades.filter(t => t.status === 'open'); } catch { }
    prio = slotPriority(eligible, openTrades);
    console.log(`  同时段 ${eligible.length} 个信号并存，优先级：${[...prio.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id, v]) => `${v.rank}.${id}`).join(' ')}`);
  }

  for (const p of pending.items) {
    if (p.status !== 'pending') continue;
    if (p.remind_date > today) continue;
    // 时段判据须经 REMIND_EXPECT_SCAN 映射：夜盘(night)扫描的信号由次日 morning 提醒推送。
    // 原直接比较 p.slot !== slot 会把 'night' ≠ 'morning' 误判为过期——夜盘扫描发现的信号永远不会被推送（2026-10-13棉花K3空头漏报根因）
    if (p.remind_date < today || p.slot !== expectScan) { p.status = 'expired'; expired++; continue; }
    if (blackout) { p.status = 'expired'; expired++; console.log(`  禁提醒日，信号 ${p.id} 作废：${blackout}`); continue; }
    const expiry = await nextTradingDay(p.remind_date);
    const ok = await feishuSend(cardSignal(p, expiry, prio.get(p.id)));
    if (ok) { p.status = 'reminded'; p.reminded_at = nowStr(); sent++; console.log(`  → 已提醒 ${p.id} ${p.name} ${p.contract}`); }
  }
  // 跟进提醒（2026-10-15）：已提醒但一直未收到成交/未入场反馈的信号，
  // 在提醒日之后的交易日重发一次简化卡（每信号仅一次；已作废/过期/已反馈的条目状态非 reminded，自动跳过）
  let follow = 0;
  for (const p of pending.items) {
    if (p.status !== 'reminded' || p.followup) continue;
    if (p.remind_date >= today) continue;                 // 仅在提醒日之后的交易日跟进
    if (blackout) continue;
    let px = null;
    try { px = await liveLastPx(p.sym, null, p.contract); } catch { }
    const expiryF = await nextTradingDay(p.remind_date);
    const ok = await feishuSend(cardFollowup(p, px, expiryF));
    if (ok) { p.followup = true; p.followup_at = nowStr(); follow++; console.log(`  → 跟进提醒 ${p.id} ${p.name} ${p.contract}（未反馈，当前价${px ?? '—'}）`); }
  }
  // 心跳：本时段无信号提醒/跟进时发一条存活确认（可在 settings.json 关闭）
  if (sent === 0 && follow === 0 && SETTINGS.heartbeat !== false) {
    const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
    const st = readJson(J('data/state.json'), { seen: {}, last_scan: null });
    const navLast = (ledger.nav || []).slice(-1)[0];
    const equity = navLast ? navLast.equity : ledger.capital;
    const opens = ledger.trades.filter(t => t.status === 'open').length;
    const ok = await feishuSend(cardHeartbeat(slot, {
      today, equity, opens, lastScan: st.last_scan, blackout
    }));
    if (ok) console.log('  ♥ 心跳已发送（本时段无信号）');
  }
  // 清理30天前已终结的pending
  const cutoff = addDays(today, -30);
  pending.items = pending.items.filter(p => ['pending', 'reminded'].includes(p.status) || (p.date >= cutoff));
  writeJson(J('data/pending.json'), pending);
  writeJson(J('data/holidays.json'), HOLIDAYS);
  const _rs = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  _rs.last_remind = `${today}:${slot}`;   // 冗余触发去重标记
  writeJson(J('data/state.json'), _rs);
  console.log(`完成：发送 ${sent}，跟进 ${follow}，过期 ${expired}`);
}

/* ---------------- 模式：feedback（GitHub Issue 评论） ---------------- */
async function modeFeedback() {
  const author = process.env.COMMENT_AUTHOR || '';
  const body = (process.env.COMMENT_BODY || '').trim();
  const owner = process.env.REPO_OWNER || '';
  console.log(`== feedback from ${author}: ${body.slice(0, 80)} ==`);
  if (!owner || author !== owner) { console.log('非仓库所有者评论，忽略'); return; }

  const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
  const pending = readJson(J('data/pending.json'), { seq: 0, items: [] });
  const state = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  const today = todayStr();
  let processed = false;

  const mCJ = body.match(/(?:成交|入场)\s*#?(S\d{8}-\d+)?\s*(\d+(?:\.\d+)?)?\s*(\d+)?/);
  const mWCJ = body.match(/未\s*(?:成交|入场)\s*#?(S\d{8}-\d+)?/);
  const mPC = body.match(/平仓\s*#?(T\d+)?\s*(\d+(?:\.\d+)?)?/);
  // 试错/再入场（2026-10-21）：同一信号止损后再进场，可自定义止损。格式：试错 #信号号 入场价 止损价 [手数]
  const mSR = body.match(/(?:试错|重进|再入场)\s*#?(S\d{8}-\d+)?\s*(\d+(?:\.\d+)?)\s*(\d+(?:\.\d+)?)?\s*(\d+)?/);

  if (mWCJ) {
    const p = mWCJ[1]
      ? pending.items.find(x => x.id === mWCJ[1])
      : pending.items.filter(x => ['pending', 'reminded'].includes(x.status)).pop();
    if (p && ['pending', 'reminded'].includes(p.status)) {
      p.status = 'missed'; p.fb = body.slice(0, 100); processed = true;
      console.log(`  ${p.id} 标记未入场`);
      await feishuSend(cardFbAck('【擒龙手】反馈已记录', [
        `信号 **#${p.id}**（${p.name} ${p.contract} ${p.dir === 'long' ? '多' : '空'}）已标记为 **未入场**，信号关闭。`,
        mWCJ[1] ? '' : '⚠ 本次回复未带 #编号，系统按"最新一条有效信号"匹配——多个信号并存时务必带编号，避免匹配错误'
      ].filter(Boolean), 'wathet'));
    } else {
      console.log('  未找到对应信号');
      await feishuSend(cardFbAck('【擒龙手】反馈未受理', [
        `未找到可匹配的有效信号${mWCJ[1] ? '（编号 ' + mWCJ[1] + '）' : ''}。`,
        '可能原因：信号已作废/超期关闭，或编号有误。有效信号的编号见飞书提醒卡片。'
      ], 'red'));
    }
  } else if (mSR) {
    // 试错/再入场：关联原信号 zoneId、retry=true，独立于 pending 状态，云端按你给的止损照常跟踪
    const p = mSR[1] ? pending.items.find(x => x.id === mSR[1]) : null;
    if (!mSR[1]) {
      await feishuSend(cardFbAck('【擒龙手】试错未受理', ['试错单必须带信号编号，格式：**试错 #信号号 入场价 止损价 [手数]**', '例：试错 #S20261019-002 5383 5370 1'], 'red'));
    } else if (!p) {
      await feishuSend(cardFbAck('【擒龙手】试错未受理', [`未找到信号 **#${mSR[1]}**。`, '试错单需关联一条已推送过的信号（无论其是否已止损/关闭），编号见历史提醒卡片。'], 'red'));
    } else if (!mSR[2] || !mSR[3]) {
      await feishuSend(cardFbAck('【擒龙手】试错未受理', ['试错单需同时给 **入场价** 和 **止损价**。', '格式：**试错 #信号号 入场价 止损价 [手数]**（例：试错 #S20261019-002 5383 5370 1）'], 'red'));
    } else {
      const spec = SPEC[p.sym];
      const entry = +mSR[2], stop = +mSR[3], lots = mSR[4] ? +mSR[4] : 1;
      const sgn = p.dir === 'long' ? 1 : -1;
      const badDir = (p.dir === 'long' && stop >= entry) || (p.dir === 'short' && stop <= entry);
      if (badDir) {
        await feishuSend(cardFbAck('【擒龙手】试错未受理', [`止损价方向有误：${p.dir === 'long' ? '做多止损应低于入场价' : '做空止损应高于入场价'}（入场 ${entry} / 止损 ${stop}）。`], 'red'));
      } else {
        const R = Math.abs(entry - stop);
        const t = {
          id: 'T' + String(++ledger.seq).padStart(4, '0'),
          signal: p.id, sym: p.sym, name: p.name, contract: p.contract,
          dir: p.dir, entry_date: today, entry, lots, lots0: lots,
          stop, stop0: stop, R,
          t3: entry + 3 * sgn * R, t5: entry + 5 * sgn * R,
          mult: spec.mult, half_done: false, realized: 0, status: 'open',
          margin1: Math.round(entry * spec.mult * marginRate(spec)),
          fees: Math.round(feePerLot(spec, entry) * lots * 100) / 100,
          retry: true, fb: body.slice(0, 100)
        };
        ledger.trades.push(t);
        processed = true;
        console.log(`  ★ 试错登记 ${t.id}：${t.name} ${t.contract} ${p.dir === 'long' ? '多' : '空'} ${lots}手 @${entry} 止损${stop}（信号 #${p.id} 试错）`);
        await feishuSend(cardFbAck('【擒龙手】试错单已入账 ' + t.id, [
          `**${t.name} ${t.contract}** ${p.dir === 'long' ? '多' : '空'} **${lots} 手 @ ${entry}**（信号 #${p.id} 试错）`,
          `止损 ${stop}｜1R=${Math.round(R * 100) / 100}点｜3R=${Math.round(t.t3 * 100) / 100}｜5R=${Math.round(t.t5 * 100) / 100}`,
          `云端将按你给的止损 ${stop} 跟踪止损/3R/5R/变色并提醒。`
        ], 'green'));
      }
    }
  } else if (mCJ) {
    const p = mCJ[1]
      ? pending.items.find(x => x.id === mCJ[1])
      : pending.items.filter(x => ['pending', 'reminded'].includes(x.status)).pop();
    if (!p || !['pending', 'reminded'].includes(p.status)) {
      console.log('  未找到对应信号');
      await feishuSend(cardFbAck('【擒龙手】反馈未受理', [
        `未找到可匹配的有效信号${mCJ[1] ? '（编号 ' + mCJ[1] + '）' : ''}。`,
        '可能原因：信号已作废/超期关闭，或编号有误。若实际已入场，请自行严格按止损纪律执行。'
      ], 'red'));
    }
    else if (p.status === 'filled') console.log(`  ${p.id} 已登记过成交，忽略`);
    else {
      const spec = SPEC[p.sym];
      const entry = mCJ[2] ? +mCJ[2] : p.ref;
      const lots = mCJ[3] ? +mCJ[3] : p.lots;
      const sgn = p.dir === 'long' ? 1 : -1;
      const R = Math.abs(entry - p.stop);
      const t = {
        id: 'T' + String(++ledger.seq).padStart(4, '0'),
        signal: p.id, sym: p.sym, name: p.name, contract: p.contract,
        dir: p.dir, entry_date: today, entry, lots, lots0: lots,
        stop: p.stop, stop0: p.stop, R,
        t3: entry + 3 * sgn * R, t5: entry + 5 * sgn * R,
        mult: spec.mult, half_done: false, realized: 0, status: 'open',
        fees: Math.round(feePerLot(spec, entry) * lots * 100) / 100,
        fb: body.slice(0, 100)
      };
      ledger.trades.push(t);
      p.status = 'filled'; p.trade = t.id;
      processed = true;
      console.log(`  ★ 成交登记 ${t.id}：${t.name} ${t.contract} ${t.dir === 'long' ? '多' : '空'} ${lots}手 @${entry} 止损${t.stop} 3R=${t.t3} 5R=${t.t5}`);
      await feishuSend(cardFbAck('【擒龙手】成交已入账 ' + t.id, [
        `**${t.name} ${t.contract}** ${t.dir === 'long' ? '多' : '空'} **${lots} 手 @ ${entry}**`,
        `止损 ${t.stop}｜1R=${Math.round(R * 100) / 100}点｜3R=${Math.round(t.t3 * 100) / 100}｜5R=${Math.round(t.t5 * 100) / 100}`,
        `信号 #${p.id} 已关闭，云端将按纪律自动跟踪止损/3R/5R/变色并提醒。`,
        mCJ[1] ? '' : '⚠ 本次回复未带 #编号，系统按"最新一条有效信号"匹配——多个信号并存时务必带编号'
      ].filter(Boolean), 'green'));
    }
  } else if (mPC) {
    const t = mPC[1]
      ? ledger.trades.find(x => x.id === mPC[1])
      : ledger.trades.filter(x => x.status === 'open').pop();
    if (!t || t.status !== 'open') {
      console.log('  未找到持仓中的该单');
      await feishuSend(cardFbAck('【擒龙手】反馈未受理', [
        `未找到持仓中的该单${mPC[1] ? '（单号 ' + mPC[1] + '）' : ''}。`, '持仓单号见净值面板或到位提醒卡片。'
      ], 'red'));
    }
    else {
      let px = mPC[2] ? +mPC[2] : null;
      if (!px) { try { px = await liveLastPx(t.sym, null, t.contract) || t.entry; } catch { px = t.entry; } }
      closeTrade(t, px, today, '手动平仓');
      processed = true;
      console.log(`  平仓登记 ${t.id} @${px} 盈亏 ${t.pnl}`);
      await feishuSend(cardFbAck('【擒龙手】平仓已入账 ' + t.id, [
        `**${t.name} ${t.contract}** ${t.dir === 'long' ? '多' : '空'} ${t.lots0} 手 @ ${px}`,
        `本单净盈亏（已扣双边手续费）：**${t.pnl} 元**`
      ], t.pnl > 0 ? 'green' : 'wathet'));
    }
  } else {
    console.log('  未识别指令（支持：成交 #信号号 [价] [手数] / 未入场 #信号号 / 平仓 #单号 [价] / 试错 #信号号 入场价 止损价 [手数]）');
    await feishuSend(cardFbAck('【擒龙手】未能识别回复', [
      `您的回复："${body.slice(0, 60)}" 未匹配任何指令。`,
      '支持格式：\n**成交 #信号号 [实际价] [手数]**（如：成交 #S20261008-001 935 2）\n**未入场 #信号号**\n**平仓 #单号 [实际价]**（如：平仓 #T0007 921）\n**试错 #信号号 入场价 止损价 [手数]**（同一信号止损后再进场，如：试错 #S20261019-002 5383 5370 1）',
      '多个信号并存时务必带 #编号；不带编号将匹配"最新一条有效信号/持仓"，存在错配风险。'
    ], 'red'));
  }

  if (processed) {
    const lastPx = {};
    for (const t of ledger.trades) if (t.status === 'open') {
      const lp = await liveLastPx(t.sym, null, t.contract);
      if (lp) lastPx[t.sym] = lp;
    }
    const eq = equityNow(ledger, lastPx);
    ledger.nav = (ledger.nav || []).filter(p => p.d !== today);
    ledger.nav.push({ d: today, equity: eq });
    state.last_scan = nowStr();
    writeJson(J('data/ledger.json'), ledger);
    writeJson(J('data/pending.json'), pending);
    writeJson(J('data/state.json'), state);
    rebuildDashboard(ledger, state);
    console.log('PROCESSED');
  }
}

/* ---------------- 模式：contracts ---------------- */
async function modeContracts() {
  const today = todayStr();
  console.log(`== contracts 维护 @ ${today} ==`);
  // 幂等守卫（2026-10-28）：月度维护工作流设多档冗余 cron，同月只实跑一次；
  // 标记写入放在维护流程最后一步（contracts），故 pool 中途失败时备份档仍会补跑。
  const _mm = today.slice(0, 7);
  const _cs = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  if (!IS_MANUAL && !process.env.FORCE_MAINT && _cs.last_maintenance === _mm) {
    console.log(`本月（${_mm}）维护已执行过，冗余触发跳过；如需强制重跑设 FORCE_MAINT=1`);
    return;
  }
  const changed = advanceContracts(today);
  console.log(changed ? '已更新合约' : '无需换月');
  for (const spec of POOL) {
    const c = CONTRACTS[spec.code];
    if (c) console.log(`  ${spec.name.padEnd(4, '　')} main=${c.main} next=${c.next} rollover=${c.rollover}`);
  }
  const _cs2 = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  _cs2.last_maintenance = _mm;   // 月度维护幂等标记（供冗余 cron 去重）
  writeJson(J('data/state.json'), _cs2);
}

/* ---------------- 模式：pool（每月1日品种池自动筛选） ----------------
 * 口径（settings.pool_screen 可调）：
 *   ① 代表合约 = 距名义交割日(交割月15日) ≥ min_days 天的最近主力档，不足自动顺延下一档
 *   ② 一手保证金(最新结算价×乘数×保证金率) < margin_max 元
 *   ③ 20日日均成交量 ≥ vol_min 手
 *   ④ 20日日均沉淀保证金(持仓×结算×乘数×保证金率) > depo_min_yi 亿
 * 安全规则：有未平仓持仓或待反馈信号的品种强制留池；数据抓取失败的老成员留池。
 */
function cardPool(info) {
  const c = info.crit;
  const lines = [
    `**口径**：距交割≥${c.min_days}天｜保证金<${c.margin_max}元｜20日均量≥${Math.round(c.vol_min / 10000)}万手｜沉淀>${c.depo_min_yi}亿`,
    ''
  ];
  if (info.added.length) lines.push(`🟢 **新增（${info.added.length}）**：${info.added.join('、')}`);
  if (info.removed.length) lines.push(`🔴 **移除（${info.removed.length}）**：${info.removed.join('、')}`);
  if (info.retained.length) lines.push(`🟡 **持仓/数据原因保留**：${info.retained.join('、')}`);
  if (!info.added.length && !info.removed.length) lines.push('本期池子无变动');
  lines.push('', `**当月品种池（${info.total}个）**：${info.names}`);
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `【擒龙手】品种池月度筛选 ${info.today}` } },
    elements: [
      ftext(lines.join('\n')),
      { tag: 'note', elements: [{ tag: 'lark_md', content: '每月1日自动执行｜口径在 config/settings.json 的 pool_screen 调整' }] }
    ]
  };
}
async function modePool() {
  const today = todayStr();
  console.log(`== pool 月度筛选 @ ${nowStr()} (today=${today}) ==`);
  // 幂等守卫（2026-10-28）：与 modeContracts 同一标记，保证多档冗余 cron 下每月只筛一次
  const _pm = today.slice(0, 7);
  const _ps = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  if (!IS_MANUAL && !process.env.FORCE_MAINT && _ps.last_maintenance === _pm) {
    console.log(`本月（${_pm}）维护已执行过，冗余触发跳过；如需强制重跑设 FORCE_MAINT=1`);
    return;
  }
  const c = Object.assign(
    { depo_min_yi: 7, vol_min: 150000, margin_max: 10000, min_days: 60 },
    SETTINGS.pool_screen || {}
  );
  const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
  const pending = readJson(J('data/pending.json'), { seq: 0, items: [] });
  const keepForHold = new Set();
  for (const t of ledger.trades) if (t.status === 'open') keepForHold.add(t.sym);
  for (const p of pending.items) if (['pending', 'reminded'].includes(p.status)) keepForHold.add(p.sym);

  const oldCodes = new Set(POOL.map(s => s.code));
  const newPool = [], added = [], removed = [], retained = [];
  let contractsChanged = false;

  for (const spec of CANDIDATES) {
    let row = null;
    try {
      const pick = pickContract(spec, today, c.min_days);
      const bars = await fetchDaily(fetchCode(spec, pick.y, pick.m));
      const last20 = bars.slice(-20);
      if (last20.length < 20) throw new Error('历史不足20根');
      const av = last20.reduce((a, b) => a + b.v, 0) / last20.length;
      const dep = last20.reduce((a, b) => a + (b.p || 0) * ((b.s || b.c)) * spec.mult * marginRate(spec), 0) / last20.length / 1e8;
      const lastC = bars[bars.length - 1].s || bars[bars.length - 1].c;
      const margin1 = lastC * spec.mult * marginRate(spec);
      row = { spec, pick, av, dep, margin1, pass: av >= c.vol_min && dep > c.depo_min_yi && margin1 < c.margin_max };
      console.log(`  ${spec.name.padEnd(4, '　')} ${pick.code} 交割${pick.days}天 量${(av / 10000).toFixed(1)}万手 沉淀${dep.toFixed(2)}亿 保证金${Math.round(margin1)} → ${row.pass ? '✓' : '✗'}`);
    } catch (e) {
      console.log(`  ${spec.name} 数据失败: ${e.message}`);
    }
    const inOld = oldCodes.has(spec.code);
    const held = keepForHold.has(spec.code);
    if (row && (row.pass || held)) {
      const entry = { ...spec, av: Math.round(row.av), dep: +row.dep.toFixed(2), margin1: Math.round(row.margin1), contract: row.pick.code };
      if (held && !row.pass) { entry.retained = true; retained.push(spec.name); }
      newPool.push(entry);
      // 合约条目与筛选口径保持一致（新成员初始化 / 老成员刷新，顺便完成换月校准）
      const cur = CONTRACTS[spec.code];
      if (!cur || cur.main !== row.pick.code) {
        CONTRACTS[spec.code] = initContract(spec, today, c.min_days);
        contractsChanged = true;
        if (!inOld) added.push(spec.name);
      }
    } else if (!row && inOld) {
      newPool.push({ ...spec });                       // 数据失败的老成员保留（防网络抖动误删）
      retained.push(spec.name + '(数据失败)');
    } else if (row && !row.pass && inOld) {
      removed.push(`${spec.name}(沉淀${row.dep.toFixed(1)}亿/量${(row.av / 10000).toFixed(1)}万手)`);
    }
  }

  writeJson(J('config/pool.json'), newPool);
  if (contractsChanged) writeJson(J('config/contracts.json'), CONTRACTS);
  console.log(`完成：池 ${POOL.length}→${newPool.length}，新增[${added}] 移除[${removed}] 保留[${retained}]`);

  await feishuSend(cardPool({
    today, crit: c, added, removed, retained,
    total: newPool.length, names: newPool.map(s => s.name).join('、')
  }));
}

/* ---------------- 模式：calendar（每年12月30日自动刷新次年交易日历） ----------------
 * 抓取次年官方法定节假日数据，整文件覆盖 config/holidays_static.json（仅保留次年，
 * 前一年数据随之删除，保持仓库轻便）。安全规则：
 *  ① 仅 12 月执行（国务院次年安排通常 11~12 月已发布）；FORCE_CALENDAR=1 可强制（调试）
 *  ② 抓取失败或次年官方数据未发布（条目过少）→ 保留现有文件，不做任何改动
 *  ③ 覆盖后顺手清理 data/holidays.json 缓存中次年之前的旧条目
 */
async function modeCalendar() {
  const today = todayStr();
  const [y, m] = today.split('-').map(Number);
  console.log(`== calendar 年度日历刷新 @ ${today} ==`);
  if (m !== 12 && process.env.FORCE_CALENDAR !== '1') {
    console.log('非12月，跳过（正式刷新由每年12月30日的工作流触发）');
    return;
  }
  const nextY = y + 1;
  // 幂等守卫（2026-10-28）：年度日历工作流设冗余备份档，同一年度只实跑一次
  const _cs = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  if (!IS_MANUAL && !process.env.FORCE_CALENDAR_RERUN && _cs.last_calendar === String(nextY)) {
    console.log(`${nextY} 年日历已刷新过，冗余触发跳过；如需强制重跑设 FORCE_CALENDAR_RERUN=1`);
    return;
  }
  let j = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const t = await httpGet(`https://timor.tech/api/holiday/year/${nextY}`, 20000);
      j = JSON.parse(t);
      break;
    } catch (e) {
      console.log(`第${attempt}次抓取失败：${e.message || e}`);
      if (attempt < 3) await new Promise(rs => setTimeout(rs, 5000));
    }
  }
  if (!j || !j.holiday) {
    console.log(`无法获取${nextY}年节假日数据，保留现有日历文件（可稍后手动重跑本工作流）`);
    return;
  }
  const holidays = {};
  for (const [md, v] of Object.entries(j.holiday)) {
    if (v && v.holiday === true) holidays[`${nextY}-${md}`] = v.name;
  }
  const count = Object.keys(holidays).length;
  if (count < 10) {
    console.log(`${nextY}年官方数据尚未发布（仅${count}条），保留现有日历文件（可稍后手动重跑本工作流）`);
    return;
  }
  const out = {
    note: `静态法定节假日日历（${nextY}年官方数据，每年12月30日由 calendar 工作流自动抓取覆盖；仅保留当年+次年滚动窗口）。期货规则：周六日一律休市(含调休补班日)，法定节假日休市。`,
    from: `${nextY}-01-01`,
    to: `${nextY}-12-31`,
    generated: today,
    holidays
  };
  writeJson(J('config/holidays_static.json'), out);
  console.log(`已覆盖为${nextY}年官方日历：${count}天节假日（前一年数据已删除）`);
  // 清理缓存中次年之前的旧条目
  const cachePath = J('data/holidays.json');
  const cache = readJson(cachePath, {});
  const kept = Object.fromEntries(Object.entries(cache).filter(([d]) => d >= `${nextY}-01-01`));
  if (Object.keys(kept).length !== Object.keys(cache).length) {
    writeJson(cachePath, kept);
    console.log(`缓存已清理：${Object.keys(cache).length} → ${Object.keys(kept).length} 条`);
  }
  const _cs2 = readJson(J('data/state.json'), { seen: {}, last_scan: null });
  _cs2.last_calendar = String(nextY);   // 年度日历幂等标记（供冗余 cron 去重）
  writeJson(J('data/state.json'), _cs2);
}

/* ---------------- 入口 ---------------- */
const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'scan') await modeScan(arg || 'noon');
  else if (mode === 'remind') await modeRemind(arg || 'noon');
  else if (mode === 'feedback') await modeFeedback();
  else if (mode === 'daily') await modeDaily();
  else if (mode === 'nav') {
    const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
    const state = readJson(J('data/state.json'), { seen: {}, last_scan: null });
    rebuildDashboard(ledger, state);
    console.log('docs/index.html 已重建');
  }
  else if (mode === 'contracts') await modeContracts();
  else if (mode === 'pool') await modePool();
  else if (mode === 'calendar') await modeCalendar();
  else console.log('用法: node monitor.mjs scan|remind|feedback|daily|nav|contracts|pool|calendar [noon|evening|night|morning]');
} catch (e) {
  console.error('运行出错:', e);
  process.exit(1);
}
