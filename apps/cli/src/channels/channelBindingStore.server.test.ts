import { describe, expect, it } from 'vitest';

import { createServerBackedChannelBindingStore } from './channelBindingStore.server';
import type { ChannelBridgeKvClient } from './channelBridgeServerKv';

function createStandardInMemoryKvState(): Readonly<{
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

function createInMemoryKvClient(): ChannelBridgeKvClient {
  return createStandardInMemoryKvState().kv;
}

function createCountingKvClient(): Readonly<{
  kv: ChannelBridgeKvClient;
  mutateCallCount: () => number;
}> {
  return createStandardInMemoryKvState();
}

function createConflictPayloadKvClient(): Readonly<{
  kv: ChannelBridgeKvClient;
  mutateCallCount: () => number;
  getCallCount: () => number;
}> {
  let getCalls = 0;
  let mutateCalls = 0;
  let currentVersion = -1;
  let storedValue: string | null = null;

  const kv: ChannelBridgeKvClient = {
    get: async (key) => {
      getCalls += 1;
      if (storedValue === null) {
        return { status: 404, body: { error: 'Key not found' } };
      }
      return {
        status: 200,
        body: {
          key,
          value: storedValue,
          version: currentVersion,
        },
      };
    },
    mutate: async (mutations) => {
      mutateCalls += 1;
      const [mutation] = mutations;
      if (!mutation) {
        return { status: 400, body: { success: false, errors: [{ key: 'missing', error: 'version-mismatch', version: currentVersion, value: storedValue }] } };
      }

      if (mutateCalls === 1) {
        return {
          status: 409,
          body: {
            success: false,
            errors: [
              {
                key: mutation.key,
                error: 'version-mismatch',
                version: currentVersion,
                value: 'this-is-not-valid-base64',
              },
            ],
          },
        };
      }

      currentVersion += 1;
      storedValue = mutation.value;
      return {
        status: 200,
        body: {
          success: true,
          results: [
            {
              key: mutation.key,
              version: currentVersion,
            },
          ],
        },
      };
    },
  };

  return {
    kv,
    getCallCount: () => getCalls,
    mutateCallCount: () => mutateCalls,
  };
}

function createValidConflictPayloadKvClient(): Readonly<{
  kv: ChannelBridgeKvClient;
  mutateCallCount: () => number;
  getCallCount: () => number;
}> {
  let getCalls = 0;
  let mutateCalls = 0;
  let currentVersion = 0;
  let storedValue = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    bindings: [],
  }), 'utf8').toString('base64');

  const conflictValue = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    bindings: [],
  }), 'utf8').toString('base64');

  const kv: ChannelBridgeKvClient = {
    get: async (key) => {
      getCalls += 1;
      return {
        status: 200,
        body: {
          key,
          value: storedValue,
          version: currentVersion,
        },
      };
    },
    mutate: async (mutations) => {
      mutateCalls += 1;
      const [mutation] = mutations;
      if (!mutation) {
        return {
          status: 400,
          body: {
            success: false,
            errors: [{ key: 'missing', error: 'version-mismatch', version: currentVersion, value: storedValue }],
          },
        };
      }

      if (mutateCalls === 1) {
        currentVersion = 1;
        storedValue = conflictValue;
        return {
          status: 409,
          body: {
            success: false,
            errors: [{ key: mutation.key, error: 'version-mismatch', version: currentVersion, value: storedValue }],
          },
        };
      }

      currentVersion += 1;
      storedValue = mutation.value ?? storedValue;
      return {
        status: 200,
        body: {
          success: true,
          results: [{ key: mutation.key, version: currentVersion }],
        },
      };
    },
  };

  return {
    kv,
    getCallCount: () => getCalls,
    mutateCallCount: () => mutateCalls,
  };
}

