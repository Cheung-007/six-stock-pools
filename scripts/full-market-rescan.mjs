const DATA_KEY = "shared-items";
const CLOUD_API_URL = process.env.STOCK_POOLS_API_URL || "https://six-stock-pools.pages.dev/api/items";
const EASTMONEY_LIST_URL = "https://push2delay.eastmoney.com/api/qt/clist/get";
const THREE_DAY_MS = 3 * 24 * 60 * 60 * 1000;
const FIELDS = "f12,f14,f2,f3,f6,f8,f9,f10,f20,f21,f23,f100,f103,f62";
const STOCK_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const ETF_FS = "b:MK0021,b:MK0022,b:MK0023,b:MK0024";

const POOL_TITLES = {
  spec_stock: "投机个股",
  spec_etf: "投机ETF",
  short_stock: "短线个股",
  short_etf: "短线ETF",
  long_stock: "长线个股",
  long_etf: "长线ETF"
};

const HOT_TOPICS = [
  ["半导体", 8], ["芯片", 8], ["人工智能", 8], ["算力", 8], ["CPO", 8],
  ["光通信", 7], ["PCB", 7], ["机器人", 6], ["消费电子", 5], ["低空经济", 5],
  ["液冷", 6], ["数据中心", 6], ["通信", 5], ["创新药", 5], ["军工", 4],
  ["汽车", 4], ["电网", 3], ["传媒", 3], ["证券", 3], ["红利", 2]
];

const ETF_EXCLUDE = /货币|现金|添益|日利|收益|理财|保证金|国债|政金债|信用债|短融|债|黄金|豆粕|有色|能源化工|油气|原油|纳指|标普|德国|法国|日本|沙特|商品|城投|可转债/;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  return handleRescan(context);
}

export async function onRequestPost(context) {
  return handleRescan(context);
}

async function handleRescan(context) {
  try {
    const previous = await context.env.STOCK_POOLS.get(DATA_KEY, "json").catch(() => null);
    const result = await buildFullMarketPortfolio(previous?.items || []);
    const saved = {
      version: 1,
      updatedAt: new Date().toISOString(),
      screening: result.screening,
      items: result.items
    };
    await context.env.STOCK_POOLS.put(DATA_KEY, JSON.stringify(saved));
    return json(saved);
  } catch (error) {
    return json({ error: "rescan failed", detail: String(error?.message || error) }, 500);
  }
}

