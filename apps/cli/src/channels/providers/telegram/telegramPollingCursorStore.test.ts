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

  it('persists and reloads a polling cursor for the same bot token', async () => {
    await withTempDir('happier-telegram-polling-cursor-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const { createTelegramPollingCursorStore } = await import('./telegramPollingCursorStore');

      const storeA = createTelegramPollingCursorStore({ botToken: 'bot-token-a' });
      await expect(storeA.load()).resolves.toBeNull();

      await expect(storeA.save(123)).resolves.toBeUndefined();
      await expect(storeA.load()).resolves.toBe(123);

      const storeB = createTelegramPollingCursorStore({ botToken: 'bot-token-a' });
      await expect(storeB.load()).resolves.toBe(123);
    });
  });
});

