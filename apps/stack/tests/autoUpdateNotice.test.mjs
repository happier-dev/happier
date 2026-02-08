import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeAutoUpdateNotice } from '../scripts/utils/update/auto_update_notice.mjs';

function createHomeDir(t) {
  const homeDir = mkdtempSync(join(tmpdir(), 'hstack-update-home-'));
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });
  return homeDir;
}

test('maybeAutoUpdateNotice prints notice and updates notifiedAt when update is available', (t) => {
  const homeDir = createHomeDir(t);
  const cachePath = join(homeDir, 'cache', 'update.json');
  mkdirSync(join(homeDir, 'cache'), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify(
      {
        checkedAt: Date.now() - 1000 * 60 * 60 * 25,
        latest: '9.9.9',
        current: '1.0.0',
        runtimeVersion: null,
        invokerVersion: '1.0.0',
        updateAvailable: true,
        notifiedAt: 0,
      },
      null,
      2,
    ),
  );

  const errors = [];
  const spawned = [];
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: { HAPPIER_STACK_UPDATE_CHECK: '1' },
    spawnDetached: (params) => spawned.push(params),
    log: (msg) => errors.push(String(msg)),
    nowMs: Date.now(),
  });

  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('update available'));
  assert.equal(spawned.length, 1);

  const updated = JSON.parse(readFileSync(cachePath, 'utf-8'));
  assert.equal(updated.latest, '9.9.9');
  assert.ok(typeof updated.notifiedAt === 'number' && updated.notifiedAt > 0);
});

test('maybeAutoUpdateNotice does nothing when disabled', (t) => {
  const homeDir = createHomeDir(t);
  const errors = [];
  const spawned = [];
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: { HAPPIER_STACK_UPDATE_CHECK: '0' },
    spawnDetached: (params) => spawned.push(params),
    log: (msg) => errors.push(String(msg)),
    nowMs: Date.now(),
  });
  assert.equal(errors.length, 0);
  assert.equal(spawned.length, 0);
});

test('maybeAutoUpdateNotice treats trimmed disable values as disabled', (t) => {
  const homeDir = createHomeDir(t);
  const spawned = [];
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: { HAPPIER_STACK_UPDATE_CHECK: ' 0 ' },
    spawnDetached: (params) => spawned.push(params),
    nowMs: Date.now(),
  });
  assert.equal(spawned.length, 0);
});

test('maybeAutoUpdateNotice falls back to defaults when intervals are non-positive', (t) => {
  const homeDir = createHomeDir(t);
  const nowMs = 100_000;
  const cachePath = join(homeDir, 'cache', 'update.json');
  mkdirSync(join(homeDir, 'cache'), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify(
      {
        checkedAt: nowMs - 100,
        latest: '9.9.9',
        current: '1.0.0',
        runtimeVersion: null,
        invokerVersion: '1.0.0',
        updateAvailable: true,
        notifiedAt: nowMs - 100,
      },
      null,
      2,
    ),
  );

  const errors = [];
  const spawned = [];
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: {
      HAPPIER_STACK_UPDATE_CHECK: '1',
      HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS: '-5',
      HAPPIER_STACK_UPDATE_NOTIFY_INTERVAL_MS: '-5',
    },
    spawnDetached: (params) => spawned.push(params),
    log: (msg) => errors.push(String(msg)),
    nowMs,
  });

  assert.equal(spawned.length, 0, 'expected no spawn because default check interval should apply');
  assert.equal(errors.length, 0, 'expected no notice because default notify interval should apply');
});

test('maybeAutoUpdateNotice does not spawn multiple concurrent background checks', (t) => {
  const homeDir = createHomeDir(t);
  const cachePath = join(homeDir, 'cache', 'update.json');
  mkdirSync(join(homeDir, 'cache'), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify(
      {
        checkedAt: 1,
        latest: null,
        current: null,
        runtimeVersion: null,
        invokerVersion: null,
        updateAvailable: false,
        notifiedAt: 0,
      },
      null,
      2,
    ),
  );

  const spawned = [];
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: {
      HAPPIER_STACK_UPDATE_CHECK: '1',
      HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS: '1',
      HAPPIER_STACK_UPDATE_CHECK_LOCK_TTL_MS: '60000',
    },
    spawnDetached: (params) => spawned.push(params),
    nowMs: 100_000,
  });
  maybeAutoUpdateNotice({
    cliRootDir: '/repo/apps/stack',
    cmd: 'stack',
    homeDir,
    isTTY: true,
    env: {
      HAPPIER_STACK_UPDATE_CHECK: '1',
      HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS: '1',
      HAPPIER_STACK_UPDATE_CHECK_LOCK_TTL_MS: '60000',
    },
    spawnDetached: (params) => spawned.push(params),
    nowMs: 100_001,
  });

  assert.equal(spawned.length, 1);
});
