import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManifestRecord, parseArtifactFilename } from './lib/manifests.mjs';

test('parseArtifactFilename parses expected artifact format', () => {
  const parsed = parseArtifactFilename('happier-v1.2.3-linux-x64.tar.gz');
  assert.deepEqual(parsed, {
    product: 'happier',
    version: '1.2.3',
    os: 'linux',
    arch: 'x64',
    filename: 'happier-v1.2.3-linux-x64.tar.gz',
  });
});

test('parseArtifactFilename accepts prerelease versions containing hyphens', () => {
  const parsed = parseArtifactFilename('happier-v0.1.0-preview.71.1-linux-x64.tar.gz');
  assert.deepEqual(parsed, {
    product: 'happier',
    version: '0.1.0-preview.71.1',
    os: 'linux',
    arch: 'x64',
    filename: 'happier-v0.1.0-preview.71.1-linux-x64.tar.gz',
  });
});

test('parseArtifactFilename rejects invalid names', () => {
  assert.equal(parseArtifactFilename('happier-linux-x64.tar.gz'), null);
  assert.equal(parseArtifactFilename('happier-v1.2.3-linux-ppc.tar.gz'), null);
});

test('buildManifestRecord includes required fields and defaults', () => {
  const record = buildManifestRecord({
    product: 'hstack',
    channel: 'stable',
    version: '0.1.0',
    os: 'darwin',
    arch: 'arm64',
    url: 'https://example.com/hstack-v0.1.0-darwin-arm64.tar.gz',
    sha256: 'abc123',
  });
  assert.equal(record.product, 'hstack');
  assert.equal(record.channel, 'stable');
  assert.equal(record.rolloutPercent, 100);
  assert.equal(record.critical, false);
  assert.equal(typeof record.publishedAt, 'string');
});
