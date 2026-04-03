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

test('docker publish supports dev channel (tags + embedded policy)', () => {
  const repoRoot = process.cwd();
  const scriptPath = path.join(repoRoot, 'scripts/pipeline/docker/publish-images.mjs');

  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();
  assert.ok(/^[a-f0-9]{40}$/.test(sha), `expected git SHA, got: ${sha}`);
  const shortSha = sha.slice(0, 12);

  const out = run(process.execPath, [scriptPath, '--channel', 'dev', '--registries', 'dockerhub', '--dry-run'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Keep the output deterministic: avoid GH Actions cache args.
      GITHUB_ACTIONS: 'false',
    },
  });

  assert.match(out, new RegExp(String.raw`--build-arg\s+HAPPIER_EMBEDDED_POLICY_ENV=preview`));

  assert.match(out, new RegExp(String.raw`--tag\s+happierdev/relay-server:dev\b`));
  assert.match(out, new RegExp(String.raw`--tag\s+happierdev/relay-server:dev-${shortSha}\b`));
  assert.match(out, new RegExp(String.raw`--tag\s+happierdev/dev-box:dev\b`));
  assert.match(out, new RegExp(String.raw`--tag\s+happierdev/dev-box:dev-${shortSha}\b`));
});