async function buildFullMarketPortfolio(previousItems) {
  const now = new Date();
  const [rawStocks, rawEtfs] = await Promise.all([
    fetchEastmoneyList(STOCK_FS),
    fetchEastmoneyList(ETF_FS)
  ]);
  const stocks = rawStocks.filter((item) => !isBadStock(item));
  const etfs = rawEtfs.filter((item) => !isBadEtf(item));

  const usedStocks = new Set();
  const usedEtfs = new Set();

  const specStock = pick(
    stocks
      .filter((item) => item.amountWan >= 30000 && item.turnoverRate >= 2 && item.pct > -6.5 && item.pct < 8)
      .sort((a, b) => stockScore(b, "spec") - stockScore(a, "spec")),
    6,
    (item) => item.sector || topicFromSecurity(item),
    usedStocks,
    2
  );

  const shortStock = pick(
    stocks
      .filter((item) => item.amountWan >= 20000 && item.pct > -6.5 && item.pct < 7)
      .sort((a, b) => stockScore(b, "short") - stockScore(a, "short")),
    6,
    (item) => item.sector || topicFromSecurity(item),
    usedStocks,
    2
  );

  const longStock = pick(
    stocks
      .filter((item) => item.amountWan >= 12000 && item.marketCapYi >= 180 && item.pct > -6)
      .sort((a, b) => stockScore(b, "long") - stockScore(a, "long")),
    6,
    (item) => item.sector || topicFromSecurity(item),
    usedStocks,
    2
  );

  const specEtf = pick(
    etfs
      .filter((item) => item.amountWan >= 10000 && item.pct > -6.5 && item.pct < 8 && !/沪深300|中证A500|上证50|红利/.test(item.name))
      .sort((a, b) => etfScore(b, "spec") - etfScore(a, "spec")),
    6,
    etfTopic,
    usedEtfs,
    1
  );

  const shortEtf = pick(
    etfs
      .filter((item) => item.amountWan >= 8000 && item.pct > -6.5 && item.pct < 8)
      .sort((a, b) => etfScore(b, "short") - etfScore(a, "short")),
    6,
    etfTopic,
    usedEtfs,
    1
  );

  const longEtf = pick(
    etfs
      .filter((item) => item.amountWan >= 8000 && item.pct > -6.5 && /沪深300|中证A500|A500|中证500|创业板|科创50|上证50|红利|中证1000/.test(item.name))
      .sort((a, b) => etfScore(b, "long") - etfScore(a, "long")),
    6,
    etfTopic,
    usedEtfs,
    1
  );

  const items = [
    ...specStock.map((item, index) => toPoolItem(item, "spec_stock", index, now)),
    ...specEtf.map((item, index) => toPoolItem(item, "spec_etf", index, now)),
    ...shortStock.map((item, index) => toPoolItem(item, "short_stock", index, now)),
    ...shortEtf.map((item, index) => toPoolItem(item, "short_etf", index, now)),
    ...longStock.map((item, index) => toPoolItem(item, "long_stock", index, now)),
    ...longEtf.map((item, index) => toPoolItem(item, "long_etf", index, now))
  ];

  const newCodes = new Set(items.map((item) => item.code));
  const removed = previousItems
    .filter((item) => item?.code && !newCodes.has(String(item.code)))
    .slice(0, 6)
    .map((item) => ({
      type: "remove",
      applied: true,
      code: String(item.code),
      name: String(item.name || item.code),
      pool: String(item.pool || ""),
      reason: `三日全市场复核后，当前强度或周期匹配度不如新候选，先从${POOL_TITLES[item.pool] || "观察仓"}移出。`
    }));

  const added = items.slice(0, 8).map((item) => ({
    type: "add",
    applied: true,
    code: item.code,
    name: item.name,
    pool: item.pool,
    reason: `已加入${POOL_TITLES[item.pool]}：${item.note}`
  }));

  return {
    items,
    screening: {
      mode: "full-market",
      source: "东方财富全市场A股与主流ETF行情",
      updatedAt: now.toISOString(),
      nextAt: new Date(now.getTime() + THREE_DAY_MS).toISOString(),
      items: [...added, ...removed].slice(0, 12)
    }
  };
}

