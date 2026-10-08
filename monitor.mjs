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
          if (R > 0) {
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
  return { signals, bars: daily };
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
function cardSignal(p, expiry) {
  const dirTxt = p.dir === 'long' ? "<font color='red'>做多 ↑</font>" : "<font color='green'>做空 ↓</font>";
  const colorTxt = p.dir === 'long' ? '转红(R)' : '转绿(G)';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'indigo', title: { tag: 'plain_text', content: `【擒龙手】K3操作区激活 ${p.name} ${p.contract}` } },
    elements: [
      ftext(`**品种合约**：${p.name} ${p.contract}\n**开仓方向**：${dirTxt}\n**建议手数**：${p.lots} 手`),
      ftext(`**参考价**：${p.ref}（${p.date} 触发时价）\n**止损点位**：${p.stop}（操作区极值±0.5×ATR14，1R=${p.R}点≈${Math.round(p.R * p.mult)}元/手）\n**3R点位**：${p.t3}\n**5R点位**：${p.t5}`),
      ftext(`**操作**：从下一交易时段起盯3分钟K线——出现新鲜${colorTxt}即可入场；一直未转色、或收到"设置作废"通知，则放弃\n信号编号 **#${p.id}**｜反馈有效期至 **${expiry || '?'} 15:00**\n入场后到 GitHub 置顶 Issue 回复：\n**成交 #${p.id}** [实际价] [手数]　或　**未入场 #${p.id}**`),
      { tag: 'note', elements: [{ tag: 'lark_md', content: `纪律：ATR止损｜3R平半推保本余仓追5R/反向变色｜单手版3R锁+2R｜多个信号并存时回复务必带 #编号` }] }
    ]
  };
}
function cardVoid(p) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `【擒龙手】设置作废 ${p.name} ${p.contract}` } },
    elements: [
      ftext(`信号 **#${p.id}**（${p.name} ${p.contract} ${p.dir === 'long' ? '多' : '空'}）操作区已失效：价格${p.dir === 'long' ? '创新高' : '创新低'}突破基准 **${p.void_px}**。\n**请勿再按此信号入场**；若已入场，按原止损纪律执行不受影响。`),
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
  return {
    config: { wide_screen_mode: true },
    header: { template: 'indigo', title: { tag: 'plain_text', content: `【擒龙手】到位提醒 ${t.name} ${t.contract}` } },
    elements: [
      ftext(`**${t.name} ${t.contract} 目前已达到${label}点位 ${px}**\n方向：${t.dir === 'long' ? '多' : '空'}｜入场 ${t.entry}｜${t.lots} 手${extra ? '\n' + extra : ''}`),
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
function computeLots(equity, R, mult, margin1) {
  const budget = SETTINGS.risk_pct * equity;
  let lots = Math.max(1, Math.floor(budget / (R * mult)));
  while (lots > 1 && margin1 * lots > SETTINGS.margin_cap * equity) lots--;
  return lots;
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
    const bars = barCache.get(t.sym);
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

/* ---------------- 净值面板 docs/index.html ---------------- */
function renderDashboard(ledger, state) {
  const nav = ledger.nav || [];
  const lastEq = nav.length ? nav[nav.length - 1].equity : ledger.capital;
  const pnl = Math.round((lastEq - ledger.capital) * 100) / 100;
  const ret = (100 * (lastEq - ledger.capital) / ledger.capital).toFixed(1);
  let peak = ledger.capital, dd = 0;
  for (const p of nav) { peak = Math.max(peak, p.equity); dd = Math.max(dd, peak - p.equity); }
  const closed = ledger.trades.filter(t => t.status === 'closed');
  const wins = closed.filter(t => t.pnl > 0).length;
  const winRate = closed.length ? (100 * wins / closed.length).toFixed(0) : '-';
  const opens = ledger.trades.filter(t => t.status === 'open');
  const feeSum = Math.round(ledger.trades.reduce((a, t) => a + (t.fees || 0), 0) * 100) / 100;

  // SVG 权益曲线
  const W = 920, H = 260, P = 34;
  let svgPath = '', svgDots = '', ymin = 0, ymax = 0;
  if (nav.length) {
    const vs = nav.map(p => p.equity);
    ymin = Math.min(...vs, ledger.capital); ymax = Math.max(...vs, ledger.capital);
    if (ymax - ymin < 1) { ymax += 1; ymin -= 1; }
    const x = i => P + (W - 2 * P) * (nav.length === 1 ? 0.5 : i / (nav.length - 1));
    const y = v => H - P - (H - 2 * P) * (v - ymin) / (ymax - ymin);
    svgPath = nav.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
    svgDots = nav.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.equity).toFixed(1)}" r="2.2" fill="#c23531"><title>${p.d}  ${p.equity}</title></circle>`).join('');
  }
  const y0 = nav.length ? (H - P - (H - 2 * P) * (ledger.capital - ymin) / (ymax - ymin)) : H / 2;
  const row = (t, i) => {
    const sgn = t.dir === 'long' ? 1 : -1;
    const stat = t.status === 'open' ? (t.half_done ? '余仓追踪' : '持仓中') : t.reason;
    const pc = t.status === 'closed' ? (t.pnl > 0 ? '#c23531' : t.pnl < 0 ? '#1a9e4b' : '#888') : '#888';
    return `<tr><td>${t.entry_date}</td><td>${t.name} ${t.contract}</td><td style="color:${t.dir === 'long' ? '#c23531' : '#1a9e4b'}">${t.dir === 'long' ? '多' : '空'}</td><td>${t.lots0}</td><td>${t.entry}</td><td>${t.stop0}</td><td>${t.t3}</td><td>${t.t5}</td><td>${stat}</td><td style="color:${pc};font-weight:600">${t.status === 'closed' ? t.pnl : '-'}</td></tr>`;
  };
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>擒龙手 · 云端监控净值面板</title>
<style>
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#888;font-size:12px;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:140px}
.card b{display:block;font-size:22px;margin-top:4px}.card span{color:#888;font-size:12px}
.panel{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
th{background:#fafafa;color:#666;font-weight:600}
.up{color:#c23531}.dn{color:#1a9e4b}
</style></head><body>
<h1>擒龙手 · 黄大侠拐点战法 云端监控</h1>
<div class="sub">启动资金 ¥${ledger.capital.toLocaleString()}｜最近更新 ${state.last_scan || '-'}｜信号=日线全自动扫描，交易=人工执行后反馈记账</div>
<div class="cards">
<div class="card"><span>当前权益</span><b>¥${Math.round(lastEq).toLocaleString()}</b></div>
<div class="card"><span>累计盈亏</span><b class="${pnl >= 0 ? 'up' : 'dn'}">${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}</b></div>
<div class="card"><span>收益率</span><b class="${pnl >= 0 ? 'up' : 'dn'}">${ret}%</b></div>
<div class="card"><span>最大回撤</span><b>¥${Math.round(dd).toLocaleString()}</b></div>
<div class="card"><span>已平仓/胜率</span><b>${closed.length} 笔 / ${winRate}%</b></div>
<div class="card"><span>当前持仓</span><b>${opens.length} 笔</b></div>
<div class="card"><span>累计手续费</span><b>¥${feeSum.toLocaleString()}</b></div>
</div>
<div class="panel"><b>净值曲线</b><br>
<svg width="100%" viewBox="0 0 ${W} ${H}" style="margin-top:8px">
<line x1="${P}" y1="${y0}" x2="${W - P}" y2="${y0}" stroke="#bbb" stroke-dasharray="4 3"/>
<path d="${svgPath}" fill="none" stroke="#c23531" stroke-width="2"/>
${svgDots}
<text x="${W - P}" y="${P - 8}" text-anchor="end" font-size="11" fill="#888">高 ${Math.round(ymax)}</text>
<text x="${W - P}" y="${H - 6}" text-anchor="end" font-size="11" fill="#888">低 ${Math.round(ymin)}</text>
</svg></div>
<div class="panel"><b>交易记录</b>（红涨绿跌；盈亏=已扣双边手续费净额，单位：元）<br>
<table><thead><tr><th>日期</th><th>品种合约</th><th>方向</th><th>手数</th><th>入场</th><th>止损</th><th>3R</th><th>5R</th><th>状态</th><th>盈亏</th></tr></thead>
<tbody>${ledger.trades.slice().reverse().map(row).join('') || '<tr><td colspan="10" style="text-align:center;color:#999">暂无成交记录</td></tr>'}</tbody></table></div>
</body></html>`;
}
function rebuildDashboard(ledger, state) {
  fs.mkdirSync(J('docs'), { recursive: true });
  fs.writeFileSync(J('docs/index.html'), renderDashboard(ledger, state));
}

/* ---------------- 模式：scan ---------------- */
async function modeScan(slot) {
  const today = todayStr();
  console.log(`== scan ${slot} @ ${nowStr()} (today=${today}) ==`);
  if (!(await isTradingDay(today))) { console.log('非交易日，跳过'); return; }

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
    try { barCache.set(spec.code, await fetchDaily(spec.code)); }
    catch (e) { console.log(`  ${spec.name} 数据失败: ${e.message}`); }
  }
  const lastPx = {};
  for (const [code, bars] of barCache) if (bars.length) lastPx[code] = bars[bars.length - 1].c;
  const equity = equityNow(ledger, lastPx);

  // 信号扫描
  let newCnt = 0, skipCnt = { seen: 0, zone3: 0, afford: 0, dup: 0, hold: 0 };
  for (const spec of POOL) {
    const bars = barCache.get(spec.code);
    if (!bars || bars.length < SETTINGS.min_history) { console.log(`  ${spec.name} 数据不足，跳过`); continue; }
    const { signals } = replayDaily(bars.map(b => ({ ...b })), spec);
    const lastDate = bars[bars.length - 1].d;
    const zoneCount = {};
    for (const s of signals) zoneCount[s.zoneId] = (zoneCount[s.zoneId] || 0) + 1;

    for (const s of signals) {
      const key = `${spec.code}|${s.date}|${s.dir}|${s.zoneId}`;
      if (state.seen[key]) continue;
      state.seen[key] = { date: s.date, alerted: false };
      if (s.date !== lastDate) continue;                      // 历史信号仅播种
      if (zoneCount[s.zoneId] > SETTINGS.max_zone_signals) { skipCnt.zone3++; continue; }
      if (pending.items.some(p => p.sym === spec.code && p.date === s.date && p.dir === s.dir && ['pending', 'reminded'].includes(p.status))) { skipCnt.dup++; continue; }
      if (ledger.trades.some(t => t.status === 'open' && t.sym === spec.code && t.dir === s.dir)) { skipCnt.hold++; continue; }
      const margin1 = s.ref * spec.mult * spec.rate;
      if (margin1 > equity) { skipCnt.afford++; console.log(`  ${spec.name} 保证金${Math.round(margin1)}>权益${Math.round(equity)}，不提醒`); continue; }
      if (blackout) continue;                                  // 禁提醒日仅记录
      // V2优化：止损宽度 = 区极值 ± 0.5×ATR14(3分钟)，随品种波动率自适应（原固定±3跳，回测PF 1.29→1.46）
      // 失败回退：拉不到3分钟数据则沿用日线状态机的±3跳止损
      const atrMult = SETTINGS.stop_atr_mult ?? 0.5;
      let stop = s.stop, R = s.R, t3 = s.t3, t5 = s.t5, stopNote = '3跳';
      if (atrMult > 0) {
        try {
          if (!min3Cache.has(spec.code)) min3Cache.set(spec.code, await fetch3min(spec.code));
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
      const lots = computeLots(equity, R, spec.mult, margin1);
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

  // 已提醒信号的生命周期管理：①设置作废（价格破基准）②反馈超期自动关闭
  for (const p of pending.items) {
    if (p.status !== 'reminded') continue;
    const bars = barCache.get(p.sym);
    if (p.void_px != null && bars && bars.length) {
      const voidHit = bars.filter(b => b.d >= p.date)
        .some(b => p.dir === 'long' ? b.h > p.void_px : b.l < p.void_px);
      if (voidHit) {
        p.status = 'invalidated'; p.invalidated_at = nowStr();
        if (!blackout) await feishuSend(cardVoid(p));
        console.log(`  ✗ 设置作废 ${p.id} ${p.name}：价格已破基准 ${p.void_px}，操作区失效`);
        continue;
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
  const pending = readJson(J('data/pending.json'), { seq: 0, items: [] });
  const blackout = await isBlackout(today);
  let sent = 0, expired = 0;

  for (const p of pending.items) {
    if (p.status !== 'pending') continue;
    if (p.remind_date > today) continue;
    if (p.remind_date < today || p.slot !== slot) { p.status = 'expired'; expired++; continue; }
    if (blackout) { p.status = 'expired'; expired++; console.log(`  禁提醒日，信号 ${p.id} 作废：${blackout}`); continue; }
    const expiry = await nextTradingDay(p.remind_date);
    const ok = await feishuSend(cardSignal(p, expiry));
    if (ok) { p.status = 'reminded'; p.reminded_at = nowStr(); sent++; console.log(`  → 已提醒 ${p.id} ${p.name} ${p.contract}`); }
  }
  // 心跳：本时段无信号提醒时发一条存活确认（可在 settings.json 关闭）
  if (sent === 0 && SETTINGS.heartbeat !== false) {
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
  console.log(`完成：发送 ${sent}，过期 ${expired}`);
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
      if (!px) { try { const bars = await fetchDaily(t.sym); px = bars[bars.length - 1].c; } catch { px = t.entry; } }
      closeTrade(t, px, today, '手动平仓');
      processed = true;
      console.log(`  平仓登记 ${t.id} @${px} 盈亏 ${t.pnl}`);
      await feishuSend(cardFbAck('【擒龙手】平仓已入账 ' + t.id, [
        `**${t.name} ${t.contract}** ${t.dir === 'long' ? '多' : '空'} ${t.lots0} 手 @ ${px}`,
        `本单净盈亏（已扣双边手续费）：**${t.pnl} 元**`
      ], t.pnl > 0 ? 'green' : 'wathet'));
    }
  } else {
    console.log('  未识别指令（支持：成交 #信号号 [价] [手数] / 未入场 #信号号 / 平仓 #单号 [价]）');
    await feishuSend(cardFbAck('【擒龙手】未能识别回复', [
      `您的回复："${body.slice(0, 60)}" 未匹配任何指令。`,
      '支持格式：\n**成交 #信号号 [实际价] [手数]**（如：成交 #S20261008-001 935 2）\n**未入场 #信号号**\n**平仓 #单号 [实际价]**（如：平仓 #T0007 921）',
      '多个信号并存时务必带 #编号；不带编号将匹配"最新一条有效信号/持仓"，存在错配风险。'
    ], 'red'));
  }

  if (processed) {
    const lastPx = {};
    for (const t of ledger.trades) if (t.status === 'open') { try { const b = await fetchDaily(t.sym); lastPx[t.sym] = b[b.length - 1].c; } catch { } }
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
  const changed = advanceContracts(today);
  console.log(changed ? '已更新合约' : '无需换月');
  for (const spec of POOL) {
    const c = CONTRACTS[spec.code];
    if (c) console.log(`  ${spec.name.padEnd(4, '　')} main=${c.main} next=${c.next} rollover=${c.rollover}`);
  }
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
      const dep = last20.reduce((a, b) => a + (b.p || 0) * ((b.s || b.c)) * spec.mult * spec.rate, 0) / last20.length / 1e8;
      const lastC = bars[bars.length - 1].s || bars[bars.length - 1].c;
      const margin1 = lastC * spec.mult * spec.rate;
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
}

/* ---------------- 入口 ---------------- */
const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'scan') await modeScan(arg || 'noon');
  else if (mode === 'remind') await modeRemind(arg || 'noon');
  else if (mode === 'feedback') await modeFeedback();
  else if (mode === 'nav') {
    const ledger = readJson(J('data/ledger.json'), { capital: 5000, seq: 0, trades: [], nav: [] });
    const state = readJson(J('data/state.json'), { seen: {}, last_scan: null });
    rebuildDashboard(ledger, state);
    console.log('docs/index.html 已重建');
  }
  else if (mode === 'contracts') await modeContracts();
  else if (mode === 'pool') await modePool();
  else if (mode === 'calendar') await modeCalendar();
  else console.log('用法: node monitor.mjs scan|remind|feedback|nav|contracts|pool|calendar [noon|evening|night|morning]');
} catch (e) {
  console.error('运行出错:', e);
  process.exit(1);
}
