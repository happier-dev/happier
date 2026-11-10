import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

for (const entrypoint of ['direct', 'pipeline']) {
test(`${entrypoint} Docker publisher selects only the SQLite helper in both registries`, () => {
  const out = execFileSync(process.execPath, [
    ...(entrypoint === 'direct'
      ? [path.join(process.cwd(), 'scripts/pipeline/docker/publish-images.mjs')]
      : [path.join(process.cwd(), 'scripts/pipeline/run.mjs'), 'docker-publish', '--secrets-source', 'env']),
    '--channel', 'dev',
    '--sha', '0123456789abcdef0123456789abcdef01234567',
    '--registries', 'dockerhub,ghcr',
    '--dry-run',
    '--build-relay', 'false',
    '--build-dev-box', 'false',
    '--build-sqlite-helper', 'true',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, GITHUB_ACTIONS: 'false', GHCR_NAMESPACE: 'ghcr.io/happier-dev' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(out, /--file\s+deploy\/sqlite-helper\/Dockerfile/);
  assert.match(out, /--platform\s+linux\/amd64,linux\/arm64/);
  assert.match(out, /--tag\s+happierdev\/sqlite-helper:dev\b/);
  assert.match(out, /--tag\s+ghcr\.io\/happier-dev\/sqlite-helper:dev\b/);
  assert.match(out, /--sbom=true/);
  assert.match(out, /--provenance=true/);
  assert.match(out, /--metadata-file/);
  assert.match(out, /docker buildx imagetools inspect --raw happierdev\/sqlite-helper@sha256:/);
  assert.match(out, /docker buildx imagetools inspect --raw ghcr\.io\/happier-dev\/sqlite-helper@sha256:/);
  assert.match(out, /deploy\/sqlite-helper(?:\s|$)/);
  const builds = out.split('\n').filter((line) => line.includes('docker buildx build')).join('\n');
  assert.doesNotMatch(builds, /relay-server|iroh-relay|dev-box/);
  assert.doesNotMatch(out, /resolve-artifact/);
  assert.doesNotMatch(out, /\[pipeline\] verified pushed image index/);
});
}
