module.exports = async function handler(_req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, ts: Date.now() }));
};

