import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { Credentials, StoredCredentials, TokenOnlyCredentials } from '@/persistence';
import {
  ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES,
  accountSettingsParse,
  decryptSecretValueWithKeysV1,
  encryptSecretStringV1,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type SavedSecret,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import {
  updateAccountSettingsV2Once,
  updateAccountSettingsV2WithRetry,
} from './updateAccountSettingsV2WithRetry';
import type { AccountSettingsCache } from './accountSettingsCache';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

type LegacyCredentialsStub = Credentials & Readonly<{ encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }> }>;

function createLegacyCredentialsStub(): LegacyCredentialsStub {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function createTokenOnlyCredentialsStub(): TokenOnlyCredentials {
  return {
    token: 'token-only',
    encryption: null,
  };
}

async function resolvePlainAccountEncryptionMode(): Promise<'plain'> {
  return 'plain';
}

async function resolveE2eeAccountEncryptionMode(): Promise<'e2ee'> {
  return 'e2ee';
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

  it('does not begin a settings mutation for a retired prompt action', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSettings = vi.fn(async () => ({ content: null, version: 0 }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      signal: controller.signal,
      mutation: { operations: [{ op: 'reset', key: 'reviewPromptLikedApp' }] },
      deps: { fetchSettings },
    })).resolves.toEqual({ status: 'cancelled', submitted: false });
    expect(fetchSettings).not.toHaveBeenCalled();
  });

  it('updates plain v2 content and posts plain content back', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'mcpServersSettingsV1',
          value: { v: 1, strictMode: true, servers: [], bindings: [] },
        }],
      },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 6 };
        },
      },
    });

    expect(result).toMatchObject({ status: 'applied', version: 6 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.expectedVersion).toBe(5);
    expect(calls[0]?.content?.t).toBe('plain');
    expect((calls[0]?.content as any)?.v?.mcpServersSettingsV1).toEqual({ v: 1, strictMode: true, servers: [], bindings: [] });
  });

  it('updates plain v2 content with token-only credentials without writing a raw durable cache', async () => {
    const writeCache = vi.fn(async () => {});
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 6,
    }));

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
        writeCache,
      },
    });

    expect(result).toMatchObject({ status: 'applied', version: 6 });
    expect(updateSettings).toHaveBeenCalledWith({
      expectedVersion: 5,
      content: {
        t: 'plain',
        v: expect.objectContaining({ reviewPromptLikedApp: true }),
      },
    });
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('uses the account mode for the first Settings write instead of inferring from keyed credentials', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 1,
    }));

    await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({ content: null, version: 0 }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
      },
    });

    expect(updateSettings).toHaveBeenCalledWith({
      expectedVersion: 0,
      content: {
        t: 'plain',
        v: { reviewPromptLikedApp: true },
      },
    });
  });

  it('returns a locked result for the first E2EE Settings write when token-only credentials lack real material', async () => {
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({ content: null, version: 0 }),
        resolveAccountEncryptionMode: async () => 'e2ee',
        updateSettings,
      },
    })).resolves.toEqual({
      status: 'locked',
      reason: 'encryptionMaterialUnavailable',
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns a locked result for retained encrypted settings when token-only credentials lack material', async () => {
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentialsStub(),
      mutation: { operations: [{ op: 'reset', key: 'reviewPromptLikedApp' }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: 'retained-e2ee-settings' },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
      },
    })).resolves.toEqual({
      status: 'locked',
      reason: 'encryptionMaterialUnavailable',
    });
  });

  it('returns a locked result without writing when encrypted Settings content cannot be opened', async () => {
    const updateSettings = vi.fn();

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: 'not-a-readable-account-settings-ciphertext' },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({
      status: 'locked',
      reason: 'contentUnreadable',
    });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns retryable unavailable before mutating when the Settings fetch cannot reach the server', async () => {
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        },
      },
    })).resolves.toEqual({ status: 'unavailable', retryable: true });
  });

  it('returns retryable unavailable for a one-shot mutation before it can read its expected version', async () => {
    const mutate = vi.fn((settings: Readonly<Record<string, unknown>>) => ({ ...settings, secret: 'new' }));

    await expect(updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      mutate,
      deps: {
        fetchSettings: async () => {
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        },
      },
    })).resolves.toEqual({ status: 'unavailable', retryable: true });

    expect(mutate).not.toHaveBeenCalled();
  });

  it('normalizes a keyed caller Saved Secret to raw SecretString inside a plain server envelope', async () => {
    const credentials = createLegacyCredentialsStub();
    const encryptedValue = encryptSecretStringV1(
      'plain-cross-device-secret',
      deriveSettingsSecretsKeyForCredentials(credentials),
      (length) => new Uint8Array(length).fill(4),
    );
    const prepared: SavedSecret = {
      id: 'secret-provider',
      name: 'Provider secret',
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, encryptedValue },
      createdAt: 1,
      updatedAt: 1,
    };
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 2,
    }));

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutation: { operations: [{ op: 'set', key: 'secrets', value: [prepared] }] },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    });

    expect(updateSettings).toHaveBeenCalledWith({
      expectedVersion: 1,
      content: {
        t: 'plain',
        v: expect.objectContaining({
          secrets: [expect.objectContaining({
            encryptedValue: {
              _isSecretValue: true,
              value: 'plain-cross-device-secret',
            },
          })],
        }),
      },
    });
  });

  it('normalizes raw SecretString values before sealing an E2EE settings envelope', async () => {
    const credentials = createLegacyCredentialsStub();
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: {},
      randomBytes: () => new Uint8Array(24).fill(1),
    });
    const posts: AccountSettingsStoredContentEnvelope[] = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutation: {
        operations: [{ op: 'set', key: 'secrets', value: [{
          id: 'secret-provider',
          name: 'Provider secret',
          kind: 'apiKey',
          encryptedValue: {
            _isSecretValue: true,
            value: 'e2ee-provider-secret',
          },
          createdAt: 1,
          updatedAt: 1,
        }] }],
      },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
        updateSettings: async (request) => {
          if (request.content) posts.push(request.content);
          return { success: true, version: 2 };
        },
        randomBytes: (length) => new Uint8Array(length).fill(3),
      },
    });

    const posted = posts[0] ?? null;
    expect(posted?.t).toBe('encrypted');
    if (posted?.t !== 'encrypted') throw new Error('expected encrypted settings envelope');
    const opened = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: posted.c,
    });
    const secrets = (opened?.value as { secrets?: SavedSecret[] } | undefined)?.secrets ?? [];
    expect(secrets[0]?.encryptedValue.value).toBeUndefined();
    expect(decryptSecretValueWithKeysV1(
      secrets[0]?.encryptedValue,
      deriveSettingsSecretsReadKeysForCredentials(credentials),
    )).toBe('e2ee-provider-secret');
  });

  it('decrypts encrypted v2 content, applies mutation, and posts encrypted content back', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = { ...accountSettingsParse({ schemaVersion: 2 }), reviewPromptLikedApp: false };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: initial,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
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
    expect(opened?.value).toMatchObject({ reviewPromptLikedApp: true });
  });

  it('reapplies one immutable mutation to the fresh base after a CAS conflict', async () => {
    const credentials = createLegacyCredentialsStub();
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    let attempt = 0;

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
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
    expect((calls[1]?.content as any)?.v).toMatchObject({
      otherKey: 'changed',
      reviewPromptLikedApp: true,
    });
  });

  it('rejects malformed known raw fields before applying an unrelated immutable operation', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: {
              usageLimitRecoverySettingsV1: 'malformed-but-untouched',
              unknownFutureField: { keep: true },
            },
          },
          version: 7,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: async (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>): Promise<AccountSettingsV2UpdateResponse> => {
          calls.push({ expectedVersion: req.expectedVersion, content: req.content });
          return { success: true, version: 8 };
        },
      },
    });

    expect(result).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(calls).toHaveLength(0);
  });

  it('preserves a bounded unknown future field while applying an immutable operation', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
      customFutureField: { preserved: true },
      reviewPromptLikedApp: false,
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
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        resolveAccountEncryptionMode: async () => 'e2ee',
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
      customFutureField: { preserved: true },
      reviewPromptLikedApp: true,
    });
  });

  it('does not materialize parser defaults while applying an immutable operation', async () => {
    const credentials = createLegacyCredentialsStub();
    const initial = {
      schemaVersion: 2,
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
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        resolveAccountEncryptionMode: async () => 'e2ee',
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
      customFutureField: { preserved: true },
      reviewPromptLikedApp: true,
    });
  });

  it('rejects a semantically no-op operation when an unrelated known root is malformed', async () => {
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
      mutation: { operations: [{ op: 'reset', key: 'reviewPromptLikedApp' }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 10,
        }),
        resolveAccountEncryptionMode: async () => 'e2ee',
        updateSettings: async (): Promise<AccountSettingsV2UpdateResponse> => {
          updateCalls += 1;
          return { success: true, version: 11 };
        },
        writeCache: async (_path, cache) => {
          writes.push(cache);
        },
      },
    });

    expect(result).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(updateCalls).toBe(0);
    expect(writes).toEqual([]);
  });

  it('reports the refused Settings response body code as the unavailable reason', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 503,
      data: { error: 'account_settings_storage_unavailable' },
    } as any);

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
    })).resolves.toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'account_settings_storage_unavailable',
    });
  });

  it('does not present an unexpected refusal payload as a Settings reason', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 502,
      data: '<html><body>Bad Gateway</body></html>',
    } as any);

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
    })).resolves.toEqual({ status: 'unavailable', retryable: true });
  });

  it('uses apiServerUrl for fetch and update requests when canonical serverUrl differs', async () => {
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: 'https://public.example.test',
      apiServerUrl: 'http://127.0.0.1:3005',
      publicServerUrl: 'https://public.example.test',
      webappUrl: 'https://public.example.test',
    });

    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          version: 5,
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 6 }) },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { mode: 'plain', updatedAt: 0 },
      } as any);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: { success: true, version: 6 },
    } as any);

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
    });

    expect(result).toMatchObject({ status: 'applied', version: 6 });
    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect(getSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v1/account/encryption',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3005/v2/account/settings',
      expect.objectContaining({
        content: { t: 'plain', v: expect.objectContaining({ reviewPromptLikedApp: true }) },
        expectedVersion: 5,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });

  it('writes the refreshed disk cache under a credentials-derived path', async () => {
    const writeCache = vi.fn(async () => {});
    const resolveCachePath = vi.fn((credentials?: StoredCredentials) => `/tmp/server/${credentials?.token ?? 'missing'}/account.settings.cache.json`);
    const credentials = { ...createLegacyCredentialsStub(), token: 'token-account-a' };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: accountSettingsParse({}),
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    await updateAccountSettingsV2WithRetry({
      credentials,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        resolveCachePath,
        writeCache,
        fetchSettings: async () => ({ content: { t: 'encrypted', c: initialCiphertext }, version: 5 }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
        updateSettings: async () => ({ success: true, version: 6 }),
      },
    });

    expect(resolveCachePath).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-account-a' }));
    expect(writeCache).toHaveBeenCalledWith(
      '/tmp/server/token-account-a/account.settings.cache.json',
      expect.objectContaining({ version: 2, settingsVersion: 6 }),
    );
  });

  it('rejects a stale explicit version before evaluating a one-shot mutation or writing', async () => {
    const mutate = vi.fn((settings: Readonly<Record<string, unknown>>) => ({ ...settings, secret: 'new' }));
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({ success: true, version: 7 }));

    const result = await updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      mutate,
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 6 }),
        updateSettings,
      },
    });

    expect(result).toEqual({ status: 'conflict', currentVersion: 6 });
    expect(mutate).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does not replay a one-shot mutation after an Account Settings CAS conflict', async () => {
    const mutate = vi.fn((settings: Readonly<Record<string, unknown>>) => ({ ...settings, secret: 'new' }));
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: false,
      error: 'version-mismatch',
      currentVersion: 6,
      currentContent: { t: 'plain', v: { concurrent: true } },
    }));

    const result = await updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      mutate,
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    });

    expect(result).toEqual({ status: 'conflict', currentVersion: 6 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('does not durably cache an acknowledged one-shot encrypted write after its commit lifetime retires', async () => {
    const credentials = createLegacyCredentialsStub();
    const initialContent = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: {},
      randomBytes: () => new Uint8Array(24).fill(1),
    });
    let commitCurrent = true;
    const cached: AccountSettingsCache[] = [];

    const result = await updateAccountSettingsV2Once({
      credentials,
      expectedVersion: 5,
      shouldCommit: () => commitCurrent,
      mutate: (settings) => ({ ...settings, reviewPromptLikedApp: true }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'encrypted', c: initialContent }, version: 5 }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
        randomBytes: () => new Uint8Array(24).fill(2),
        updateSettings: async () => {
          commitCurrent = false;
          return { success: true, version: 6 };
        },
        resolveCachePath: () => '/tmp/account-settings.cache.json',
        writeCache: async (_path, cache, options) => {
          if (options?.shouldCommit?.() !== false) cached.push(cache);
        },
      },
    });

    expect(result).toMatchObject({ status: 'applied', version: 6 });
    expect(cached).toEqual([]);
  });

  it('marks a submitted one-shot write with a lost response as outcome unknown', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      throw new Error('connection reset after request body');
    });

    await expect(updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      mutate: (settings) => ({ ...settings, secret: 'new' }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'outcomeUnknown', lastKnownVersion: 5 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('returns a received replay-safe CAS success after cancellation starts during submission', async () => {
    const controller = new AbortController();
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      return { success: true, version: 6 };
    });

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      signal: controller.signal,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toMatchObject({ status: 'applied', version: 6 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('returns a received replay-safe CAS conflict after cancellation starts during submission', async () => {
    const controller = new AbortController();
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      return {
        success: false,
        error: 'version-mismatch',
        currentVersion: 6,
        currentContent: { t: 'plain', v: { concurrent: true } },
      };
    });

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      signal: controller.signal,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'conflict', currentVersion: 6 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('settles an aborted submitted replay-safe write as satisfied only after a fresh raw read proves its sparse patch', async () => {
    const controller = new AbortController();
    let fetchCount = 0;
    const fetchSettings = vi.fn(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { content: { t: 'plain' as const, v: {} }, version: 5 }
        : { content: { t: 'plain' as const, v: { reviewPromptLikedApp: true } }, version: 6 };
    });
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      throw new Error('connection reset after request body');
    });

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      signal: controller.signal,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings,
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toMatchObject({ status: 'satisfied', version: 6 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('settles an aborted submitted replay-safe write as outcome unknown when a fresh raw read cannot prove its sparse patch', async () => {
    const controller = new AbortController();
    let fetchCount = 0;
    const fetchSettings = vi.fn(async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { content: { t: 'plain' as const, v: {} }, version: 5 }
        : { content: { t: 'plain' as const, v: { concurrent: true } }, version: 6 };
    });
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      throw new Error('connection reset after request body');
    });

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      signal: controller.signal,
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings,
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'outcomeUnknown', lastKnownVersion: 6 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('returns typed invalid tooLarge for an oversized plain canonical document before submitting it', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 6,
    }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: {
        operations: [{
          op: 'set',
          key: 'providerSettingsV1',
          value: { payload: 'x'.repeat(300 * 1024) },
        }],
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns typed invalid tooLarge for a migration-only oversized plain predecessor before submitting a new mutation', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 6,
    }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'reset', key: 'reviewPromptLikedApp' }] },
      deps: {
        fetchSettings: async () => ({
          content: {
            t: 'plain',
            v: { payload: 'x'.repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES) },
          },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns typed invalid tooLarge for an oversized encrypted canonical document before submitting it', async () => {
    const credentials = createLegacyCredentialsStub();
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: {},
      randomBytes: () => new Uint8Array(24).fill(1),
    });
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 6,
    }));

    await expect(updateAccountSettingsV2WithRetry({
      credentials,
      mutation: {
        operations: [{
          op: 'set',
          key: 'providerSettingsV1',
          value: { payload: 'x'.repeat(300 * 1024) },
        }],
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'encrypted', c: initialCiphertext }, version: 5 }),
        resolveAccountEncryptionMode: resolveE2eeAccountEncryptionMode,
        updateSettings,
        randomBytes: () => new Uint8Array(24).fill(2),
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('maps a received V2 typed too-large refusal without retrying', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => (
      {
        success: false,
        error: 'invalid',
        reason: 'tooLarge',
      } as unknown as AccountSettingsV2UpdateResponse
    ));

    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('returns typed invalid tooLarge for an oversized one-shot mutation before submitting it', async () => {
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => ({
      success: true,
      version: 6,
    }));

    await expect(updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      mutate: (settings) => ({
        ...settings,
        payload: 'x'.repeat(ACCOUNT_SETTINGS_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES),
      }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns a received one-shot CAS conflict after cancellation starts during submission', async () => {
    const controller = new AbortController();
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      return {
        success: false,
        error: 'version-mismatch',
        currentVersion: 6,
        currentContent: { t: 'plain', v: { concurrent: true } },
      };
    });

    await expect(updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      signal: controller.signal,
      mutate: (settings) => ({ ...settings, secret: 'new' }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'conflict', currentVersion: 6 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });

  it('marks an aborted submitted one-shot write with no response as outcome unknown', async () => {
    const controller = new AbortController();
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      controller.abort();
      throw new Error('connection reset after request body');
    });

    await expect(updateAccountSettingsV2Once({
      credentials: createLegacyCredentialsStub(),
      expectedVersion: 5,
      signal: controller.signal,
      mutate: (settings) => ({ ...settings, secret: 'new' }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).resolves.toEqual({ status: 'outcomeUnknown', lastKnownVersion: 5 });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