function createMalformedPrimaryReadKvClient(): ChannelBridgeKvClient {
  const keySuffix = ':bindings';
  const malformedValue = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    bindings: [
      {
        providerId: 'telegram',
        conversationId: '-100bad',
        sessionId: 'sess-bad',
        lastForwardedSeq: 'oops',
      },
    ],
  }), 'utf8').toString('base64');

  const byKey = new Map<string, { value: string | null; version: number }>();

  const kv: ChannelBridgeKvClient = {
    get: async (key) => {
      if (!byKey.has(key)) {
        byKey.set(key, { value: malformedValue, version: 6 });
      }
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
        if (!mutation.key.endsWith(keySuffix)) continue;
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

  return kv;
}

describe('createServerBackedChannelBindingStore', () => {
  it('persists bindings to server KV and reloads them', async () => {
    const kv = createInMemoryKvClient();
    const storeA = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    const storeB = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
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
      accountId: 'acct-1',
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
    }, {
      expectedSessionId: 'sess-1',
      seq: 10,
    });

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
      accountId: 'acct-1',
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
    }, {
      expectedSessionId: 'sess-2',
      seq: 10,
    });
    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100-missing',
      threadId: null,
    }, {
      expectedSessionId: 'sess-missing',
      seq: 1,
    });
    const missingRemoved = await store.removeBinding({
      providerId: 'telegram',
      conversationId: '-100-missing',
      threadId: null,
    });

    expect(missingRemoved).toBe(false);
    expect(counting.mutateCallCount()).toBe(initialMutations);
  });

  it('does not advance cursor when expected session id does not match', async () => {
    const counting = createCountingKvClient();
    const store = createServerBackedChannelBindingStore({
      kv: counting.kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100session-guard',
      threadId: null,
      sessionId: 'sess-current',
      lastForwardedSeq: 5,
    });

    const beforeMutations = counting.mutateCallCount();
    const advanced = await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100session-guard',
      threadId: null,
    }, {
      expectedSessionId: 'sess-stale',
      seq: 99,
    });

    expect(advanced).toBe(false);
    expect(counting.mutateCallCount()).toBe(beforeMutations);

    const binding = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100session-guard',
      threadId: null,
    });
    expect(binding?.sessionId).toBe('sess-current');
    expect(binding?.lastForwardedSeq).toBe(5);
  });

  it('rejects invalid identity/cursor values and skips invalid seq writes', async () => {
    const counting = createCountingKvClient();
    const store = createServerBackedChannelBindingStore({
      kv: counting.kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    await expect(store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: null,
      sessionId: 'sess-nf',
      lastForwardedSeq: Number.NaN,
    })).rejects.toThrow('Invalid channel binding input');

    await expect(store.upsertBinding({
      providerId: ' ',
      conversationId: '-100nf',
      threadId: null,
      sessionId: 'sess-nf',
      lastForwardedSeq: 1,
    })).rejects.toThrow('Invalid channel binding input');

    expect(counting.mutateCallCount()).toBe(0);

    await store.upsertBinding({
      providerId: ' telegram ',
      conversationId: ' -100nf ',
      threadId: ' 11 ',
      sessionId: ' sess-nf ',
      lastForwardedSeq: 2,
    });

    const saved = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: '11',
    });
    expect(saved).toMatchObject({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: '11',
      sessionId: 'sess-nf',
      lastForwardedSeq: 2,
    });

    const initialMutations = counting.mutateCallCount();

    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: '11',
    }, {
      expectedSessionId: 'sess-nf',
      seq: Number.POSITIVE_INFINITY,
    });

    await store.updateLastForwardedSeq({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: '11',
    }, {
      expectedSessionId: 'sess-nf',
      seq: Number.NaN,
    });

    expect(counting.mutateCallCount()).toBe(initialMutations);

    const afterInvalidUpdates = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100nf',
      threadId: '11',
    });
    expect(afterInvalidUpdates?.lastForwardedSeq).toBe(2);
  });

  it('fails fast when conflict payload cannot be decoded', async () => {
    const conflict = createConflictPayloadKvClient();
    const store = createServerBackedChannelBindingStore({
      kv: conflict.kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      maxWriteRetries: 3,
    });

    await expect(store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100333',
      threadId: null,
      sessionId: 'sess-3',
      lastForwardedSeq: 4,
    })).rejects.toThrow('Conflict payload decode failed');

    const binding = await store.getBinding({
      providerId: 'telegram',
      conversationId: '-100333',
      threadId: null,
    });

    expect(binding).toBeNull();
    expect(conflict.mutateCallCount()).toBe(1);
  });

  it('fails fast when malformed primary KV payload is encountered before cache warm-up', async () => {
    const kv = createMalformedPrimaryReadKvClient();
    const store = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      maxWriteRetries: 3,
    });

    await expect(store.listBindings()).rejects.toThrow('Invalid channel bridge binding lastForwardedSeq at index 0');

    await expect(store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100444',
      threadId: null,
      sessionId: 'sess-4',
      lastForwardedSeq: 1,
    })).rejects.toThrow('Invalid channel bridge binding lastForwardedSeq at index 0');

    await expect(store.getBinding({
      providerId: 'telegram',
      conversationId: '-100444',
      threadId: null,
    })).rejects.toThrow('Invalid channel bridge binding lastForwardedSeq at index 0');
  });

  it('returns last known-good bindings when a recoverable decode error occurs after cache warm-up', async () => {
    const validValue = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100cache',
          threadId: null,
          sessionId: 'sess-cache',
          lastForwardedSeq: 7,
          createdAtMs: 10,
          updatedAtMs: 11,
        },
      ],
    }), 'utf8').toString('base64');

    const malformedValue = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100cache',
          threadId: null,
          sessionId: 'sess-cache',
          lastForwardedSeq: 'oops',
        },
      ],
    }), 'utf8').toString('base64');

    let getCalls = 0;
    const kv: ChannelBridgeKvClient = {
      get: async (key) => {
        getCalls += 1;
        return {
          status: 200,
          body: {
            key,
            version: 4,
            value: getCalls === 1 ? validValue : malformedValue,
          },
        };
      },
      mutate: async () => ({
        status: 200,
        body: {
          success: true,
          results: [],
        },
      }),
    };

    const store = createServerBackedChannelBindingStore({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      cacheTtlMs: 0,
      maxWriteRetries: 3,
    });

    const first = await store.listBindings();
    expect(first).toEqual([
      {
        providerId: 'telegram',
        conversationId: '-100cache',
        threadId: null,
        sessionId: 'sess-cache',
        lastForwardedSeq: 7,
        createdAtMs: 10,
        updatedAtMs: 11,
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await store.listBindings();
    expect(second).toEqual(first);
    expect(getCalls).toBeGreaterThanOrEqual(2);
  });

  it('uses conflict payload state for retry without extra primary read', async () => {
    const conflict = createValidConflictPayloadKvClient();
    const store = createServerBackedChannelBindingStore({
      kv: conflict.kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      maxWriteRetries: 3,
    });

    await store.upsertBinding({
      providerId: 'telegram',
      conversationId: '-100555',
      threadId: null,
      sessionId: 'sess-5',
      lastForwardedSeq: 2,
    });

    expect(conflict.mutateCallCount()).toBe(2);
    expect(conflict.getCallCount()).toBe(1);
  });
});
