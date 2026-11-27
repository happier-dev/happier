import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('--no-push builds every image for both platforms without registry login, push, published-index checks or Sentry tracking', () => {
  const repoRoot = process.cwd();
  const out = execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs'),
    '--channel', 'dev', '--sha', '0123456789abcdef0123456789abcdef01234567',
    '--registries', 'ghcr', '--build-iroh-relay', 'true', '--no-push', '--dry-run',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GITHUB_ACTIONS: 'false', HAPPIER_DOCKER_SERVER_VERSION: '0.3.0-dev.1', HAPPIER_DOCKER_CLI_VERSION: '0.3.0-dev.1' },
  });
  const builds = out.split('\n').filter((line) => line.includes('docker buildx build'));
  assert.equal(builds.length, 3);
  for (const build of builds) {
    assert.match(build, /--platform linux\/amd64,linux\/arm64 --output type=cacheonly/);
    assert.doesNotMatch(build, /--push|--metadata-file/);
  }
  assert.doesNotMatch(out, /docker login|imagetools inspect|sentry release tracking/i);
});
