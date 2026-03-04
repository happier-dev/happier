import { describe, expect, it } from 'vitest';

import {
  type ChannelBridgeKvClient,
  clearChannelBridgeTelegramConfigInKv,
  readChannelBridgeBindingsFromKv,
  readChannelBridgeTelegramConfigFromKv,
  upsertChannelBridgeTelegramConfigInKv,
  writeChannelBridgeBindingsToKv,
} from './channelBridgeServerKv';

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

describe('channelBridgeServerKv', () => {
  it('upserts and reads scoped telegram non-secret config from KV', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      update: {
        tickMs: 2400,
        botToken: 'bot-token-1',
        webhookSecret: 'secret-1',
        allowedChatIds: ['-100111'],
        requireTopics: true,
      },
    });

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
    });

    expect(config.record).toMatchObject({
      tickMs: 2400,
      telegram: {
        allowedChatIds: ['-100111'],
        requireTopics: true,
      },
    });
    const telegram = config.record?.telegram as { botToken?: string } | undefined;
    expect(telegram?.botToken).toBeUndefined();
    expect(config.version).toBe(0);
  });

  it('ignores secret-only updates and leaves KV untouched', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      update: {
        botToken: 'bot-token-1',
        webhookSecret: 'secret-1',
      },
    });

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
    });

    expect(config.record).toBeNull();
    expect(config.version).toBe(-1);
  });

  it('clears scoped telegram config from KV', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      update: {
        allowedChatIds: ['-100111'],
      },
    });

    await clearChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
    });

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
    });

    expect(config.record).toBeNull();
  });

  it('writes and reads bindings document from KV', async () => {
    const kv = createInMemoryKvClient();

    const first = await readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    });
    expect(first.version).toBe(-1);
    expect(first.doc.bindings).toEqual([]);

    const writtenVersion = await writeChannelBridgeBindingsToKv({
      kv,
      serverId: 'local-3005',
      expectedVersion: first.version,
      doc: {
        schemaVersion: 1,
        bindings: [
          {
            providerId: 'telegram',
            conversationId: '-100111',
            threadId: '12',
            sessionId: 'sess-1',
            lastForwardedSeq: 9,
            createdAtMs: 111,
            updatedAtMs: 222,
          },
        ],
      },
    });

    expect(writtenVersion).toBe(0);

    const second = await readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    });
    expect(second.version).toBe(0);
    expect(second.doc.bindings).toHaveLength(1);
    expect(second.doc.bindings[0]?.sessionId).toBe('sess-1');
  });

  it('throws when bindings payload is invalid/corrupt in KV', async () => {
    const invalidValueBase64 = Buffer.from(JSON.stringify({ schemaVersion: 999, bindings: [] }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: invalidValueBase64,
          version: 12,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    })).rejects.toThrow('Invalid or unsupported channel bridge bindings payload in KV');
  });

  it('throws when bindings payload includes malformed numeric fields', async () => {
    const malformedValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100111',
          sessionId: 'sess-1',
          lastForwardedSeq: 'oops',
        },
      ],
    }), 'utf8').toString('base64');

    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedValueBase64,
          version: 5,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    })).rejects.toThrow('Invalid channel bridge binding lastForwardedSeq at index 0');
  });

  it('throws when bindings payload includes malformed thread ids', async () => {
    const malformedValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100111',
          sessionId: 'sess-1',
          threadId: 123,
        },
      ],
    }), 'utf8').toString('base64');

    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedValueBase64,
          version: 5,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    })).rejects.toThrow('Invalid channel bridge binding threadId at index 0');
  });

  it('throws when bindings payload includes malformed binding rows', async () => {
    const malformedValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100111',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 9,
          createdAtMs: 111,
          updatedAtMs: 222,
        },
        {
          providerId: '',
          conversationId: '-100222',
          sessionId: 'sess-2',
        },
      ],
    }), 'utf8').toString('base64');

    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedValueBase64,
          version: 5,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
    })).rejects.toThrow('Invalid channel bridge binding identity fields at index 1');
  });

  it('throws when telegram config payload is invalid/corrupt in KV', async () => {
    const invalidValueBase64 = Buffer.from(JSON.stringify({ schemaVersion: 999, telegram: {} }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: invalidValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
    })).rejects.toThrow('Invalid or unsupported Telegram config schema');
  });
});
