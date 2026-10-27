'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname;
const CORE_FILE = path.join(ROOT, '7AMO.core');
const SEALED_SEED = [175,3,33,183,190,178,42,48,151,115,143,237,241,104,124,7,5,125,154,78,40,107,32,194,132,238,96,26,55,121,92,133];
const MODULES = new Map();
const CACHE = new Map();

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fail() {
  console.error('NaHost Bot: تعذّر التحقق من سلامة النسخة. أعد فك الحزمة الأصلية.');
  process.exit(1);
}

function openCore() {
  const file = fs.readFileSync(CORE_FILE);
  const payload = JSON.parse(file.toString('utf8'));
  if (payload.v !== 1 || payload.alg !== 'aes-256-gcm' || !payload.iv || !payload.tag || !payload.data) {
    throw new Error('CORE_FORMAT');
  }
  const seed = Buffer.from(SEALED_SEED.map((value, index) => value ^ ((index * 29 + 0x63) & 0xff)));
  const key = crypto.createHash('sha256').update(seed).digest();
  seed.fill(0);
  let clear;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    clear = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
  } finally {
    key.fill(0);
  }
  let bundle;
  try { bundle = JSON.parse(clear.toString('utf8')); }
  finally { clear.fill(0); }
  if (bundle.version !== 1 || typeof bundle.loaderSha256 !== 'string' || !bundle.modules || typeof bundle.modules !== 'object') {
    throw new Error('CORE_SCHEMA');
  }
  if (sha256(fs.readFileSync(__filename)) !== bundle.loaderSha256) throw new Error('LOADER_CHECK');
  for (const [id, source] of Object.entries(bundle.modules)) {
    if (!/^src\/[a-z-]+\.js$/.test(id) || typeof source !== 'string') throw new Error('CORE_MODULE');
    MODULES.set(id, source);
  }
  for (const required of ['src/index.js', 'src/constants.js', 'src/brand-guard.js', 'src/uploader.js']) {
    if (!MODULES.has(required)) throw new Error('CORE_REQUIRED_MODULE');
  }
}

function resolveInternal(request, parentId) {
  if (!request.startsWith('./') && !request.startsWith('../')) return null;
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(parentId), request));
  const withExt = candidate.endsWith('.js') ? candidate : `${candidate}.js`;
  if (withExt.startsWith('../') || !MODULES.has(withExt)) throw new Error('MODULE_RESOLUTION');
  return withExt;
}

function loadModule(id) {
  if (CACHE.has(id)) return CACHE.get(id).exports;
  const source = MODULES.get(id);
  if (typeof source !== 'string') throw new Error('MODULE_MISSING');
  const module = { exports: {} };
  CACHE.set(id, module);
  const filename = path.join(ROOT, ...id.split('/'));
  const localRequire = (request) => {
    const internal = resolveInternal(request, id);
    return internal ? loadModule(internal) : require(request);
  };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  fn(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

async function runSelfTest() {
  const assert = require('node:assert/strict');
  for (const source of MODULES.values()) {
    // Compile every encrypted module without executing startup code.
    new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  }
  loadModule('src/brand-guard.js').verifyBrand();
  const uploader = loadModule('src/uploader.js');
  assert.equal(uploader.isCatboxUrl('https://files.catbox.moe/abc123.png'), true);
  assert.equal(uploader.isCatboxUrl('https://files.catbox.moe.evil.example/abc.png'), false);
  assert.equal(uploader.isCatboxUrl('http://files.catbox.moe/abc.png'), false);
  assert.equal(uploader.isBlockedFile('movie.mp4'), false);
  assert.equal(uploader.isBlockedFile('file.exe'), true);
  assert.equal(uploader.isBlockedFile('file.docx'), true);

  const previousFetch = global.fetch;
  const fileBytes = Buffer.from('Na-local-upload-test');
  let downloaded = 0;
  let uploaded = 0;
  global.fetch = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    if (url.hostname === 'cdn.discordapp.com') {
      downloaded += 1;
      return new Response(fileBytes, {
        status: 200,
        headers: { 'content-length': String(fileBytes.length), 'content-type': 'image/png' },
      });
    }
    if (url.hostname === 'catbox.moe' && url.pathname === '/user/api.php') {
      uploaded += 1;
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('reqtype'), 'fileupload');
      assert.equal(options.body.get('fileToUpload').name, 'picture.png');
      return new Response('https://files.catbox.moe/abc123.png', { status: 200 });
    }
    throw new Error('MOCK_HOST_REJECTED');
  };
  try {
    const result = await uploader.uploadAttachment({
      url: 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/picture.png',
      name: 'picture.png', size: fileBytes.length, contentType: 'image/png',
    });
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://files.catbox.moe/abc123.png');
    assert.equal(result.size, fileBytes.length);
    assert.equal(downloaded, 1);
    assert.equal(uploaded, 1);
    let denied = false;
    try {
      await uploader.uploadAttachment({ url: 'https://cdn.discordapp.com/a/b/payload.exe', name: 'payload.exe', size: 1 });
    } catch (error) { denied = error.code === 'FILE_TYPE_BLOCKED'; }
    assert.equal(denied, true);
  } finally {
    global.fetch = previousFetch;
  }
}

async function main() {
  openCore();
  if (process.argv.includes('--verify')) {
    await runSelfTest();
    console.log('7amoHost Bot: سلامة النسخة واختبارات الرفع المحلي ناجحة.');
    return;
  }
  loadModule('src/index.js');
}

main().catch(() => fail());
