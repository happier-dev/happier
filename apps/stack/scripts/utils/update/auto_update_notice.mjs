import { join } from 'node:path';

import {
  acquireSingleFlightLock,
  formatUpdateNotice,
  readUpdateCache,
  shouldNotifyUpdate,
  spawnDetachedNode,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';

const DEFAULT_CHECK_LOCK_TTL_MS = 2 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseEnabledFlag(raw, { defaultValue = true } = {}) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return true;
}

function parsePositiveMs(raw, fallback) {
  const v = String(raw ?? '').trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maybeAutoUpdateNotice({
  cliRootDir,
  cmd,
  homeDir,
  isTTY,
  env,
  nowMs,
  spawnDetached = spawnDetachedNode,
  log = console.error,
}) {
  const enabled = parseEnabledFlag(env.HAPPIER_STACK_UPDATE_CHECK, { defaultValue: true });
  if (!enabled) return;
  if (!isTTY) return;
  if (env.HAPPIER_STACK_UPDATE_CHECK_SPAWNED === '1') return;
  if (cmd === 'self' || cmd === 'help' || cmd === '--help' || cmd === '-h') return;

  const cachePath = join(homeDir, 'cache', 'update.json');

  const intervalMs = parsePositiveMs(env.HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const notifyIntervalMs = parsePositiveMs(env.HAPPIER_STACK_UPDATE_NOTIFY_INTERVAL_MS, DEFAULT_INTERVAL_MS);

  const cached = readUpdateCache(cachePath);

  const now = nowMs ?? Date.now();
  const checkedAt = typeof cached?.checkedAt === 'number' ? cached.checkedAt : 0;
  const shouldCheck = !checkedAt || (now - checkedAt > intervalMs);

  const shouldNotify = shouldNotifyUpdate({
    isTTY,
    cmd,
    updateAvailable: Boolean(cached?.updateAvailable),
    latest: cached?.latest ?? null,
    notifiedAt: cached?.notifiedAt ?? null,
    notifyIntervalMs,
    nowMs: now,
  });

  if (shouldNotify) {
    const from = cached?.current ? cached.current : 'current';
    const to = cached?.latest ?? 'latest';
    log(formatUpdateNotice({ toolName: 'hstack', from, to, updateCommand: 'hstack self update' }));
    writeUpdateCache(cachePath, {
      checkedAt: cached?.checkedAt ?? null,
      latest: cached?.latest ?? null,
      current: cached?.current ?? null,
      runtimeVersion: cached?.runtimeVersion ?? null,
      invokerVersion: cached?.invokerVersion ?? null,
      updateAvailable: Boolean(cached?.updateAvailable),
      notifiedAt: now,
    });
  }

  if (!shouldCheck) return;

  const lockTtlMs = parsePositiveMs(env.HAPPIER_STACK_UPDATE_CHECK_LOCK_TTL_MS, DEFAULT_CHECK_LOCK_TTL_MS);
  const lockPath = join(homeDir, 'cache', 'update.check.lock.json');
  if (!acquireSingleFlightLock({ lockPath, nowMs: now, ttlMs: lockTtlMs, pid: process.pid })) return;

  spawnDetached({
    script: join(cliRootDir, 'scripts', 'self.mjs'),
    args: ['check', '--quiet'],
    cwd: cliRootDir,
    env: { ...env, HAPPIER_STACK_UPDATE_CHECK_SPAWNED: '1' },
  });
}
