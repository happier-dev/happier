import { describe, expect, it } from 'vitest';

import { createServerBackedChannelBindingStore } from './channelBindingStore.server';
import type { ChannelBridgeKvClient } from './channelBridgeServerKv';

function createInMemoryKvClient(): ChannelBridgeKvClient {
  const byKey = new Map<string, { value: string | null; version: number }>();

  return {
    get: async (key) => {
      const row = byKey.get(key);
      if (!row || row.value === null) {
        return { status: 404, body: { error: 'Key not found' } };
      }
      return {
        status: 200,
        body: {
          key,
          value: row.value,
          version: row.version,
        },
      };
    },
    mutate: async (mutations) => {
      const errors: Array<{ key: string; error: 'version-mismatch'; version: number; value: string | null }> = [];
      for (const mutation of mutations) {
        const row = byKey.get(mutation.key);
        const currentVersion = row?.version ?? -1;
        if (currentVersion !== mutation.version) {
          errors.push({
            key: mutation.key,
            error: 'version-mismatch',
            version: currentVersion,
            value: row?.value ?? null,
          });
        }
      }

      if (errors.length > 0) {
        return { status: 409, body: { success: false, errors } };
      }

      const results: Array<{ key: string; version: number }> = [];
      for (const mutation of mutations) {
        const row = byKey.get(mutation.key);
        const nextVersion = (row?.version ?? -1) + 1;
        byKey.set(mutation.key, {
          value: mutation.value,
          version: nextVersion,
        });
        results.push({ key: mutation.key, version: nextVersion });
      }

      return { status: 200, body: { success: true, results } };
    },
  };
}

function createCountingKvClient(): Readonly<{
  kv: ChannelBridgeKvClient;
  mutateCallCount: () => number;
}> {
  const byKey = new Map<string, { value: string | null; version: number }>();
  let mutateCalls = 0;

  const kv: ChannelBridgeKvClient = {
    get: async (key) => {
      const row = byKey.get(key);
      if (!row || row.value === null) {
        return { status: 404, body: { error: 'Key not found' } };
      }
      return {
        status: 200,
        body: {
          key,
          value: row.value,
          version: row.version,
        },
      };
    },
    mutate: async (mutations) => {
      mutateCalls += 1;
      const errors: Array<{ key: string; error: 'version-mismatch'; version: number; value: string | null }> = [];
      for (const mutation of mutations) {
        const row = byKey.get(mutation.key);
        const currentVersion = row?.version ?? -1;
        if (currentVersion !== mutation.version) {
          errors.push({
            key: mutation.key,
            error: 'version-mismatch',
            version: currentVersion,
            value: row?.value ?? null,
          });
        }
      }

      if (errors.length > 0) {
        return { status: 409, body: { success: false, errors } };
      }

      const results: Array<{ key: string; version: number }> = [];
      for (const mutation of mutations) {
        const row = byKey.get(mutation.key);
        const nextVersion = (row?.version ?? -1) + 1;
        byKey.set(mutation.key, {
          value: mutation.value,
          version: nextVersion,
        });
        results.push({ key: mutation.key, version: nextVersion });
      }

      return { status: 200, body: { success: true, results } };
    },
  };

  return {
    kv,
    mutateCallCount: () => mutateCalls,
  };
}

describe('createServerBackedChannelBindingStore', () => {
  it('persists bindings to server KV and reloads them', async () => {
    const kv = createInMemoryKvClient();
    const storeA = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
    });

    const storeB = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
    });

    await storeA.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: '22',
      sessionId: 'sess-1',
      lastForwardedSeq: 7,
    });

    const reloaded = await storeB.getBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: '22',
    });

    expect(reloaded?.sessionId).toBe('sess-1');
    expect(reloaded?.lastForwardedSeq).toBe(7);
  });

  it('updates forwarded seq and removes bindings', async () => {
    const kv = createInMemoryKvClient();
    const store = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
      sessionId: 'sess-1',
      lastForwardedSeq: 3,
    });

    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    }, 10);

    const updated = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });
    expect(updated?.lastForwardedSeq).toBe(10);

    const removed = await store.removeBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });
    expect(removed).toBe(true);

    const after = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });
    expect(after).toBeNull();
  });

  it('does not write to KV for no-op seq updates or missing removes', async () => {
    const counting = createCountingKvClient();
    const store = createServerBackedChannelBindingStore({
      kv: counting.kv,
      serverId: 'local-3005',
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100222',
      threadId: null,
      sessionId: 'sess-2',
      lastForwardedSeq: 12,
    });
    const initialMutations = counting.mutateCallCount();

    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100222',
      threadId: null,
    }, 10);
    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100-missing',
      threadId: null,
    }, 1);
    const missingRemoved = await store.removeBinding({
      providerId: 'telegram',
      conversationId: '-100-missing',
      threadId: null,
    });

    expect(missingRemoved).toBe(false);
    expect(counting.mutateCallCount()).toBe(initialMutations);
  });
});
