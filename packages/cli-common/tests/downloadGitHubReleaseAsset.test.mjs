import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadGitHubReleaseAsset } from '../dist/providers/downloadGitHubReleaseAsset.js';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('downloadGitHubReleaseAsset cancels a stalled response body and removes partial output', { timeout: 5_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-download-release-abort-'));
  const destinationPath = join(tmp, 'asset.bin');
  const controller = new AbortController();
  const progress = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('first chunk');
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const downloading = downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${port}/asset.bin`, destinationPath,
      signal: controller.signal,
      onProgress: (event) => {
        progress.push(event);
        if (event.bytesDone > 0) controller.abort();
      },
    });
    // The test deadline is a harness bound; the download itself has no elapsed/idle cutoff.
    let cancel;
    try {
      await assert.rejects(Promise.race([
        downloading,
        new Promise((_resolve, reject) => { cancel = setTimeout(() => reject(new Error('body did not cancel')), 500); }),
      ]), { name: 'AbortError' });
    } finally {
      clearTimeout(cancel);
    }
    assert.ok(progress.some((event) => event.bytesDone === 11 && event.bytesTotal === 1000));
    await assert.rejects(stat(`${destinationPath}.download`), { code: 'ENOENT' });
    await assert.rejects(stat(destinationPath), { code: 'ENOENT' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test('downloadGitHubReleaseAsset cancels retry waits without issuing another request', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-download-release-retry-abort-'));
  const controller = new AbortController();
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(504);
    res.end();
    setTimeout(() => controller.abort(), 25);
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await assert.rejects(downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${port}/asset.bin`, destinationPath: join(tmp, 'asset.bin'), signal: controller.signal,
    }), { name: 'AbortError' });
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test('downloadGitHubReleaseAsset downloads assets without relying on fetch', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-download-release-'));
  const destinationPath = join(tmp, 'asset.bin');
  const originalFetch = global.fetch;
  const server = createServer((req, res) => {
    assert.equal(req.headers.accept, 'application/octet-stream');
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('hello ');
    res.end('world');
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    global.fetch = async () => {
      throw new Error('downloadGitHubReleaseAsset should not call fetch');
    };

    await downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${port}/asset.bin`,
      destinationPath,
      digest: `sha256:${sha256Hex('hello world')}`,
      userAgent: 'happier-cli-test',
    });

    assert.equal(await readFile(destinationPath, 'utf8'), 'hello world');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    global.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('downloadGitHubReleaseAsset retries transient 504 responses', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-download-release-retry-'));
  const destinationPath = join(tmp, 'asset.bin');
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    assert.equal(req.headers.accept, 'application/octet-stream');
    if (requestCount === 1) {
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('gateway timeout');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('retried download');
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    await downloadGitHubReleaseAsset({
      url: `http://127.0.0.1:${port}/asset.bin`,
      destinationPath,
      digest: `sha256:${sha256Hex('retried download')}`,
      userAgent: 'happier-cli-test',
    });

    assert.equal(await readFile(destinationPath, 'utf8'), 'retried download');
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tmp, { recursive: true, force: true });
  }
});
