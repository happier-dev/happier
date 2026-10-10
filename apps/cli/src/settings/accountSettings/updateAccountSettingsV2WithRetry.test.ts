import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
  updateAccountSettingsV2OnceAgainstLatest,
  updateAccountSettingsV2WithRetry,
} from './updateAccountSettingsV2WithRetry';
import type { AccountSettingsCache } from './accountSettingsCache';
import * as settingsContentOwner from './updateAccountSettingsV2WithRetry';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
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
  clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
} {
  return configuration as unknown as {
    serverUrl: string;
    apiServerUrl: string;
    publicServerUrl: string;
    webappUrl: string;
    clientEncryptionRequirement: 'follow_account' | 'require_e2ee';
  };
}

describe('updateAccountSettingsV2WithRetry', () => {
  it.each(['immutable', 'callback'] as const)('reuses a validated unchanged plain baseline for less CPU than parsing its bytes twice (%s)', async (kind) => {
    const credentials = createTokenOnlyCredentialsStub();
    const raw = { schemaVersion: 6, reviewPromptLikedApp: false, unrelated: { retained: true } };
    const deps = {
        // Only Account HTTP/cache boundaries are replaced; opener, mutation,
        // encryption-mode admission and schema parsing remain real.
        fetchSettings: async () => ({ content: { t: 'plain' as const, v: raw }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async () => { throw new Error('Unchanged Settings must not be submitted'); },
        writeCache: async () => {},
      };
    const update = () => kind === 'immutable'
      ? updateAccountSettingsV2WithRetry({ credentials, deps,
        mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: false }] } })
      : updateAccountSettingsV2OnceAgainstLatest({ credentials, deps, mutate: (value) => value });
    expect(await update()).toMatchObject({ status: 'unchanged', version: 5,
      settings: { reviewPromptLikedApp: false, unrelated: { retained: true } } });
    for (let warm = 0; warm < 20; warm += 1) { await update(); accountSettingsParse(raw); accountSettingsParse(raw); }
    const samples = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const currentStarted = process.cpuUsage();
      for (let iteration = 0; iteration < 200; iteration += 1) await update();
      const current = process.cpuUsage(currentStarted);
      const previousStarted = process.cpuUsage();
      for (let iteration = 0; iteration < 200; iteration += 1) { accountSettingsParse(raw); accountSettingsParse(raw); }
      const previous = process.cpuUsage(previousStarted);
      samples.push({ current: current.user + current.system, previous: previous.user + previous.system });
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[1];
    const currentCpuUs = median(samples.map(sample => sample.current));
    const repeatedParseCpuUs = median(samples.map(sample => sample.previous));
    console.info(JSON.stringify({ currentCpuUs, repeatedParseCpuUs }));
    expect(currentCpuUs).toBeLessThan(repeatedParseCpuUs * 0.8);
  });

  it.each([false, 'malformed'] as const)('revalidates an in-place callback mutation against the retained baseline (%s)', async value => {
    const submitted: unknown[] = [];
    const result = await updateAccountSettingsV2OnceAgainstLatest({
      credentials: createTokenOnlyCredentialsStub(),
      mutate: raw => {
        raw.reviewPromptLikedApp = value;
        return raw;
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: { reviewPromptLikedApp: true } }, version: 5 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async request => {
          submitted.push(request);
          return { success: true, version: 6 };
        },
        writeCache: async () => {},
      },
    });
    // Legacy fields retain the canonical parser's permissive projection;
    // this optimization must neither reuse stale validation nor tighten it.
    expect(result).toMatchObject({ status: 'applied', version: 6, settings: {
      reviewPromptLikedApp: accountSettingsParse({ reviewPromptLikedApp: value }).reviewPromptLikedApp,
    } });
    expect(submitted).toEqual([{ expectedVersion: 5, content: { t: 'plain', v: { reviewPromptLikedApp: value } } }]);
  });

  it.each(['owner cutover', 'one-shot mutation'] as const)('refuses a captured %s when Profile authority activates without a Settings version advance', async operation => {
    const credentials = createTokenOnlyCredentialsStub();
    const raw = { profiles: [{ v: 2, id: 'retained', name: 'Retained', createdAt: 1, updatedAt: 1 }], favoriteProfiles: ['retained'] };
    let persisted: Readonly<Record<string, unknown>> = raw;
    let transferRevision: number | 'absent' = 'absent';
    // Only HTTP is replaced: the incumbent raw opener, canonical request schema
    // and source writer stay real. The boundary models the server's transfer CAS.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      expect(new URL(String(input)).origin).toBe('https://profile-home.test');
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: persisted }, version: 4 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected owner cutover read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).origin).toBe('https://profile-home.test');
      expect(new URL(String(input)).pathname).toBe('/v2/account/settings');
      const request = AccountSettingsV2UpdateRequestSchema.parse(body);
      if (request.expectedProfileTransferRevision !== undefined && request.expectedProfileTransferRevision !== transferRevision) {
        return { status: 409, data: { success: false, error: 'profile-transfer-mismatch', currentProfileTransferRevision: transferRevision } };
      }
      if (request.content?.t !== 'plain') throw new Error('Expected keyless plain cutover');
      persisted = request.content.v;
      return { status: 200, data: { success: true, version: 5 } };
    });
    await runWithServerHttpBaseUrl('https://profile-home.test', async () => {
      const captured = ProfileTransferRowReadResponseV1Schema.parse((await axios.get(`https://profile-home.test${PROFILE_TRANSFER_ROUTE_V1}`)).data);
      if (captured.status !== 'absent') throw new Error('Expected absent transfer control capture');
      const source = await settingsContentOwner.readAccountSettingsV2Raw({ credentials });
      transferRevision = 2;
      if (operation === 'owner cutover') {
        const input = { credentials, expectedVersion: source.version, envelopeKind: source.envelopeKind,
          expectedProfileTransferRevision: 'absent' as const, raw: { favoriteProfiles: ['retained'] } };
        const result = await settingsContentOwner.replaceAccountSettingsV2RawForOwnerCutover(input);
        expect(result).toEqual({ success: false, error: 'profile-transfer-mismatch', currentProfileTransferRevision: 2 });
      } else {
        const input = { credentials, expectedVersion: source.version, expectedProfileTransferRevision: 'absent' as const,
          mutate: (latest: Readonly<Record<string, unknown>>) => ({ ...latest, favoriteProfiles: [] }) };
        const result = await updateAccountSettingsV2Once(input);
        expect(result).toEqual({ status: 'unavailable', retryable: false, reason: 'profile-transfer-mismatch' });
      }
      expect(persisted).toEqual(raw);
    });
  });
  it('prepares composite Settings content through the incumbent secret normalization and envelope owner', () => {
    const prepare = 'prepareAccountSettingsV2Content' in settingsContentOwner ? settingsContentOwner.prepareAccountSettingsV2Content : undefined;
    expect(typeof prepare).toBe('function');
    if (typeof prepare !== 'function') throw new Error('missing_composite_settings_preparation');
    const raw = { opaque: { kept: true }, customSecret: { _isSecretValue: true, value: 'private-fixture' } };
    expect(prepare({ credentials: createTokenOnlyCredentialsStub(), raw, envelopeKind: 'plain' })).toEqual({ t: 'plain', v: raw });
    const credentials = createLegacyCredentialsStub();
    const encrypted = prepare({ credentials, raw, envelopeKind: 'encrypted', randomBytes: length => new Uint8Array(length).fill(3) });
    expect(encrypted.t).toBe('encrypted');
    const opened = encrypted.t === 'encrypted' ? openAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: credentials.encryption, ciphertext: encrypted.c }) : null;
    expect(opened?.value).toMatchObject({ opaque: raw.opaque, customSecret: { _isSecretValue: true, encryptedValue: { t: 'enc-v1' } } });
    expect(decryptSecretValueWithKeysV1((opened?.value as typeof raw | undefined)?.customSecret,
      deriveSettingsSecretsReadKeysForCredentials(credentials))).toBe('private-fixture');
    expect(() => prepare({ credentials: createTokenOnlyCredentialsStub(), raw, envelopeKind: 'encrypted' })).toThrow();
  });
  it('retires only a committed legacy authoring key at the observed exact version', async () => {
    const raw = { lastUsedProfile: 'legacy', recentMachinePaths: [], futureSetting: { keep: true } };
    const writes: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    const deps = {
      fetchSettings: async () => ({ content: { t: 'plain' as const, v: raw }, version: 4 }),
      resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
      updateSettings: async (request: { expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }) => {
        writes.push(request);
        return { success: true as const, version: 5 };
      },
    };
    const result = await updateAccountSettingsV2Once({
      credentials: createTokenOnlyCredentialsStub(), expectedVersion: 4,
      retireLegacyAuthoringMemoryKey: 'lastUsedProfile', mutate: (settings) => settings, deps,
    });
    expect(result.status).toBe('applied');
    expect(writes[0]?.content).toEqual({ t: 'plain', v: { recentMachinePaths: [], futureSetting: { keep: true } } });
    writes.length = 0;
    const stale = await updateAccountSettingsV2Once({
      credentials: createTokenOnlyCredentialsStub(), expectedVersion: 3,
      retireLegacyAuthoringMemoryKey: 'lastUsedProfile', mutate: (settings) => settings, deps,
    });
    expect(stale.status).toBe('conflict');
    expect(writes).toEqual([]);
  });

  it('settles the submitted sparse mutation without replaying preparation after a lost response', async () => {
    let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: {} };
    let version = 1;
    let prepared = 0;
    const result = await updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentialsStub(),
      prepareMutation: () => {
        prepared += 1;
        return { operations: [{ op: 'set', key: 'rolesV1', value: { overrides: {} } }] };
      },
      deps: {
        fetchSettings: async () => ({ content, version }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request) => {
          content = request.content!;
          version += 1;
          throw new Error('Response lost after commit');
        },
      },
    });
    expect(result).toMatchObject({ status: 'satisfied', version: 2 });
    expect(prepared).toBe(1);
  });

  it('replays an explicitly prepared mutation against the conflicting Account winner', async () => {
    const winner = { futureSetting: true, favoriteMachines: ['existing'] };
    const writes: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    const result = await updateAccountSettingsV2WithRetry({
      credentials: createTokenOnlyCredentialsStub(),
      prepareMutation: (raw) => ({ operations: [{ op: 'set', key: 'favoriteMachines', value:
        [...accountSettingsParse(raw).favoriteMachines, 'new'] }] }),
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request) => {
          writes.push(request);
          return writes.length === 1
            ? { success: false, error: 'version-mismatch', currentVersion: 2, currentContent: { t: 'plain', v: winner } }
            : { success: true, version: 3 };
        },
      },
    });
    expect(result).toMatchObject({ status: 'applied', version: 3 });
    expect(writes.map((write) => write.expectedVersion)).toEqual([1, 2]);
    const committed = writes[1]!.content;
    if (committed?.t !== 'plain') throw new Error('Expected plain Account write');
    expect(committed.v.futureSetting).toBe(true);
    expect(committed.v.favoriteMachines).toEqual(['existing', 'new']);
  });

  it('preserves an explicitly prepared empty roles root while keeping other defaults absent', async () => {
    const calls: Array<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }> = [];
    let prepared = 0;
    const result = await updateAccountSettingsV2OnceAgainstLatest({
      credentials: createTokenOnlyCredentialsStub(),
      prepareMutation: async (raw) => {
        prepared += 1;
        expect(raw).toEqual({ customFutureField: 'retained' });
        return { operations: [{ op: 'set', key: 'rolesV1', value: { overrides: {} } }] };
      },
      deps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: { customFutureField: 'retained' } }, version: 7 }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings: async (request) => { calls.push(request); return { success: true, version: 8 }; },
      },
    });
    expect(result).toMatchObject({ status: 'applied', version: 8 });
    expect(prepared).toBe(1);
    expect(calls).toEqual([{ expectedVersion: 7, content: { t: 'plain', v: { customFutureField: 'retained', rolesV1: { overrides: {} } } } }]);
  });
  const originalServerUrl = configuration.serverUrl;
  const originalApiServerUrl = configuration.apiServerUrl;
  const originalPublicServerUrl = configuration.publicServerUrl;
  const originalWebappUrl = configuration.webappUrl;
  const originalClientEncryptionRequirement = configuration.clientEncryptionRequirement;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mutableConfigurationForTest(), {
      serverUrl: originalServerUrl,
      apiServerUrl: originalApiServerUrl,
      publicServerUrl: originalPublicServerUrl,
      webappUrl: originalWebappUrl,
      clientEncryptionRequirement: originalClientEncryptionRequirement,
    });
  });

  it('refuses to read or rewrite plaintext settings when the environment requires E2EE', async () => {
    Object.assign(mutableConfigurationForTest(), { clientEncryptionRequirement: 'require_e2ee' });
    const updateSettings = vi.fn();
    await expect(updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'reset', key: 'reviewPromptLikedApp' }] },
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 2 }) },
          version: 5,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
    expect(updateSettings).not.toHaveBeenCalled();
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

  it('never exceeds three attempts when an untyped caller supplies a larger override', async () => {
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>): Promise<AccountSettingsV2UpdateResponse> => ({
      success: false,
      error: 'version-mismatch',
      currentVersion: request.expectedVersion + 1,
      currentContent: { t: 'plain', v: accountSettingsParse({ schemaVersion: 7 }) },
    }));

    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'set', key: 'reviewPromptLikedApp', value: true }] },
      maxAttempts: 10,
      deps: {
        fetchSettings: async () => ({
          content: { t: 'plain', v: accountSettingsParse({ schemaVersion: 7 }) },
          version: 1,
        }),
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    } as Parameters<typeof updateAccountSettingsV2WithRetry>[0] & { maxAttempts: number });

    expect(result).toEqual({ status: 'conflict', currentVersion: 4 });
    expect(updateSettings).toHaveBeenCalledTimes(3);
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

  it.each([false, true])('confirms a retained-host reset only when readback cleared its development alias: %s', async (cleared) => {
    const raw = {
      sessionTmuxByMachineId: {
        machine: { useTmux: false, terminalHost: 'herdr', sessionName: '', isolated: true, tmpDir: null },
      },
    };
    let fetchCount = 0;
    const resetRaw = {
      sessionTmuxByMachineId: {
        machine: { useTmux: false, sessionName: '', isolated: true, tmpDir: null },
      },
    };
    const fetchSettings = vi.fn(async () => {
      fetchCount += 1;
      return {
        content: { t: 'plain' as const, v: fetchCount > 1 && cleared ? resetRaw : raw },
        version: fetchCount === 1 ? 5 : 6,
      };
    });
    const updateSettings = vi.fn(async (): Promise<AccountSettingsV2UpdateResponse> => {
      throw new Error('connection reset after request body');
    });
    const result = await updateAccountSettingsV2WithRetry({
      credentials: createLegacyCredentialsStub(),
      mutation: { operations: [{ op: 'reset', key: 'sessionTerminalHostByMachineId' }] },
      deps: {
        fetchSettings,
        resolveAccountEncryptionMode: resolvePlainAccountEncryptionMode,
        updateSettings,
      },
    });
    if (cleared) {
      expect(result.status).toBe('satisfied');
      if (result.status !== 'satisfied') throw new Error('Expected confirmed reset');
      expect(result.version).toBe(6);
      expect(result.settings.sessionTerminalHostByMachineId).toEqual({});
    } else {
      expect(result).toEqual({ status: 'outcomeUnknown', lastKnownVersion: 6 });
    }
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
