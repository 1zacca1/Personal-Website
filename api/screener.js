// Simple in-memory cache — persists across warm invocations on the same instance
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'FMP_API_KEY is not configured. Add it to your Vercel environment variables. Get a free key at financialmodelingprep.com.',
    });
  }

  const { maxCap = '300000000', maxPE = '10', ncRatio = '1.5' } = req.query;
  const maxPENum = parseFloat(maxPE);
  const ncRatioNum = parseFloat(ncRatio);

  // Serve from cache when only filter params differ (cache holds the full enriched list)
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return res.status(200).json(applyFilters(_cache, maxPENum, ncRatioNum, parseFloat(maxCap)));
  }

  try {
    // Step 1: Screen for small US companies
    const screenerUrl = new URL('https://financialmodelingprep.com/api/v3/stock-screener');
    screenerUrl.searchParams.set('marketCapMoreThan', '5000000');
    screenerUrl.searchParams.set('marketCapLessThan', '500000000'); // always fetch wide set; filter later
    screenerUrl.searchParams.set('priceMoreThan', '0.10');
    screenerUrl.searchParams.set('isEtf', 'false');
    screenerUrl.searchParams.set('isActivelyTrading', 'true');
    screenerUrl.searchParams.set('country', 'US');
    screenerUrl.searchParams.set('limit', '200');
    screenerUrl.searchParams.set('apikey', apiKey);

    const screenerRes = await fetch(screenerUrl.toString());
    const stocks = await screenerRes.json();

    if (!Array.isArray(stocks)) {
      return res.status(502).json({ error: 'Failed to fetch stock list — check your API key.' });
    }

    // Step 2: Enrich up to 100 stocks with key metrics (1 call each)
    const candidates = stocks.slice(0, 100);
    const enriched = [];

    await Promise.allSettled(
      candidates.map(async (stock) => {
        try {
          const url = `https://financialmodelingprep.com/api/v3/key-metrics-ttm/${stock.symbol}?apikey=${apiKey}`;
          const mRes = await fetch(url);
          const mData = await mRes.json();
          const m = Array.isArray(mData) ? mData[0] : mData;

          if (!m || m['Error Message'] || typeof m.peRatioTTM === 'undefined') return;

          enriched.push({
            symbol: stock.symbol,
            name: stock.companyName,
            price: stock.price,
            marketCap: stock.marketCap,
            sector: stock.sector,
            industry: stock.industry,
            country: stock.country,
            exchange: stock.exchangeShortName,
            // profitability
            pe: m.peRatioTTM,
            earningsYield: m.earningsYieldTTM,
            freeCashFlowYield: m.freeCashFlowYieldTTM,
            roic: m.roicTTM,
            roe: m.roeTTM,
            // net cash / balance sheet
            netCashPerShare: m.netCashPerShareTTM,
            netCurrentAssetValue: m.netCurrentAssetValueTTM, // Graham net-net
            cashPerShare: m.cashPerShareTTM,
            debtPerShare: m.interestDebtPerShareTTM,
            currentRatio: m.currentRatioTTM,
            pbRatio: m.pbRatioTTM,
          });
        } catch {
          // Skip failures silently
        }
      })
    );

    _cache = enriched;
    _cacheTime = Date.now();

    return res.status(200).json(applyFilters(enriched, maxPENum, ncRatioNum, parseFloat(maxCap)));
  } catch (err) {
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
}

function applyFilters(stocks, maxPE, ncRatio, maxCap) {
  return stocks.filter((s) => {
    // Market cap filter
    if (s.marketCap > maxCap) return false;

    // Must have positive, single-digit P/E
    const peOk = typeof s.pe === 'number' && s.pe > 0 && s.pe <= maxPE;
    if (!peOk) return false;

    // Net cash ratio (price relative to net cash per share)
    if (ncRatio < 900 && typeof s.netCashPerShare === 'number' && s.netCashPerShare > 0) {
      if (s.price > s.netCashPerShare * ncRatio) return false;
    } else if (ncRatio < 900 && (!s.netCashPerShare || s.netCashPerShare <= 0)) {
      // Negative net cash — exclude when filtering for net cash discounts
      return false;
    }

    // Must show some sign of profitability
    const profitable =
      (typeof s.roic === 'number' && s.roic > 0) ||
      (typeof s.earningsYield === 'number' && s.earningsYield > 0);
    if (!profitable) return false;

    return true;
  });
}
