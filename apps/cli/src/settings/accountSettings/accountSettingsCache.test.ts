import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { configuration } from '@/configuration';

import { readAccountSettingsCache, resolveAccountSettingsCachePath, writeAccountSettingsCacheAtomic } from './accountSettingsCache';

function createJwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('accountSettingsCache', () => {
  const originalActiveServerDir = configuration.activeServerDir;

  afterEach(() => {
    Object.assign(configuration as unknown as { activeServerDir: string }, { activeServerDir: originalActiveServerDir });
  });

  it('resolves same-server account cache paths by token subject without exposing raw identity', () => {
    const root = join(tmpdir(), `happier-account-settings-cache-${randomUUID()}`);
    Object.assign(configuration as unknown as { activeServerDir: string }, { activeServerDir: root });

    const accountAPath = resolveAccountSettingsCachePath({ token: createJwtWithSub('account-a@example.test') });
    const accountBPath = resolveAccountSettingsCachePath({ token: createJwtWithSub('account-b@example.test') });

    expect(accountAPath).not.toBe(accountBPath);
    expect(accountAPath).toContain(root);
    expect(accountAPath).toContain('account-settings-cache');
    expect(accountAPath).not.toContain('account-a@example.test');
    expect(accountAPath).not.toContain(createJwtWithSub('account-a@example.test'));
  });

  it('falls back to a token hash scope when the token has no subject', () => {
    const root = join(tmpdir(), `happier-account-settings-cache-${randomUUID()}`);
    Object.assign(configuration as unknown as { activeServerDir: string }, { activeServerDir: root });
    const token = 'not-a-jwt-token';

    const path = resolveAccountSettingsCachePath({ token });

    expect(path).toContain(root);
    expect(path).toContain('account-settings-cache');
    expect(path).not.toContain(token);
    expect(path).not.toBe(join(root, 'account.settings.cache.json'));
  });

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

      // Release the lock shortly after the write begins; this should force at
      // least one retry without making the unit test slow/flaky.
      setTimeout(() => {
        void unlink(lock).catch(() => {});
      }, 300);

      const write = writeAccountSettingsCacheAtomic(path, {
        version: 1,
        cachedAt: 123,
        settingsCiphertext: 'cipher',
        settingsVersion: 9,
      });

      let settled = false;
      void write.finally(() => {
        settled = true;
      });

      const flushEventLoop = async (): Promise<void> => {
        for (let i = 0; i < 5; i += 1) {
          await new Promise<void>((r) => setImmediate(r));
        }
      };

      // The write should not complete before the lock is released.
      await vi.advanceTimersByTimeAsync(200);
      await flushEventLoop();
      expect(settled).toBe(false);

      // Drive retry timers forward in small steps to allow the async fs calls
      // between retries to resolve deterministically.
      for (let i = 0; i < 30 && !settled; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await flushEventLoop();
      }

      await expect(write).resolves.toBeUndefined();

      const cache = await readAccountSettingsCache(path);
      expect(cache?.settingsVersion).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });
});
