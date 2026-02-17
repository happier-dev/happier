import { describe, expect, it, vi } from 'vitest';

import { mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { readAccountSettingsCache, writeAccountSettingsCacheAtomic } from './accountSettingsCache';

describe('accountSettingsCache', () => {
  it('removes stale lock files and completes write', async () => {
    const root = join(tmpdir(), `happier-account-settings-cache-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, 'account.settings.cache.json');
    const lock = `${path}.lock`;

    await writeFile(lock, 'locked');
    const staleMs = Date.now() - 60_000;
    await utimes(lock, staleMs / 1000, staleMs / 1000);

    await writeAccountSettingsCacheAtomic(path, {
      version: 1,
      cachedAt: 123,
      settingsCiphertext: 'cipher',
      settingsVersion: 9,
    });

    const cache = await readAccountSettingsCache(path);
    expect(cache?.settingsVersion).toBe(9);
  });

  it('cleans up tmp file if rename fails', async () => {
    const root = join(tmpdir(), `happier-account-settings-cache-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const path = join(root, 'account.settings.cache.json');
    const tmp = `${path}.tmp`;

    // Force rename failure by making the destination a directory.
    await mkdir(path, { recursive: true });

    await expect(writeAccountSettingsCacheAtomic(path, {
      version: 1,
      cachedAt: 123,
      settingsCiphertext: 'cipher',
      settingsVersion: 9,
    })).rejects.toBeTruthy();

    await expect(stat(tmp)).rejects.toBeTruthy();
  });

  it('waits long enough for a non-stale lock to be released', async () => {
    // Fake only `setTimeout` so we can "fast-forward" retry delays while still
    // letting fs I/O resolve normally.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const root = join(tmpdir(), `happier-account-settings-cache-${randomUUID()}`);
      await mkdir(root, { recursive: true });
      const path = join(root, 'account.settings.cache.json');
      const lock = `${path}.lock`;

      // Create a lock that is not stale (stale timeout is 10s).
      await writeFile(lock, 'locked');

      // Release the lock after ~6s (previous max wait was 5s).
      setTimeout(() => {
        void unlink(lock).catch(() => {});
      }, 6000);

      const outcome = writeAccountSettingsCacheAtomic(path, {
        version: 1,
        cachedAt: 123,
        settingsCiphertext: 'cipher',
        settingsVersion: 9,
      }).then(
        () => ({ status: 'resolved' as const }),
        (error) => ({ status: 'rejected' as const, error }),
      );

      // Ensure the write has hit the first retry timeout before we advance timers.
      // We already scheduled 1 timer (the unlock at 6000ms). The lock retry adds a 2nd timer.
      for (let i = 0; i < 50 && vi.getTimerCount() < 2; i += 1) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

      // Step time forward in retry-sized increments so retries can't "skip ahead"
      // to the unlock timer before exhausting their attempt budget.
      for (let t = 0; t < 7000; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const final = await outcome;
      expect(final.status).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });
});
