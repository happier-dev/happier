import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadGitHubReleaseAsset } from '../dist/providers/downloadGitHubReleaseAsset.js';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
