import { describe, expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';

import {
  type ChannelBridgeKvClient,
  createAxiosChannelBridgeKvClient,
  clearChannelBridgeTelegramConfigInKv,
  replaceChannelBridgeTelegramConfigRawInKv,
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
  it('rejects insecure non-loopback http KV base URLs', () => {
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    try {
      process.env.HAPPIER_SERVER_URL = 'http://example.com:3005';
      reloadConfiguration();

      expect(() => createAxiosChannelBridgeKvClient({ token: 'token-1' })).toThrow(
        'Insecure channel bridge KV base URL',
      );
    } finally {
      if (prevServerUrl === undefined) {
        delete process.env.HAPPIER_SERVER_URL;
      } else {
        process.env.HAPPIER_SERVER_URL = prevServerUrl;
      }
      reloadConfiguration();
    }
  });

  it('allows loopback http KV base URLs for local development', () => {
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    try {
      process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
      reloadConfiguration();

      expect(() => createAxiosChannelBridgeKvClient({ token: 'token-1' })).not.toThrow();
    } finally {
      if (prevServerUrl === undefined) {
        delete process.env.HAPPIER_SERVER_URL;
      } else {
        process.env.HAPPIER_SERVER_URL = prevServerUrl;
      }
      reloadConfiguration();
    }
  });

  it('allows full 127.0.0.0/8 loopback range for local development', () => {
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    try {
      process.env.HAPPIER_SERVER_URL = 'http://127.0.0.2:3005';
      reloadConfiguration();

      expect(() => createAxiosChannelBridgeKvClient({ token: 'token-1' })).not.toThrow();
    } finally {
      if (prevServerUrl === undefined) {
        delete process.env.HAPPIER_SERVER_URL;
      } else {
        process.env.HAPPIER_SERVER_URL = prevServerUrl;
      }
      reloadConfiguration();
    }
  });

  it('upserts and reads scoped telegram non-secret config from KV', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
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
      accountId: 'acct-1',
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

  it('isolates telegram config by account scope on the same server', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        requireTopics: true,
      },
    });

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-2',
      update: {
        allowedChatIds: ['-100222'],
      },
    });

    const acct1 = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });
    const acct2 = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-2',
    });

    expect(acct1.record?.telegram.requireTopics).toBe(true);
    expect(acct1.record?.telegram.allowedChatIds).toBeUndefined();
    expect(acct2.record?.telegram.allowedChatIds).toEqual(['-100222']);
    expect(acct2.record?.telegram.requireTopics).toBeUndefined();
  });

  it('ignores secret-only updates and leaves KV untouched', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        botToken: 'bot-token-1',
        webhookSecret: 'secret-1',
      },
    });

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(config.record).toBeNull();
    expect(config.version).toBe(-1);
  });

  it('clears scoped telegram config from KV', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        allowedChatIds: ['-100111'],
      },
    });

    await clearChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(config.record).toBeNull();
  });

  it('rejects malformed non-empty allowedChatIds updates', async () => {
    const kv = createInMemoryKvClient();

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        allowedChatIds: ['   '],
      },
    })).rejects.toThrow('Invalid telegram.allowedChatIds update payload');
  });

  it('rejects invalid webhook port updates', async () => {
    const kv = createInMemoryKvClient();

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        webhookPort: 0,
      },
    })).rejects.toThrow('Invalid telegram.webhook.port update payload');
  });

  it('rejects out-of-range tickMs updates', async () => {
    const kv = createInMemoryKvClient();

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        tickMs: 100,
      },
    })).rejects.toThrow('Invalid tickMs update payload');

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        tickMs: 120_000,
      },
    })).rejects.toThrow('Invalid tickMs update payload');
  });

  it('rejects non-loopback webhook host updates', async () => {
    const kv = createInMemoryKvClient();

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        webhookHost: '0.0.0.0',
      },
    })).rejects.toThrow('Invalid telegram.webhook.host update payload');
  });

  it('rejects malformed persisted webhook payloads during read', async () => {
    const kv = createInMemoryKvClient();

    const malformedWebhookPayload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        webhook: 'not-an-object',
      },
      updatedAtMs: 1,
    }), 'utf8').toString('base64');

    await replaceChannelBridgeTelegramConfigRawInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      valueBase64: malformedWebhookPayload,
    });

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.webhook payload');

    const emptyWebhookHostPayload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        webhook: {
          host: '   ',
        },
      },
      updatedAtMs: 2,
    }), 'utf8').toString('base64');

    await replaceChannelBridgeTelegramConfigRawInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      valueBase64: emptyWebhookHostPayload,
    });

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.webhook.host payload');
  });

  it('replaces raw telegram config bytes in KV without schema parsing', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        requireTopics: true,
      },
    });

    const rawUnsupported = Buffer.from(JSON.stringify({
      schemaVersion: 999,
      unsupported: true,
    }), 'utf8').toString('base64');

    await replaceChannelBridgeTelegramConfigRawInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      valueBase64: rawUnsupported,
    });

    const readWithUnsupported = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      allowUnsupportedSchema: true,
    });

    expect(readWithUnsupported.record).toBeNull();
    expect(readWithUnsupported.rawValueBase64).toBe(rawUnsupported);
  });

  it('refuses raw replace when expected current version does not match', async () => {
    const kv = createInMemoryKvClient();

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        requireTopics: true,
      },
    });

    const rawUnsupported = Buffer.from(JSON.stringify({
      schemaVersion: 999,
      unsupported: true,
    }), 'utf8').toString('base64');

    await expect(replaceChannelBridgeTelegramConfigRawInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      valueBase64: rawUnsupported,
      expectedCurrentVersion: 999,
    })).rejects.toThrow('KV version mismatch');
  });

  it('upsert replaces unsupported telegram config schema instead of failing', async () => {
    const unknownSchemaValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 999,
      telegram: {
        allowedChatIds: ['-100legacy'],
      },
      updatedAtMs: 111,
    }), 'utf8').toString('base64');

    const key = 'happier:channel-bridge:v1:server:local-3005:account:acct-1:telegram-config';
    const byKey = new Map<string, { value: string | null; version: number }>();
    byKey.set(key, {
      value: unknownSchemaValueBase64,
      version: 4,
    });

    const kv: ChannelBridgeKvClient = {
      get: async (requestedKey) => {
        const row = byKey.get(requestedKey);
        if (!row || row.value === null) {
          return { status: 404, body: { error: 'Key not found' } };
        }
        return {
          status: 200,
          body: {
            key: requestedKey,
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

    await expect(upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        allowedChatIds: ['-100111'],
      },
    })).resolves.toBe(5);

    const config = await readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(config.record).toMatchObject({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['-100111'],
      },
    });
    expect(config.version).toBe(5);
  });

  it('retries upsert after version mismatch using conflict payload without extra read', async () => {
    const key = 'happier:channel-bridge:v1:server:local-3005:account:acct-1:telegram-config';
    const initialValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['-100111'],
      },
      updatedAtMs: 101,
    }), 'utf8').toString('base64');
    const conflictValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['-100111'],
        requireTopics: false,
      },
      updatedAtMs: 202,
    }), 'utf8').toString('base64');

    let storedVersion = 0;
    let storedValue = initialValueBase64;
    let getCalls = 0;
    let mutateCalls = 0;

    const kv: ChannelBridgeKvClient = {
      get: async (requestedKey) => {
        getCalls += 1;
        return {
          status: 200,
          body: {
            key: requestedKey,
            value: storedValue,
            version: storedVersion,
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
              errors: [{ key, error: 'version-mismatch', version: storedVersion, value: storedValue }],
            },
          };
        }

        if (mutateCalls === 1) {
          storedVersion = 1;
          storedValue = conflictValueBase64;
          return {
            status: 409,
            body: {
              success: false,
              errors: [{ key: mutation.key, error: 'version-mismatch', version: storedVersion, value: storedValue }],
            },
          };
        }

        storedVersion += 1;
        storedValue = mutation.value ?? '';
        return {
          status: 200,
          body: {
            success: true,
            results: [{ key: mutation.key, version: storedVersion }],
          },
        };
      },
    };

    await upsertChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      update: {
        requireTopics: true,
      },
    });

    expect(getCalls).toBe(1);
    expect(mutateCalls).toBe(2);
    const finalParsed = JSON.parse(Buffer.from(storedValue, 'base64').toString('utf8')) as {
      telegram?: { requireTopics?: boolean };
    };
    expect(finalParsed.telegram?.requireTopics).toBe(true);
  });

  it('retries clear after version mismatch without extra reread', async () => {
    const key = 'happier:channel-bridge:v1:server:local-3005:account:acct-1:telegram-config';
    const initialValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['-100111'],
      },
      updatedAtMs: 101,
    }), 'utf8').toString('base64');
    const conflictValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['-100222'],
      },
      updatedAtMs: 202,
    }), 'utf8').toString('base64');

    let storedVersion = 0;
    let storedValue: string | null = initialValueBase64;
    let getCalls = 0;
    let mutateCalls = 0;

    const kv: ChannelBridgeKvClient = {
      get: async (requestedKey) => {
        getCalls += 1;
        if (storedValue === null) {
          return { status: 404, body: { error: 'Key not found' } };
        }
        return {
          status: 200,
          body: {
            key: requestedKey,
            value: storedValue,
            version: storedVersion,
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
              errors: [{ key, error: 'version-mismatch', version: storedVersion, value: storedValue }],
            },
          };
        }

        if (mutateCalls === 1) {
          storedVersion = 1;
          storedValue = conflictValueBase64;
          return {
            status: 409,
            body: {
              success: false,
              errors: [{ key: mutation.key, error: 'version-mismatch', version: storedVersion, value: storedValue }],
            },
          };
        }

        storedVersion += 1;
        storedValue = mutation.value ?? null;
        return {
          status: 200,
          body: {
            success: true,
            results: [{ key: mutation.key, version: storedVersion }],
          },
        };
      },
    };

    await clearChannelBridgeTelegramConfigInKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });

    expect(getCalls).toBe(1);
    expect(mutateCalls).toBe(2);
    expect(storedValue).toBeNull();
  });

  it('writes and reads bindings document from KV', async () => {
    const kv = createInMemoryKvClient();

    const first = await readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });
    expect(first.version).toBe(-1);
    expect(first.doc.bindings).toEqual([]);

    const writtenVersion = await writeChannelBridgeBindingsToKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
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
      accountId: 'acct-1',
    });
    expect(second.version).toBe(0);
    expect(second.doc.bindings).toHaveLength(1);
    expect(second.doc.bindings[0]?.sessionId).toBe('sess-1');
  });

  it('isolates bindings documents by account scope on the same server', async () => {
    const kv = createInMemoryKvClient();

    await writeChannelBridgeBindingsToKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      expectedVersion: -1,
      doc: {
        schemaVersion: 1,
        bindings: [
          {
            providerId: 'telegram',
            conversationId: '-100111',
            threadId: null,
            sessionId: 'sess-a',
            lastForwardedSeq: 1,
            createdAtMs: 1000,
            updatedAtMs: 1000,
          },
        ],
      },
    });

    const acct1 = await readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    });
    const acct2 = await readChannelBridgeBindingsFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-2',
    });

    expect(acct1.doc.bindings).toHaveLength(1);
    expect(acct1.doc.bindings[0]?.sessionId).toBe('sess-a');
    expect(acct2.doc.bindings).toEqual([]);
    expect(acct2.version).toBe(-1);
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
      accountId: 'acct-1',
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
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid channel bridge binding lastForwardedSeq at index 0');
  });

  it('throws when bindings payload omits required persisted cursor/timestamp fields', async () => {
    const malformedValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100111',
          sessionId: 'sess-1',
          lastForwardedSeq: 3,
          createdAtMs: 111,
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
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid channel bridge binding updatedAtMs at index 0');
  });

  it('throws when bindings payload includes malformed thread ids', async () => {
    const malformedValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      bindings: [
        {
          providerId: 'telegram',
          conversationId: '-100111',
          sessionId: 'sess-1',
          lastForwardedSeq: 1,
          createdAtMs: 100,
          updatedAtMs: 101,
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
      accountId: 'acct-1',
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
      accountId: 'acct-1',
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
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid or unsupported Telegram config schema');
  });

  it('throws when telegram config payload contains malformed non-empty allowedChatIds', async () => {
    const malformedAllowedChatIdsValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: ['   ', 123, null],
      },
      updatedAtMs: 123,
    }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedAllowedChatIdsValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.allowedChatIds payload');
  });

  it('throws when telegram config payload contains non-array allowedChatIds', async () => {
    const malformedAllowedChatIdsTypeValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        allowedChatIds: '-100123',
      },
      updatedAtMs: 123,
    }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedAllowedChatIdsTypeValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.allowedChatIds payload');
  });

  it('throws when telegram config payload contains invalid webhook.port', async () => {
    const invalidWebhookPortValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        webhook: {
          enabled: true,
          host: '127.0.0.1',
          port: 70_000,
        },
      },
      updatedAtMs: 123,
    }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: invalidWebhookPortValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.webhook.port payload');
  });

  it('throws when telegram config payload contains non-loopback webhook.host', async () => {
    const invalidWebhookHostValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        webhook: {
          enabled: true,
          host: '0.0.0.0',
          port: 8787,
        },
      },
      updatedAtMs: 123,
    }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: invalidWebhookHostValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
    })).rejects.toThrow('Invalid telegram.webhook.host payload');
  });

  it('treats invalid webhook.host payload as recoverable when allowUnsupportedSchema=true', async () => {
    const invalidWebhookHostValueBase64 = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      telegram: {
        webhook: {
          enabled: true,
          host: '0.0.0.0',
          port: 8787,
        },
      },
      updatedAtMs: 123,
    }), 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: invalidWebhookHostValueBase64,
          version: 7,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      allowUnsupportedSchema: true,
    })).resolves.toEqual({
      record: null,
      version: 7,
      rawValueBase64: invalidWebhookHostValueBase64,
    });
  });

  it('treats malformed telegram config payload as recoverable when allowUnsupportedSchema=true', async () => {
    const malformedValueBase64 = Buffer.from('not-json', 'utf8').toString('base64');
    const kv: ChannelBridgeKvClient = {
      get: async () => ({
        status: 200,
        body: {
          key: 'k',
          value: malformedValueBase64,
          version: 3,
        },
      }),
      mutate: async () => ({ status: 200, body: { success: true, results: [] } }),
    };

    await expect(readChannelBridgeTelegramConfigFromKv({
      kv,
      serverId: 'local-3005',
      accountId: 'acct-1',
      allowUnsupportedSchema: true,
    })).resolves.toEqual({
      record: null,
      version: 3,
      rawValueBase64: malformedValueBase64,
    });
  });
});
