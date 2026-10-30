import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

test('canonical Docker publisher builds the stock Iroh relay with SBOM and provenance', () => {
  const repoRoot = process.cwd();
  const out = execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs'),
    '--channel', 'dev',
    '--registries', 'dockerhub',
    '--dry-run',
    '--build-relay', 'false',
    '--build-dev-box', 'false',
    '--build-iroh-relay', 'true',
  ], {
    cwd: repoRoot,
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(out, /docker buildx build/);
  assert.match(out, /--file\s+deploy\/iroh-relay\/Dockerfile/);
  assert.match(out, /--tag\s+happierdev\/iroh-relay:dev\b/);
  assert.match(out, /--sbom=true/);
  assert.match(out, /--provenance=true/);
  assert.match(out, /--metadata-file/);
  assert.match(out, /docker buildx imagetools inspect --raw happierdev\/iroh-relay@sha256:/);
  assert.match(out, /linux\/amd64/);
  assert.match(out, /linux\/arm64/);
  assert.match(out, /\[dry-run\] would verify pushed image index/);
  assert.doesNotMatch(out, /\[pipeline\] verified pushed image index/);
  assert.match(out, /deploy\/iroh-relay(?:\s|$)/);
  assert.doesNotMatch(out, /--target\s+relay-server/);
});

for (const [label, architecture, armDigest, expectedStatus] of [
  ['without predicate annotations', 'arm64', 'sha256:' + 'b'.repeat(64), 0],
  ['with the wrong architecture', 'riscv64', 'sha256:' + 'b'.repeat(64), 1],
  ['without an immutable platform digest', 'arm64', 'invalid', 1],
]) {
test('canonical Docker publisher verifies the immutable multiarch index ' + label, () => {
  const repoRoot = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-iroh-relay-index-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dockerPath = path.join(binDir, 'docker');
  const indexDigest = `sha256:${'0'.repeat(64)}`;
  const amd64Digest = `sha256:${'a'.repeat(64)}`;
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: amd64Digest, platform: { os: 'linux', architecture: 'amd64' } },
      { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: armDigest, platform: { os: 'linux', architecture } },
    ],
  };
  fs.writeFileSync(dockerPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `const indexDigest = ${JSON.stringify(indexDigest)};`,
    `const index = ${JSON.stringify(index)};`,
    'const args = process.argv.slice(2);',
    "if (args[0] === 'info' || args[0] === 'login') process.exit(0);",
    "if (args[0] !== 'buildx') process.exit(2);",
    "if (args[1] === 'inspect') { console.log('Driver: docker-container'); process.exit(0); }",
    "if (args[1] === 'build') {",
    "  const metadataIndex = args.indexOf('--metadata-file');",
    "  fs.writeFileSync(args[metadataIndex + 1], JSON.stringify({ 'containerimage.digest': indexDigest }));",
    '  process.exit(0);',
    '}',
    "if (args[1] === 'imagetools' && args[2] === 'inspect' && args[3] === '--raw') {",
    "  if (args[4] !== 'happierdev/iroh-relay@' + indexDigest) process.exit(2);",
    "  process.stdout.write(JSON.stringify(index));",
    '  process.exit(0);',
    '}',
    'process.exit(2);',
  ].join('\n'), { mode: 0o700 });

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs'),
      '--channel', 'dev',
      '--registries', 'dockerhub',
      '--sha', '0123456789abcdef0123456789abcdef01234567',
      '--build-relay', 'false',
      '--build-dev-box', 'false',
      '--build-iroh-relay', 'true',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        DOCKERHUB_USERNAME: 'happierdev',
        DOCKERHUB_TOKEN: 'docker-token',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus === 0) assert.match(result.stdout, /verified pushed image index/);
    else assert.match(result.stderr, /linux\/arm64/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}
