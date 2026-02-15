import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServerReleaseAssets, resolveUiWebReleaseAssets } from './releaseAssets.mjs';

test('resolveServerReleaseAssets picks tarball + checksums + minisig for linux-x64', () => {
  const release = {
    tag_name: 'server-preview',
    assets: [
      { name: 'checksums-happier-server-v0.1.0.txt', browser_download_url: 'https://example/checksums.txt' },
      { name: 'checksums-happier-server-v0.1.0.txt.minisig', browser_download_url: 'https://example/checksums.txt.minisig' },
      { name: 'happier-server-v0.1.0-linux-x64.tar.gz', browser_download_url: 'https://example/server.tgz' },
      { name: 'happier-server-v0.1.0-linux-arm64.tar.gz', browser_download_url: 'https://example/server-arm.tgz' },
    ],
  };

  const resolved = resolveServerReleaseAssets({ release, os: 'linux', arch: 'x64' });
  assert.equal(resolved.version, '0.1.0');
  assert.equal(resolved.tarball.name, 'happier-server-v0.1.0-linux-x64.tar.gz');
  assert.equal(resolved.checksums.name, 'checksums-happier-server-v0.1.0.txt');
  assert.equal(resolved.checksumsSig.name, 'checksums-happier-server-v0.1.0.txt.minisig');
});

test('resolveServerReleaseAssets prefers windows zip artifacts when available', () => {
  const release = {
    tag_name: 'server-preview',
    assets: [
      { name: 'checksums-happier-server-v0.2.0-preview.7.txt', browser_download_url: 'https://example/checksums.txt' },
      { name: 'checksums-happier-server-v0.2.0-preview.7.txt.minisig', browser_download_url: 'https://example/checksums.txt.minisig' },
      { name: 'happier-server-v0.2.0-preview.7-windows-x64.zip', browser_download_url: 'https://example/server-win.zip' },
      { name: 'happier-server-v0.2.0-preview.7-windows-x64.tar.gz', browser_download_url: 'https://example/server-win.tgz' },
    ],
  };

  const resolved = resolveServerReleaseAssets({ release, os: 'windows', arch: 'x64' });
  assert.equal(resolved.version, '0.2.0-preview.7');
  assert.equal(resolved.tarball.name, 'happier-server-v0.2.0-preview.7-windows-x64.zip');
});

test('resolveServerReleaseAssets throws when required assets are missing', () => {
  const release = { tag_name: 'server-preview', assets: [{ name: 'nope', browser_download_url: 'x' }] };
  assert.throws(() => resolveServerReleaseAssets({ release, os: 'linux', arch: 'x64' }));
});

test('resolveUiWebReleaseAssets picks ui-web tarball + checksums + minisig', () => {
  const release = {
    tag_name: 'ui-web-preview',
    assets: [
      { name: 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt', browser_download_url: 'https://example/checksums.txt' },
      { name: 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt.minisig', browser_download_url: 'https://example/checksums.txt.minisig' },
      { name: 'happier-ui-web-v0.3.0-preview.1.1-web-any.tar.gz', browser_download_url: 'https://example/ui-web.tgz' },
    ],
  };

  const resolved = resolveUiWebReleaseAssets({ release });
  assert.equal(resolved.version, '0.3.0-preview.1.1');
  assert.equal(resolved.tarball.name, 'happier-ui-web-v0.3.0-preview.1.1-web-any.tar.gz');
  assert.equal(resolved.checksums.name, 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt');
  assert.equal(resolved.checksumsSig.name, 'checksums-happier-ui-web-v0.3.0-preview.1.1.txt.minisig');
});
