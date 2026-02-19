module.exports = async function handler(req, res) {
  try {
    const response = await fetch(
      'https://www.goodreads.com/review/list_rss/145297564?shelf=read&per_page=24',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!response.ok) throw new Error(`Goodreads returned ${response.status}`);
    const xml = await response.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch books' });
  }
};
