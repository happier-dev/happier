import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchNodeRuntimeReleaseAsset } from '../dist/providers/nodeRelease.js';

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    async text() {
      return value;
    },
  };
}

test('fetchNodeRuntimeReleaseAsset prefers tar.xz when that is the published linux arm64 asset', async () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
  try {
    const release = await fetchNodeRuntimeReleaseAsset({
      processEnv: {},
      fetchImpl: async (url) => {
        if (String(url).endsWith('/index.json')) {
          return jsonResponse([{ version: 'v24.14.0', lts: 'Jod' }]);
        }
        if (String(url).endsWith('/SHASUMS256.txt')) {
          return textResponse(
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v24.14.0-linux-arm64.tar.xz\n',
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    assert.equal(release.name, 'node-v24.14.0-linux-arm64.tar.xz');
    assert.equal(release.url, 'https://nodejs.org/download/release/v24.14.0/node-v24.14.0-linux-arm64.tar.xz');
    assert.equal(release.digest, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(release.binaryRelativePath, 'bin/node');
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    Object.defineProperty(process, 'arch', { configurable: true, value: originalArch });
  }
});
