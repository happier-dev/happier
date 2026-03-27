import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createTelegramPollingCursorStore', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('persists polling cursors under the active server directory scoped by account and bot token', async () => {
    await withTempDir('happier-channel-bridge-telegram-cursors-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const { createTelegramPollingCursorStore } = await import('./telegramPollingCursorStore');

      const storeA = createTelegramPollingCursorStore({
        accountId: 'acct-1',
        botToken: 'token-1',
      });
      await storeA.save(123);
      await expect(storeA.load()).resolves.toBe(123);

      const storeB = createTelegramPollingCursorStore({
        accountId: 'acct-1',
        botToken: 'token-1',
      });
      await expect(storeB.load()).resolves.toBe(123);

      const otherAccountStore = createTelegramPollingCursorStore({
        accountId: 'acct-2',
        botToken: 'token-1',
      });
      await expect(otherAccountStore.load()).resolves.toBe(null);

      const otherTokenStore = createTelegramPollingCursorStore({
        accountId: 'acct-1',
        botToken: 'token-2',
      });
      await expect(otherTokenStore.load()).resolves.toBe(null);
    });
  });
});
