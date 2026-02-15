import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReleaseAssetBundle } from '../dist/assets.js';

test('resolveReleaseAssetBundle selects tar.gz + checksums + minisig for linux artifacts', () => {
  const assets = [
    { name: 'happier-server-v1.2.3-preview.1-linux-x64.tar.gz', browser_download_url: 'https://example/server.tgz' },
    { name: 'checksums-happier-server-v1.2.3-preview.1.txt', browser_download_url: 'https://example/checksums.txt' },
    { name: 'checksums-happier-server-v1.2.3-preview.1.txt.minisig', browser_download_url: 'https://example/checksums.txt.minisig' },
  ];

  const resolved = resolveReleaseAssetBundle({
    assets,
    product: 'happier-server',
    os: 'linux',
    arch: 'x64',
  });

  assert.equal(resolved.version, '1.2.3-preview.1');
  assert.equal(resolved.archive.name, 'happier-server-v1.2.3-preview.1-linux-x64.tar.gz');
  assert.equal(resolved.checksums.name, 'checksums-happier-server-v1.2.3-preview.1.txt');
  assert.equal(resolved.checksumsSig.name, 'checksums-happier-server-v1.2.3-preview.1.txt.minisig');
});

test('resolveReleaseAssetBundle prefers windows zip when available', () => {
  const assets = [
    { name: 'happier-server-v1.2.3-windows-x64.tar.gz', browser_download_url: 'https://example/server.tgz' },
    { name: 'happier-server-v1.2.3-windows-x64.zip', browser_download_url: 'https://example/server.zip' },
    { name: 'checksums-happier-server-v1.2.3.txt', browser_download_url: 'https://example/checksums.txt' },
    { name: 'checksums-happier-server-v1.2.3.txt.minisig', browser_download_url: 'https://example/checksums.txt.minisig' },
  ];

  const resolved = resolveReleaseAssetBundle({
    assets,
    product: 'happier-server',
    os: 'windows',
    arch: 'x64',
  });

  assert.equal(resolved.archive.name, 'happier-server-v1.2.3-windows-x64.zip');
});

test('resolveReleaseAssetBundle selects ui web bundle artifacts', () => {
  const assets = [
    { name: 'happier-ui-web-v0.3.0-preview.1.1-web-any.tar.gz', browser_download_url: 'https://example/ui.tgz' },
    { name: 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt', browser_download_url: 'https://example/ui-checksums.txt' },
    { name: 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt.minisig', browser_download_url: 'https://example/ui-checksums.txt.minisig' },
  ];

  const resolved = resolveReleaseAssetBundle({
    assets,
    product: 'happier-ui-web',
    os: 'web',
    arch: 'any',
  });

  assert.equal(resolved.archive.name, 'happier-ui-web-v0.3.0-preview.1.1-web-any.tar.gz');
  assert.equal(resolved.version, '0.3.0-preview.1.1');
});

