import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import {
  accountSettingsParse,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import { updateAccountSettingsV2WithRetry } from './updateAccountSettingsV2WithRetry';
import type { AccountSettingsCache } from './accountSettingsCache';

type LegacyCredentialsStub = Credentials & Readonly<{ encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }> }>;

function createLegacyCredentialsStub(): LegacyCredentialsStub {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function mutableConfigurationForTest(): {
  serverUrl: string;
  apiServerUrl: string;
  publicServerUrl: string;
  webappUrl: string;
} {
  return configuration as unknown as {
    serverUrl: string;
    apiServerUrl: string;
    publicServerUrl: string;
    webappUrl: string;
  };
}

describe('updateAccountSettingsV2WithRetry', () => {
  const originalServerUrl = configuration.serverUrl;
  const originalApiServerUrl = configuration.apiServerUrl;
  const originalPublicServerUrl = configuration.publicServerUrl;
  const originalWebappUrl = configuration.webappUrl;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: originalServerUrl,
      apiServerUrl: originalApiServerUrl,
      publicServerUrl: originalPublicServerUrl,
      webappUrl: originalWebappUrl,
    });
  });

  it('updates plain v2 content and posts plain content back', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings: Readonly<Record<string, unknown>>) => ({
        ...settings,
        mcpServersSettingsV1: { v: 1, strictMode: false, servers: [], bindings: [] },
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 6 };
        },
      },
    });

    expect(result.version).toBe(6);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(5);
    expect(calls[0]?.content?.t).toBe('plain');
    expect((calls[0]?.content as any)?.v?.mcpServersSettingsV1).toEqual({ v: 1, strictMode: false, servers: [], bindings: [] });
  });

  it('awaits an asynchronous per-attempt mutation before sealing and writing', async () => {
    let releaseMutation!: () => void;
    const mutationBarrier = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let updateCalls = 0;
    const operation = updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: async (settings: Readonly<Record<string, unknown>>) => {
        await mutationBarrier;
        return { ...settings, asynchronouslyDerived: 'ready' };
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: { schemaVersion: 7 } }, version: 1 }),
        updateSettings: async (request): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          expect(request.content).toMatchObject({ t: 'plain', v: { asynchronouslyDerived: 'ready' } });
          return { success: true, version: 2 };
        },
      },
    });

    await Promise.resolve();
    expect(updateCalls).toBe(0);
    releaseMutation();
    await expect(operation).resolves.toMatchObject({ version: 2 });
    expect(updateCalls).toBe(1);
  });

  it('decrypts encrypted v2 content, applies mutation, and posts encrypted content back', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = { ...accountSettingsParse({ schemaVersion: 2 }), someKey: 'before' };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(10);
    expect(calls[0]?.content?.t).toBe('encrypted');

    const postedCiphertext = (calls[0]?.content as any)?.c ?? '';
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: postedCiphertext,
    });
    expect(opened?.value).toMatchObject({ someKey: 'after' });
  });

  it('retries when the server reports a version mismatch', async () => {
    const credentials = createLegacyCredentialsStub();
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    let attempt = 0;

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 1,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          attempt += 1;
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          if (attempt === 1) {
            return {
              success: false,
              error: 'version-mismatch',
              currentVersion: 2,
              currentContent: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2, otherKey: 'changed' }) },
            };
          }
          return { success: true, version: 3 };
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.expectedVersion).toBe(1);
    expect(calls[1]?.expectedVersion).toBe(2);
    expect((calls[1]?.content as any)?.v).toMatchObject({ otherKey: 'changed', hello: 'world' });
  });

  it('preserves malformed known raw fields while applying a sparse mutation', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings: Readonly<Record<string, unknown>>) => ({ ...settings, hello: 'world' }),
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              acpCatalogSettingsV1: 'malformed',
              unknownFutureField: { keep: true },
            },
          },
          version: 7,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 8 };
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect((calls[0]?.content as any)?.v).toMatchObject({
      acpCatalogSettingsV1: 'malformed',
      unknownFutureField: { keep: true },
      hello: 'world',
    });
  });

  it('preserves untouched raw fields when mutation returns sparse touched settings', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'before',
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: () => ({ someKey: 'after' }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toEqual({
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'after',
    });
  });

  it('filters parser-materialized defaults from mutation results before posting', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => ({
        ...accountSettingsParse(settings),
        customFutureField: settings.customFutureField,
        someKey: 'after',
      }),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 11 };
        },
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    });

    const posted = calls[0]?.content;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted content');
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    expect(opened?.value).toEqual({
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
      customFutureField: { preserved: true },
      someKey: 'after',
    });
  });

  it('skips the update when mutation output is semantically equal to the raw baseline', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      usageLimitRecoverySettingsV1: 'malformed-but-untouched',
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });
    let updateCalls = 0;
    const writes: AccountSettingsCache[] = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials,
      mutate: (settings: Readonly<Record<string, unknown>>) => accountSettingsParse(settings),
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          return { success: true, version: 11 };
        },
        writeCache: async (_path, cache) => {
          writes.push(cache);
        },
      },
    });

    expect(result.version).toBe(10);
    expect(updateCalls).toBe(0);
    expect(writes).toEqual([
      expect.objectContaining({
        settingsContent: { t: 'encrypted', c: initialCiphertext },
        settingsVersion: 10,
      }),
    ]);
  });

  it('uses apiServerUrl for fetch and update requests when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        version: 5,
        content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 6 }) },
      },
    } as any);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { success: true, version: 6 },
    } as any);

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutate: (settings) => ({ ...settings, hello: 'world' }),
    });

    expect(result.version).toBe(6);
    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        content: { t: 'plain', v: expect.objectContaining({ hello: 'world' }) },
        expectedVersion: 5,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });

  it('writes the refreshed disk cache under a credentials-derived path', async () => {
    const writeCache = vi.fn(async () => {});
    const resolveCachePath = vi.fn((credentials?: Credentials) => `/tmp/server/${credentials?.token ?? 'missing'}/account.settings.cache.json`);

    await updateAccountSettingsV2WithRetry({
      credentials: { ...createLegacyCredentialsStub(), token: 'token-account-a' },
      mutate: (settings) => ({ ...settings, hello: 'world' }),
      deps: {
        resolveCachePath,
        writeCache,
        fetchSettings: async () => ({ content: { t: 'plain', v: accountSettingsParse({}) }, version: 5 }),
        updateSettings: async () => ({ success: true, version: 6 }),
      },
    });

    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-account-a' }));
    expect(writeCache).toHaveBeenCalledWith(
      '/tmp/server/token-account-a/account.settings.cache.json',
      expect.objectContaining({ version: 2, settingsVersion: 6 }),
    );
  });
});
