// Scrapes thezenofinvesting.com/recent-spinoffs/ server-side (avoids CORS/403).
// In-memory cache for 4 hours; falls back to stale cache on fetch failure.

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return res.status(200).json({
      data: _cache,
      cached: true,
      updatedAt: new Date(_cacheTime).toISOString(),
    });
  }

  try {
    const response = await fetch('https://thezenofinvesting.com/recent-spinoffs/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const spinoffs = parseSpinoffs(html);

    _cache = spinoffs;
    _cacheTime = Date.now();
    return res.status(200).json({
      data: spinoffs,
      cached: false,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (_cache) {
      return res.status(200).json({
        data: _cache,
        cached: true,
        stale: true,
        updatedAt: new Date(_cacheTime).toISOString(),
        warning: 'Live fetch failed — showing cached data.',
      });
    }
    return res.status(500).json({ error: 'Unable to fetch spinoffs: ' + err.message });
  }
};

// ── HTML helpers ─────────────────────────────────────────────────────────────

function stripTags(html) {
  return html
    .replace(/<a[^>]*href=['"]([\'"]+)['"][^>]*>(.*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHref(cellHtml) {
  const m = cellHtml.match(/href=['"]([^'"]+)['"]/i);
  return m ? m[1] : null;
}

// ── Main parser ───────────────────────────────────────────────────────────────

function parseSpinoffs(html) {
  const results = [];

  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];

    let headers = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRe.exec(tableHtml)) !== null) {
      headers.push(stripTags(thMatch[1]).toLowerCase());
    }

    if (!headers.length) {
      const firstRowMatch = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
      if (firstRowMatch) {
        const tdRe2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let td2;
        while ((td2 = tdRe2.exec(firstRowMatch[1])) !== null) {
          headers.push(stripTags(td2[1]).toLowerCase());
        }
      }
    }

    if (headers.length < 2) continue;

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      if (rowHtml.includes('<th')) continue;

      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells = [];
      const hrefs = [];
      let tdMatch;

      while ((tdMatch = tdRe.exec(rowHtml)) !== null) {
        cells.push(stripTags(tdMatch[1]));
        hrefs.push(extractHref(tdMatch[1]));
      }

      if (cells.length < 2 || cells.every(c => !c)) continue;

      const raw = {};
      headers.forEach((h, i) => {
        if (cells[i] !== undefined) raw[h] = cells[i];
      });

      const entry = normalizeEntry(raw, headers, cells, hrefs);
      if (entry) results.push(entry);
    }
  }

  // Keep 2026 entries (and undated entries)
  return results.filter(s => {
    const d = s.date || '';
    if (!d) return true;
    const m = d.match(/20(\d{2})/);
    if (!m) return true;
    return m[0] === '2026';
  });
}

// ── Field normalisation ───────────────────────────────────────────────────────

const FIELD_MAP = {
  date: [
    'date', 'ex-date', 'ex date', 'effective date', 'distribution date',
    'record date', 'payable date', 'announcement date', 'spinoff date',
    'pay date', 'record', 'ex',
  ],
  parent: [
    'parent', 'parent company', 'company', 'parent co.', 'parent co',
    'from', 'source company', 'parent name', 'parent corp',
  ],
  spinoff: [
    'spinoff', 'spin-off', 'spinoff company', 'new company', 'child',
    'subsidiary', 'entity', 'spinco', 'new entity', 'spun off company',
    'spun-off company',
  ],
  parentTicker: [
    'parent ticker', 'parent symbol', 'ticker (parent)', 'parent (ticker)',
    'original ticker', 'parent tick', 'parent stk',
  ],
  spinoffTicker: [
    'spinoff ticker', 'new ticker', 'ticker', 'symbol', 'new symbol',
    'spin-off ticker', 'tick', 'stk', 'spinco ticker',
  ],
  exchange: ['exchange', 'listing', 'market', 'listed on', 'exch', 'listed'],
  ratio: [
    'ratio', 'distribution ratio', 'spin ratio', 'terms', 'distribution terms',
    'shares per share', 'spin-off ratio',
  ],
  sector: ['sector', 'industry', 'type', 'segment'],
  notes: ['notes', 'note', 'description', 'comments', 'details', 'status', 'remarks'],
};

function normalizeEntry(raw, headers, cells, hrefs) {
  const result = {};

  for (const [field, variants] of Object.entries(FIELD_MAP)) {
    for (const v of variants) {
      if (raw[v] != null && raw[v] !== '') {
        result[field] = raw[v];
        break;
      }
    }
  }

  if (!result.parent && !result.spinoff && cells.length >= 2) {
    const first = cells[0] || '';
    const looksLikeDate = /\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(first);
    if (looksLikeDate) {
      result.date   = first;
      result.parent = cells[1] || '';
      result.spinoff = cells[2] || '';
    } else {
      result.parent  = cells[0];
      result.spinoff = cells[1];
    }
  }

  if (!result.parent && !result.spinoff) return null;
  if (
    (result.parent  || '').toLowerCase().includes('company') &&
    (result.spinoff || '').toLowerCase().includes('company')
  ) return null;

  return result;
}
