import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createTelegramWebhookUpdateStore', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('persists queued webhook updates scoped by account and bot token', async () => {
    await withTempDir('happier-channel-bridge-telegram-webhook-updates-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const { createTelegramWebhookUpdateStore } = await import('./telegramWebhookUpdateStore');

      const storeA = createTelegramWebhookUpdateStore({
        accountId: 'acct-1',
        botToken: 'token-1',
      });

      await storeA.save({
        lastHandledWebhookUpdateId: 41,
        nextQueuedWebhookId: 2,
        queuedWebhookUpdates: [
          {
            id: 1,
            update: {
              update_id: 42,
              message: { text: 'hello' },
            },
          },
        ],
      });

      const storeB = createTelegramWebhookUpdateStore({
        accountId: 'acct-1',
        botToken: 'token-1',
      });

      await expect(storeB.load()).resolves.toEqual({
        lastHandledWebhookUpdateId: 41,
        nextQueuedWebhookId: 2,
        queuedWebhookUpdates: [
          {
            id: 1,
            update: {
              update_id: 42,
              message: { text: 'hello' },
            },
          },
        ],
      });

      const otherAccountStore = createTelegramWebhookUpdateStore({
        accountId: 'acct-2',
        botToken: 'token-1',
      });
      await expect(otherAccountStore.load()).resolves.toBe(null);

      const otherTokenStore = createTelegramWebhookUpdateStore({
        accountId: 'acct-1',
        botToken: 'token-2',
      });
      await expect(otherTokenStore.load()).resolves.toBe(null);
    });
  });
});
