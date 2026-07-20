// 聚餐管理 · 零依赖云端后端
// 功能：托管 public/index.html，提供 GET/POST /data 读写云端数据文件 data.json
// 运行：node server.js  （默认端口 3000，可用 PORT 环境变量覆盖）
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// 数据文件路径：优先写到挂载的持久卷（如 Koyeb 卷挂到 /data），否则落到程序目录
const DATA_DIR = process.env.MOUNT_PATH || ROOT;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 种子数据：与前端 SEED_PAYERS / SEED_EXPENSES 保持一致（首次访问时用）
const SEED = {
  payers: [
    {name:'段惊涛',status:'join',due:300,paid:0,adults:2,children:0},
    {name:'吴春海',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'常进',status:'join',due:300,paid:0,adults:2,children:1},
    {name:'翟旭阳',status:'join',due:300,paid:0,adults:1,children:1},
    {name:'梁行志',status:'join',due:300,paid:0,adults:2,children:1},
    {name:'李超美',status:'join',due:300,paid:0,adults:1,children:0},
    {name:'赵春喜',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'李新杰',status:'join',due:300,paid:0,adults:2,children:0},
    {name:'安康',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'孙中启',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'李浩然',status:'join',due:300,paid:0,adults:2,children:0},
    {name:'徐琼',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'王磊',status:'join',due:300,paid:0,adults:2,children:2},
    {name:'王伟锋',status:'pending',due:300,paid:0,adults:0,children:0},
    {name:'吕科',status:'pending',due:300,paid:0,adults:0,children:0},
    {name:'王书华',status:'pending',due:300,paid:0,adults:0,children:0},
    {name:'张增峰',status:'pending',due:300,paid:0,adults:0,children:0},
  ],
  expenses: [{cat:'餐费', name:'', amount:0, payer:''}],
  cap: 10, seatManual: false, seatTables: null, seatNotes: [], mask: true, history: 0,
};

// 写锁：避免并发保存互相覆盖
let writeChain = Promise.resolve();

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    // 没有文件或损坏 → 用种子并落盘
    const seeded = JSON.parse(JSON.stringify(SEED));
    try { fs.mkdirSync(DATA_DIR, {recursive:true}); fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2)); } catch (_) {}
    return seeded;
  }
}

function sanitize(obj) {
  // 简单校验，避免写入脏数据导致前端崩溃
  if (!obj || typeof obj !== 'object') return JSON.parse(JSON.stringify(SEED));
  const out = {
    payers: Array.isArray(obj.payers) ? obj.payers.filter(p => p && typeof p === 'object').map(p => ({
      name: String(p.name != null ? p.name : ''),
      status: ['join','pending','no'].includes(p.status) ? p.status : 'pending',
      due: Number(p.due || 0),
      paid: Number(p.paid || 0),
      adults: Math.max(0, Number(p.adults || 0)),
      children: Math.max(0, Number(p.children || 0)),
    })) : JSON.parse(JSON.stringify(SEED.payers)),
    expenses: Array.isArray(obj.expenses) ? obj.expenses.map(e => ({
      cat: String(e.cat != null ? e.cat : ''),
      name: String(e.name != null ? e.name : ''),
      amount: Number(e.amount || 0),
      payer: String(e.payer != null ? e.payer : ''),
    })) : JSON.parse(JSON.stringify(SEED.expenses)),
    cap: Math.max(1, Number(obj.cap || 10)),
    seatManual: !!obj.seatManual,
    seatTables: obj.seatTables || null,
    seatNotes: Array.isArray(obj.seatNotes) ? obj.seatNotes.map(String) : [],
    mask: obj.mask !== false,
    history: Number(obj.history || 0),
  };
  return out;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(body);
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // 数据接口
  if (pathname === '/data') {
    if (req.method === 'GET') {
      return sendJSON(res, 200, readData());
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return sendJSON(res, 400, {ok:false, error:'JSON 解析失败'}); }
        const clean = sanitize(parsed);
        // 串行写入，避免并发覆盖
        writeChain = writeChain.then(() => new Promise((resolve) => {
          try { fs.mkdirSync(DATA_DIR, {recursive:true}); } catch (_) {}
          fs.writeFile(DATA_FILE, JSON.stringify(clean, null, 2), (err) => {
            if (err) return sendJSON(res, 500, {ok:false, error:'保存失败'}) || resolve();
            sendJSON(res, 200, {ok:true});
            resolve();
          });
        }));
        return;
      });
      return;
    }
    return sendJSON(res, 405, {ok:false, error:'方法不支持'});
  }

  // 静态文件（默认 index.html）
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(path.join(PUBLIC, filePath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 兜底：未知路径回 index.html
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, {'Content-Type': MIME['.html']});
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`聚餐管理云端已启动： http://0.0.0.0:${PORT}`);
});
