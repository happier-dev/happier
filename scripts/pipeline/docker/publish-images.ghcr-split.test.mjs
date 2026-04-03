import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function run(cmd, args, opts) {
  return execFileSync(cmd, args, {
    cwd: opts?.cwd ?? process.cwd(),
    env: opts?.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('docker publish splits buildx pushes by registry when pushing to dockerhub + ghcr', () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs');

  const out = run(process.execPath, [scriptPath, '--channel', 'dev', '--registries', 'dockerhub,ghcr', '--dry-run'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'false',
      GHCR_NAMESPACE: 'ghcr.io/happier-dev',
    },
  });

  assert.match(out, /--tag\s+happierdev\/relay-server:dev\b/);
  assert.match(out, /--tag\s+ghcr\.io\/happier-dev\/relay-server:dev\b/);

  const relayBuildInvocations = out.match(/docker buildx build[\s\S]*?--target\s+relay-server/g) ?? [];
  assert.ok(
    relayBuildInvocations.length >= 2,
    `expected >=2 relay-server buildx invocations (one per registry), got ${relayBuildInvocations.length}\n${out}`,
  );
});