async function fetchEastmoneyList(fs, maxPages = 80) {
  const output = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(EASTMONEY_LIST_URL);
    Object.entries({
      pn: page,
      pz: 100,
      po: 1,
      np: 1,
      ut: "bd1d9ddb04089700cf9c27f6f7426281",
      fltt: 2,
      invt: 2,
      fid: "f6",
      fs,
      fields: FIELDS
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const payload = await fetchJsonWithRetry(url);
    const rows = payload?.data?.diff || [];
    total = payload?.data?.total || total;
    output.push(...rows.map(normalizeEastmoneyRow));
    if (!rows.length || output.length >= total) break;
  }
  return output;
}

async function fetchJsonWithRetry(url, attempt = 0) {
  try {
    const response = await fetch(String(url), {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://quote.eastmoney.com/"
      },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) throw new Error(`Eastmoney ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 4) throw error;
    await sleep(350 * (attempt + 1));
    return fetchJsonWithRetry(url, attempt + 1);
  }
}

function normalizeEastmoneyRow(row) {
  return {
    code: String(row.f12 || ""),
    name: String(row.f14 || ""),
    price: number(row.f2),
    pct: number(row.f3),
    amountWan: number(row.f6) / 10000,
    turnoverRate: number(row.f8),
    pe: number(row.f9),
    volumeRatio: number(row.f10),
    marketCapYi: number(row.f20) / 100000000,
    floatCapYi: number(row.f21) / 100000000,
    pb: number(row.f23),
    sector: String(row.f100 || "").replace("-", ""),
    concepts: String(row.f103 || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 16),
    mainNetWan: number(row.f62) / 10000
  };
}

function isBadStock(item) {
  return !item.price
    || item.price > 100
    || !item.name
    || /ST|退/.test(item.name)
    || item.amountWan < 8000;
}

function isBadEtf(item) {
  return !item.price
    || item.price > 10
    || !/ETF/.test(item.name)
    || ETF_EXCLUDE.test(item.name)
    || item.amountWan < 5000;
}

function stockScore(item, mode) {
  let score = 0;
  score += Math.min(item.amountWan / 15000, 18);
  score += Math.min(item.turnoverRate, 16);
  score += Math.min(Math.max(item.volumeRatio, 0), 5);
  score += hotScore(item);
  if (item.mainNetWan > 0) score += Math.min(item.mainNetWan / 8000, 8);
  if (item.pct > 0 && item.pct <= 5) score += 8;
  if (item.pct < -5) score -= 7;
  if (item.pct > 7) score -= 7;
  if (item.price <= 50) score += 3;
  if (mode === "short" && item.pct > -3 && item.pct < 4) score += 4;
  if (mode === "long") {
    score += Math.min(item.marketCapYi / 350, 18);
    if (item.pe > 0 && item.pe < 55) score += 4;
    if (item.pb > 0 && item.pb < 7) score += 3;
    score -= Math.max(item.turnoverRate - 10, 0) * 0.8;
    if (/银行|保险|证券|通信设备|半导体|消费电子|光学光电子|电池|医疗服务|软件开发|汽车整车|白酒|家电|工业金属|电网设备/.test(item.sector)) {
      score += 4;
    }
  }
  return score;
}

function etfScore(item, mode) {
  let score = 0;
  score += Math.min(item.amountWan / 6000, 22);
  score += hotScore(item);
  if (item.pct > 0 && item.pct <= 5) score += 7;
  if (item.pct < -6) score -= 5;
  if (mode === "long") {
    if (/沪深300|中证A500|A500|中证500|创业板|科创50|上证50|红利|央企|MSCI|中证1000/.test(item.name)) score += 18;
    if (/半导体|人工智能|通信|机器人|芯片/.test(item.name)) score += 3;
    if (item.pct < -5) score -= 3;
  }
  return score;
}

function hotScore(item) {
  const text = [item.name, item.sector, ...(item.concepts || [])].join("");
  return HOT_TOPICS.reduce((sum, [keyword, score]) => sum + (text.includes(keyword) ? score : 0), 0);
}

function pick(list, count, keyFn, usedCodes, keyLimit) {
  const selected = [];
  const keyCounts = {};
  for (let passLimit = keyLimit; passLimit <= Math.max(keyLimit + 2, 3); passLimit += 1) {
    for (const item of list) {
      if (usedCodes.has(item.code) || selected.some((row) => row.code === item.code)) continue;
      const key = keyFn(item) || "其他";
      if ((keyCounts[key] || 0) >= passLimit) continue;
      selected.push(item);
      keyCounts[key] = (keyCounts[key] || 0) + 1;
      usedCodes.add(item.code);
      if (selected.length >= count) return selected;
    }
  }
  return selected;
}

function toPoolItem(source, pool, index, now) {
  const price = formatPrice(source.price);
  return {
    id: `scan-${pool}-${source.code}-${now.toISOString().slice(0, 10)}`,
    pool,
    grade: "",
    code: source.code,
    name: source.name,
    price,
    unitCost: String(Math.round(source.price * 100)),
    status: index < 2 ? "可操作" : "观察",
    symbol: marketSymbol(source.code),
    tags: tagsFor(source, pool, index),
    note: noteFor(source, pool),
    changePct: signedPercent(source.pct),
    quoteTime: now.toISOString(),
    addedAt: now.toISOString(),
    entryAt: now.toISOString(),
    entryPrice: price,
    amountWan: String(Math.round(source.amountWan)),
    turnoverRate: formatPrice(source.turnoverRate),
    sector: source.sector || (pool.includes("etf") ? etfTopic(source) : topicFromSecurity(source)),
    concepts: source.concepts || [],
    conclusionSlot: "auto-scan",
    conclusionLabel: "全市场扫描",
    conclusionUpdatedAt: now.toISOString()
  };
}

function tagsFor(item, pool, index) {
  const main = pool.includes("etf") ? etfTopic(item) : item.sector || topicFromSecurity(item);
  const status = index < 2 ? "可操作" : "观察";
  const extras = pool.includes("etf") ? ["ETF", amountTone(item)] : [amountTone(item), ...(item.concepts || []).slice(0, 1)];
  return [status, main, ...extras].filter(Boolean).slice(0, 4);
}

function noteFor(item, pool) {
  const topic = pool.includes("etf") ? etfTopic(item) : item.sector || topicFromSecurity(item);
  const amount = amountText(item.amountWan);
  const pulse = pulseText(item);
  if (pool === "spec_stock") return `${topic}方向，成交额${amount}，${pulse}；只等放量转强或回踩承接，不追高。`;
  if (pool === "short_stock") return `${topic}方向，成交活跃，观察趋势延续和回踩承接；一到两周内不转强就降级。`;
  if (pool === "long_stock") return `${topic}方向，规模和流动性够用，重点跟踪财报、现金流和估值位置。`;
  if (pool === "spec_etf") return `${topic}方向，成交活跃，适合一到三个交易日观察强弱切换，不追单日急拉。`;
  if (pool === "short_etf") return `${topic}方向，流动性充足，观察一到两周趋势延续和回踩承接。`;
  return `${topic}方向，成交额${amount}，适合用两个月以上周期观察配置价值。`;
}

function pulseText(item) {
  if (item.pct >= 3) return "日内偏强但不适合追高";
  if (item.pct > 0) return "资金有承接，重点看量能能否连续";
  if (item.pct <= -5) return "分歧较大，先看止跌和承接";
  return "有回踩分歧，重点看承接是否稳定";
}

function amountTone(item) {
  if (item.amountWan >= 100000) return "高成交";
  if (item.amountWan >= 30000) return "成交活跃";
  return "流动性";
}

function topicFromSecurity(item) {
  const text = [item.name, item.sector, ...(item.concepts || [])].join("");
  if (/半导体|芯片|封测/.test(text)) return "半导体";
  if (/CPO|光通信|通信|5G/.test(text)) return "通信/算力";
  if (/人工智能|算力|数据中心|AI/.test(text)) return "人工智能/算力";
  if (/机器人/.test(text)) return "机器人";
  if (/PCB|元件|电子/.test(text)) return "电子元件";
  if (/创新药|医药|医疗/.test(text)) return "创新药/医药";
  if (/汽车|热管理|液冷|新能源车/.test(text)) return "汽车链";
  if (/军工|北斗|航天|航空/.test(text)) return "军工/北斗";
  if (/传媒|游戏|营销|广告/.test(text)) return "传媒/营销";
  if (/光伏|储能|电池|新能源/.test(text)) return "新能源";
  if (/证券|银行|保险|金融/.test(text)) return "金融";
  return "主线成交";
}

function etfTopic(item) {
  const name = item.name || "";
  if (/创新药|医药/.test(name)) return "创新药";
  if (/半导体|芯片|集成电路/.test(name)) return "半导体";
  if (/人工智能|AI|软件|云计算|大数据/.test(name)) return "人工智能";
  if (/通信|5G|光通信|CPO/.test(name)) return "通信/算力";
  if (/机器人/.test(name)) return "机器人";
  if (/证券|金融|银行|保险/.test(name)) return "金融";
  if (/军工|国防/.test(name)) return "军工";
  if (/消费|酒|食品|家电/.test(name)) return "消费";
  if (/新能源|电池|光伏|储能|汽车/.test(name)) return "新能源";
  if (/沪深300/.test(name)) return "沪深300";
  if (/A500|中证A500/.test(name)) return "中证A500";
  if (/中证500/.test(name)) return "中证500";
  if (/中证1000/.test(name)) return "中证1000";
  if (/科创50/.test(name)) return "科创50";
  if (/创业板/.test(name)) return "创业板";
  if (/上证50/.test(name)) return "上证50";
  if (/红利/.test(name)) return "红利";
  if (/港股|恒生/.test(name)) return "港股";
  return name.replace(/ETF.*/, "ETF").slice(0, 8) || "ETF";
}

function marketSymbol(code) {
  if (code.startsWith("6") || code.startsWith("5")) return `sh${code}`;
  return `sz${code}`;
}

function amountText(wan) {
  return wan >= 10000 ? `${(wan / 10000).toFixed(2)}亿` : `${Math.round(wan)}万`;
}

function signedPercent(value) {
  return `${value >= 0 ? "+" : ""}${formatPrice(value)}%`;
}

function formatPrice(value) {
  const numeric = number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const previous = await fetch(CLOUD_API_URL, { cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null);
  const result = await buildFullMarketPortfolio(previous?.items || []);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    screening: result.screening,
    items: result.items
  };
  const response = await fetch(CLOUD_API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`save failed ${response.status}: ${await response.text()}`);
  }
  const saved = await response.json();
  const counts = Object.fromEntries(Object.keys(POOL_TITLES).map((pool) => [
    pool,
    saved.items.filter((item) => item.pool === pool).length
  ]));
  console.log(JSON.stringify({ updatedAt: saved.updatedAt, count: saved.items.length, counts }, null, 2));
}
