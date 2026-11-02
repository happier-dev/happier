import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { default: MultipartResponse } = require('metro/private/Server/MultipartResponse');
const { selectNativeBundleResponse } = require('./metroNativeBundleResponse.cjs');

test('Android bundle downloads use the streaming response; other Metro requests retain negotiation', async () => {
  const code = 'globalThis.nativeBundleLoaded = true;';
  const error = JSON.stringify({ type: 'UnableToResolveError' });
  const server = createServer((request, response) => {
    selectNativeBundleResponse(request);
    const output = MultipartResponse.wrapIfSupported(request, response);
    const failed = request.url.startsWith('/missing.bundle');
    output.writeHead(failed ? 500 : 200, { 'Content-Type': failed ? 'application/json' : 'application/javascript' });
    output.end(failed ? error : code);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = pathname => new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port: server.address().port, path: pathname,
      headers: { Accept: 'multipart/mixed' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    }).on('error', reject);
  });
  try {
    const android = await request('/index.bundle?platform=android&dev=true&lazy=true');
    assert.equal(android.status, 200);
    assert.equal(android.type, 'application/javascript', 'Android must enter BundleDownloader’s disk-streaming response path');
    assert.equal(android.body, code);
    const failed = await request('/missing.bundle?platform=android');
    assert.equal(failed.status, 500);
    assert.equal(failed.type, 'application/json');
    assert.deepEqual(JSON.parse(failed.body), { type: 'UnableToResolveError' });
    for (const pathname of ['/index.bundle?platform=ios', '/index.bundle?platform=web', '/index.bundle', '/index.map?platform=android', '/status?platform=android']) {
      const unchanged = await request(pathname);
      assert.match(unchanged.type, /^multipart\/mixed;/, pathname);
      assert.ok(unchanged.body.includes(code));
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
