import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runChecksDryRun(args) {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const res = spawnSync(process.execPath, ['scripts/pipeline/checks/run-checks.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

test('pipeline checks runs self-host launchd lane when requested (dry-run)', () => {
  const res = runChecksDryRun([
    '--profile',
    'custom',
    '--custom-checks',
    'self_host_launchd',
    '--install-deps',
    'false',
    '--dry-run',
  ]);

  assert.equal(res.status, 0, `expected exit 0 (stderr: ${res.stderr.trim()})`);
  assert.match(res.stdout, /runSelfHostLaunchd: true/);
  assert.match(res.stdout, /self_host_launchd\.real\.integration\.test\.mjs/);
});
