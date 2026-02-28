import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const runChecks = resolve(repoRoot, 'scripts', 'pipeline', 'checks', 'run-checks.mjs');
const resolvePlan = resolve(repoRoot, 'scripts', 'pipeline', 'checks', 'resolve-checks-plan.mjs');

test('pipeline checks release-assets profile dry-run includes release-assets-e2e runner', () => {
  const res = spawnSync(process.execPath, [runChecks, '--profile', 'release-assets', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HAPPIER_RELEASE_ASSETS_E2E_MODE: '', HAPPIER_RELEASE_ASSETS_E2E_MONOREPO: '' },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout ?? '', /- runReleaseAssetsE2e: true/);
  assert.match(
    res.stdout ?? '',
    /\[dry-run\] bash scripts\/release\/release-assets-e2e\/run\.sh --mode=local --monorepo=local --with-relay-upgrade/,
  );
});

test('pipeline checks release-assets-e2e mode/monorepo are configurable via env', () => {
  const res = spawnSync(process.execPath, [runChecks, '--profile', 'release-assets', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HAPPIER_RELEASE_ASSETS_E2E_MODE: 'npm', HAPPIER_RELEASE_ASSETS_E2E_MONOREPO: 'github' },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(
    res.stdout ?? '',
    /\[dry-run\] bash scripts\/release\/release-assets-e2e\/run\.sh --mode=npm --monorepo=github --with-relay-upgrade/,
  );
});

test('pipeline checks release-assets-e2e relay upgrade can be disabled via env', () => {
  const res = spawnSync(process.execPath, [runChecks, '--profile', 'release-assets', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE: 'false' },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(
    res.stdout ?? '',
    /\[dry-run\] bash scripts\/release\/release-assets-e2e\/run\.sh --mode=local --monorepo=local --no-relay-upgrade/,
  );
});

test('resolve-checks-plan includes release-assets-e2e github output key', () => {
  const res = spawnSync(process.execPath, [resolvePlan, '--profile', 'release-assets'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const payload = JSON.parse(String(res.stdout ?? '').trim());
  assert.equal(payload.runReleaseAssetsE2e, true);
});
