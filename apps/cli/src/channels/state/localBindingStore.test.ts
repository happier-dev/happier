import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('createLocalChannelBindingStore', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('persists bindings under the active server directory scoped by account', async () => {
    await withTempDir('happier-channel-bridge-bindings-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const { createLocalChannelBindingStore } = await import('./localBindingStore');

      const storeA = createLocalChannelBindingStore({
        accountId: 'acct-1',
      });

      await storeA.upsertBinding({
        providerId: 'telegram',
        conversationId: '-1001',
        threadId: null,
        sessionId: 'sess-1',
        lastForwardedSeq: 0,
        ownerSenderId: 'user-1',
        inboundMode: 'ownerOnly',
        allowMissingSenderId: false,
      });

      const storeB = createLocalChannelBindingStore({
        accountId: 'acct-1',
      });

      await expect(storeB.getBinding({ providerId: 'telegram', conversationId: '-1001', threadId: null })).resolves.toEqual(
        expect.objectContaining({
          providerId: 'telegram',
          conversationId: '-1001',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
        }),
      );
    });
  });

  it('keeps lastForwardedSeq monotonic', async () => {
    await withTempDir('happier-channel-bridge-bindings-monotonic-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();

      const { createLocalChannelBindingStore } = await import('./localBindingStore');

      const store = createLocalChannelBindingStore({
        accountId: 'acct-1',
      });

      await store.upsertBinding({
        providerId: 'telegram',
        conversationId: '-1001',
        threadId: null,
        sessionId: 'sess-1',
        lastForwardedSeq: 0,
        ownerSenderId: 'user-1',
        inboundMode: 'ownerOnly',
        allowMissingSenderId: false,
      });

      await expect(
        store.updateLastForwardedSeq(
          { providerId: 'telegram', conversationId: '-1001', threadId: null },
          { expectedSessionId: 'sess-1', seq: 10 },
        ),
      ).resolves.toBe(true);

      await expect(
        store.updateLastForwardedSeq(
          { providerId: 'telegram', conversationId: '-1001', threadId: null },
          { expectedSessionId: 'sess-1', seq: 5 },
        ),
      ).resolves.toBe(false);

      await expect(store.getBinding({ providerId: 'telegram', conversationId: '-1001', threadId: null })).resolves.toEqual(
        expect.objectContaining({
          lastForwardedSeq: 10,
        }),
      );
    });
  });
});
