import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  accountSettingsParse,
  CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY,
  ConnectedServiceCredentialRecordV1Schema,
  decryptSecretValueWithKeysV1,
  deriveSettingsSecretsKeySetV1,
  encryptSecretStringV1,
  FeaturesResponseSchema,
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountConfigurationPatchV4Schema,
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  SavedSecretSchema,
  openQualifiedConnectedAccountContentEnvelope,
  openConnectedServiceCredentialCiphertext,
  sealAccountScopedBlobCiphertext,
  sealQualifiedConnectedAccountContentEnvelope,
  type AccountSettingsStoredContentEnvelope,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountDeviceTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';
import {
  clearActiveAccountSettingsSnapshot,
  commitActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
  QualifiedConnectedAccountCredentialConflictError,
} from '@/api/client/qualifiedConnectedAccountApi';

import {
  createQualifiedConnectedAccountDaemonPersistence,
} from './qualifiedConnectedAccountDaemonPersistence';

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });
const account = Object.freeze({ service, accountId: 'account-1' });
type QualifiedConnectedAccountCredentialMutationV4 = ReturnType<
  typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse
>;

function retainStringValues(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function savedSecret(id: string, name: string) {
  return SavedSecretSchema.parse({
    id,
    name,
    kind: 'other',
    encryptedValue: {
      _isSecretValue: true,
      encryptedValue: { t: 'enc-v1', c: `ciphertext-${id}` },
    },
    createdAt: 1,
    updatedAt: 1,
  });
}

function secretReferences(input: Readonly<Record<string, string>>) {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, input),
  );
}

function createServiceConfigurationPersistenceHarness(
  initialSettings: Readonly<Record<string, unknown>>,
  createSecretId: () => string,
) {
  let settings = initialSettings;
  const updateAccountSettings = vi.fn(async (
    mutate: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
  ) => {
    settings = mutate(settings);
    return settings;
  });
  const persistence = createQualifiedConnectedAccountDaemonPersistence({
    credentials: {
      token: 'token-1',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32),
        machineKey: new Uint8Array(32).fill(3),
      },
    },
    getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
    readCredential: vi.fn(async () => null),
    readConfiguration: vi.fn(async () => null),
    mutateCredential: vi.fn(),
    mutateConfiguration: vi.fn(),
    secrets: {
      has: vi.fn(async () => false),
      read: vi.fn(async () => null),
    },
    randomBytes: (length) => new Uint8Array(length).fill(7),
    readAccountSettings: () => settings,
    updateAccountSettings,
    createConfigurationRevision: () => 'configuration-next',
    createSecretId,
  });
  return Object.freeze({
    persistence,
    updateAccountSettings,
    settings: () => settings,
  });
}

// Exact credential root accepted by released CLI v0.2.1
// (4913c1e533c872a0712ba1c25b3104fd470aacc2).
const ReleasedCredentialRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    serviceId: z.string(),
    profileId: z.string(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    kind: z.literal('oauth'),
    oauth: z.object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      idToken: z.string().min(1).nullable(),
      tokenType: z.string().min(1).nullable(),
      scope: z.string().min(1).nullable(),
      providerAccountId: z.string().min(1).nullable(),
      providerEmail: z.string().min(1).nullable(),
      raw: z.unknown().nullable(),
    }),
    token: z.null(),
  }),
  z.object({
    v: z.literal(1),
    serviceId: z.string(),
    profileId: z.string(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    kind: z.literal('token'),
    oauth: z.null(),
    token: z.object({
      token: z.string().min(1),
      providerAccountId: z.string().min(1).nullable(),
      providerEmail: z.string().min(1).nullable(),
      raw: z.unknown().nullable(),
    }),
  }),
]);

describe('createQualifiedConnectedAccountDaemonPersistence', () => {
  it('does not publish a late Account A Settings settlement after Account B becomes active', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'account-a-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
    };
    const initialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: {},
      randomBytes: () => new Uint8Array(24).fill(2),
    });
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    let releaseUpdate!: () => void;
    let submittedContent: AccountSettingsStoredContentEnvelope | null | undefined;
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>) => {
      submittedContent = request.content;
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      return { success: true as const, version: 4 };
    });
    const writeCache = vi.fn(async () => {});
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'e2ee'> => 'e2ee'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-a',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({
          content: { t: 'encrypted', c: initialCiphertext },
          version: 3,
        }),
        updateSettings,
        resolveAccountEncryptionMode: async () => 'e2ee',
        resolveCachePath: () => '/tmp/account-a-settings',
        writeCache,
      },
    });

    const pending = persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: {},
      generation: 'generation-a',
      immutableGenerationId: 'artifact-a',
    });
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(submittedContent?.t).toBe('encrypted');

    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ schemaVersion: 7 }),
      settingsVersion: 9,
      loadedAtMs: 200,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-b-scope',
    });
    releaseUpdate();

    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_settings_unavailable',
    });
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey: 'account-b-scope',
      settingsVersion: 9,
    });
    expect(writeCache).not.toHaveBeenCalled();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not submit an Account Settings mutation after its active Account retires before transport', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'account-a-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
    };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    let releaseFetch!: () => void;
    const pendingFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSettings = vi.fn(async () => {
      await pendingFetch;
      return { content: { t: 'plain' as const, v: {} }, version: 3 };
    });
    const updateSettings = vi.fn(async () => ({ success: true as const, version: 4 }));
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-a',
      accountSettingsUpdateDeps: {
        fetchSettings,
        updateSettings,
        resolveAccountEncryptionMode: async () => 'plain',
        resolveCachePath: () => '/tmp/account-a-settings',
        writeCache: async () => {},
      },
    });

    const pending = persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: {},
      generation: 'generation-a',
      immutableGenerationId: 'artifact-a',
    });
    await vi.waitFor(() => expect(fetchSettings).toHaveBeenCalledOnce());
    clearActiveAccountSettingsSnapshot();
    releaseFetch();

    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toBeNull();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not submit a retired Account Settings lifetime after the same Account is reinstalled', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'account-a-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
    };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
    let releaseFetch!: () => void;
    const pendingFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSettings = vi.fn(async () => {
      await pendingFetch;
      return { content: { t: 'plain' as const, v: {} }, version: 3 };
    });
    const updateSettings = vi.fn(async () => ({ success: true as const, version: 4 }));
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-a',
      accountSettingsUpdateDeps: {
        fetchSettings,
        updateSettings,
        resolveAccountEncryptionMode: async () => 'plain',
        resolveCachePath: () => '/tmp/account-a-settings',
        writeCache: async () => {},
      },
    });

    const pending = persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: {},
      generation: 'generation-a',
      immutableGenerationId: 'artifact-a',
    });
    await vi.waitFor(() => expect(fetchSettings).toHaveBeenCalledOnce());
    clearActiveAccountSettingsSnapshot();
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ schemaVersion: 7 }),
      settingsVersion: 9,
      loadedAtMs: 200,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
    releaseFetch();

    await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey,
      settingsVersion: 9,
    });
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not cache or republish a settled write from a retired same-scope Account lifetime', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'account-a-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) },
    };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
    let releaseUpdate!: () => void;
    const updateSettings = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      return { success: true as const, version: 4 };
    });
    const writeCache = vi.fn(async () => {});
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-a',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({ content: { t: 'plain' as const, v: {} }, version: 3 }),
        updateSettings,
        resolveAccountEncryptionMode: async () => 'plain',
        resolveCachePath: () => '/tmp/account-a-settings',
        writeCache,
      },
    });

    const pending = persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: {},
      generation: 'generation-a',
      immutableGenerationId: 'artifact-a',
    });
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    clearActiveAccountSettingsSnapshot();
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({ schemaVersion: 7 }),
      settingsVersion: 9,
      loadedAtMs: 200,
      settingsSecretsReadKeys: [],
      scopeKey,
    });
    releaseUpdate();

    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_settings_unavailable',
    });
    expect(writeCache).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()).toMatchObject({
      scopeKey,
      settingsVersion: 9,
    });
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('publishes authenticated secret read keys when its Account Settings write wins startup', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(4),
      },
    };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const keySet = deriveSettingsSecretsKeySetV1({
      type: 'legacy',
      secret: credentials.encryption.secret,
    });
    const encryptedValue = encryptSecretStringV1(
      'provider-secret',
      keySet.writeKey,
      (length) => new Uint8Array(length).fill(3),
    );
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-1',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings: async () => ({ success: true, version: 4 }),
        writeCache: async () => {},
        resolveCachePath: () => '/tmp/connected-account-settings',
      },
    });

    try {
      await expect(persistence.configuration.replaceForControl!({
        target: { kind: 'service', service, modeId: 'oauth' },
        expectedRevision: null,
        values: { endpoint: 'https://api.example.test' },
        currentSecretRefs: {},
        secretValues: {},
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toMatchObject({ status: 'committed' });

      expect(decryptSecretValueWithKeysV1(
        { _isSecretValue: true, encryptedValue },
        getActiveAccountSettingsSnapshot()?.settingsSecretsReadKeys ?? [],
      )).toBe('provider-secret');
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('preserves an exhausted Account Settings CAS as a configuration-settings conflict', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(4),
      },
    };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 3,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const updateSettings = vi.fn(async () => ({
      success: false as const,
      error: 'version-mismatch' as const,
      currentVersion: 4,
      currentContent: { t: 'plain' as const, v: {} },
    }));
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      createConfigurationRevision: () => 'configuration-1',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 3 }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
        writeCache: async () => {},
        resolveCachePath: () => '/tmp/connected-account-settings',
      },
    });

    try {
      await expect(persistence.configuration.replaceForControl!({
        target: { kind: 'service', service, modeId: 'oauth' },
        expectedRevision: null,
        values: { endpoint: 'https://api.example.test' },
        currentSecretRefs: {},
        secretValues: {},
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toEqual({
        status: 'conflict',
        code: 'connected_account_configuration_settings_conflict',
      });
      expect(updateSettings).toHaveBeenCalledTimes(3);
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('reapplies a service configuration and SavedSecret delta to a CAS winner that added siblings', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(4),
      },
    };
    const winnerService = Object.freeze({
      pluginId: 'acme.accounts',
      localId: 'personal',
    });
    const winnerSecret = SavedSecretSchema.parse({
      id: 'winner-secret',
      name: 'Winner secret',
      kind: 'other',
      encryptedValue: {
        _isSecretValue: true,
        encryptedValue: encryptSecretStringV1(
          'winner-secret-value',
          deriveSettingsSecretsKeySetV1({
            type: 'legacy',
            secret: credentials.encryption.secret,
          }).writeKey,
          (length) => new Uint8Array(length).fill(6),
        ),
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const winnerSettings = {
      secrets: [winnerSecret],
      [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]: {
        v: 1,
        entries: [{
          service: winnerService,
          modeId: 'oauth',
          revision: 'winner-configuration',
          values: { endpoint: 'https://winner.example.test' },
          secretRefs: {},
        }],
      },
    };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 1,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const writes: Array<Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>> = [];
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>) => {
      writes.push(request);
      if (writes.length === 1) {
        return {
          success: false as const,
          error: 'version-mismatch' as const,
          currentVersion: 2,
          currentContent: { t: 'plain' as const, v: winnerSettings },
        };
      }
      return { success: true as const, version: 3 };
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      createConfigurationRevision: () => 'caller-configuration',
      createSecretId: () => 'caller-secret',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({ content: { t: 'plain', v: {} }, version: 1 }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
        writeCache: async () => {},
        resolveCachePath: () => '/tmp/connected-account-settings',
      },
    });

    try {
      await expect(persistence.configuration.replaceForControl!({
        target: { kind: 'service', service, modeId: 'oauth' },
        expectedRevision: null,
        values: { endpoint: 'https://caller.example.test' },
        currentSecretRefs: {},
        secretValues: { clientSecret: 'caller-secret-value' },
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toMatchObject({
        status: 'committed',
        record: {
          revision: 'caller-configuration',
          secretRefs: { clientSecret: 'caller-secret' },
        },
      });

      expect(writes).toHaveLength(2);
      const finalContent = writes[1]?.content;
      expect(finalContent?.t).toBe('plain');
      if (finalContent?.t !== 'plain') {
        throw new Error('Expected the retrying Account Settings write to remain plain');
      }
      expect(finalContent.v[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY])
        .toMatchObject({
          v: 1,
          entries: expect.arrayContaining([
            expect.objectContaining({
              service: winnerService,
              modeId: 'oauth',
              revision: 'winner-configuration',
            }),
            expect.objectContaining({
              service,
              modeId: 'oauth',
              revision: 'caller-configuration',
              secretRefs: { clientSecret: 'caller-secret' },
            }),
          ]),
        });
      expect(finalContent.v.secrets).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'winner-secret' }),
        expect.objectContaining({ id: 'caller-secret' }),
      ]));
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('retires an unreferenced generated service-configuration SavedSecret while preserving a user-authored secret', async () => {
    const generated = savedSecret('generated-old', 'Connected Account clientSecret');
    const userAuthored = savedSecret('user-authored', 'My manually saved credential');
    const harness = createServiceConfigurationPersistenceHarness({
      secrets: [generated, userAuthored],
      [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]: {
        v: 1,
        entries: [{
          service,
          modeId: 'oauth',
          revision: 'configuration-current',
          values: { endpoint: 'https://old.example.test' },
          secretRefs: { clientSecret: generated.id },
        }],
      },
    }, () => 'generated-next');

    await expect(harness.persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-current',
      values: { endpoint: 'https://new.example.test' },
      currentSecretRefs: secretReferences({ clientSecret: generated.id }),
      secretValues: { clientSecret: 'replacement-value' },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toMatchObject({
      status: 'committed',
      record: { secretRefs: { clientSecret: 'generated-next' } },
    });

    expect((harness.settings().secrets as readonly { id: string }[])
      .map((candidate) => candidate.id))
      .toEqual(['generated-next', userAuthored.id]);
  });

  it('preserves a generated service-configuration SavedSecret that remains referenced elsewhere', async () => {
    const generated = savedSecret('generated-shared', 'Connected Account clientSecret');
    const siblingService = Object.freeze({
      pluginId: 'acme.accounts',
      localId: 'personal',
    });
    const harness = createServiceConfigurationPersistenceHarness({
      secrets: [generated],
      [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]: {
        v: 1,
        entries: [{
          service,
          modeId: 'oauth',
          revision: 'configuration-current',
          values: {},
          secretRefs: { clientSecret: generated.id },
        }, {
          service: siblingService,
          modeId: 'oauth',
          revision: 'configuration-sibling',
          values: {},
          secretRefs: { clientSecret: generated.id },
        }],
      },
    }, () => 'generated-next');

    await expect(harness.persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: 'configuration-current',
      values: {},
      currentSecretRefs: secretReferences({ clientSecret: generated.id }),
      secretValues: { clientSecret: 'replacement-value' },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toMatchObject({ status: 'committed' });

    expect((harness.settings().secrets as readonly { id: string }[])
      .map((candidate) => candidate.id))
      .toEqual(['generated-next', generated.id]);
  });

  it('recomputes SavedSecret retention from the Account Settings CAS winner', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(4),
      },
    };
    const generated = savedSecret('generated-old', 'Connected Account clientSecret');
    const baseSettings = {
      secrets: [generated],
      [CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]: {
        v: 1,
        entries: [{
          service,
          modeId: 'oauth',
          revision: 'configuration-current',
          values: {},
          secretRefs: { clientSecret: generated.id },
        }],
      },
    };
    const winnerSettings = {
      ...baseSettings,
      secretBindingsByProfileId: {
        profile_a: { TOKEN: generated.id },
      },
    };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse(baseSettings),
      rawSettings: baseSettings,
      settingsVersion: 1,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    const writes: AccountSettingsStoredContentEnvelope[] = [];
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>) => {
      if (request.content) writes.push(request.content);
      if (writes.length === 1) {
        return {
          success: false as const,
          error: 'version-mismatch' as const,
          currentVersion: 2,
          currentContent: { t: 'plain' as const, v: winnerSettings },
        };
      }
      return { success: true as const, version: 3 };
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      createConfigurationRevision: () => 'configuration-next',
      createSecretId: () => 'generated-next',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({
          content: { t: 'plain' as const, v: baseSettings },
          version: 1,
        }),
        resolveAccountEncryptionMode: async () => 'plain',
        updateSettings,
        writeCache: async () => {},
        resolveCachePath: () => '/tmp/connected-account-settings',
      },
    });

    try {
      await expect(persistence.configuration.replaceForControl!({
        target: { kind: 'service', service, modeId: 'oauth' },
        expectedRevision: 'configuration-current',
        values: {},
        currentSecretRefs: secretReferences({ clientSecret: generated.id }),
        secretValues: { clientSecret: 'replacement-value' },
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toMatchObject({ status: 'committed' });

      expect(writes).toHaveLength(2);
      const settled = writes[1];
      expect(settled?.t).toBe('plain');
      if (settled?.t !== 'plain') throw new Error('Expected a plain Settings CAS winner');
      expect((settled.v.secrets as readonly { id: string }[])
        .map((candidate) => candidate.id))
        .toEqual(['generated-next', generated.id]);
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('does not create an orphan SavedSecret when service configuration CAS is stale', async () => {
    let settings: Readonly<Record<string, unknown>> = {
      secrets: [],
      connectedAccountServiceConfigurationsV1: {
        v: 1,
        entries: [{
          service,
          modeId: 'oauth',
          revision: 'configuration-current',
          values: {},
          secretRefs: {},
        }],
      },
    };
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32).fill(3),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      readAccountSettings: () => settings,
      updateAccountSettings: vi.fn(async (mutate) => {
        settings = mutate(settings);
        return settings;
      }),
      createConfigurationRevision: () => 'configuration-must-not-commit',
      createSecretId: () => 'secret-must-not-commit',
    });

    await expect(persistence.configuration.replaceForControl!({
      target: {
        kind: 'service',
        service,
        modeId: 'oauth',
      },
      expectedRevision: 'configuration-stale',
      values: {},
      currentSecretRefs: {},
      secretValues: { clientSecret: 'must-not-persist' },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toEqual({
      status: 'conflict',
      code: 'connected_account_configuration_changed',
    });
    expect(settings.secrets).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain('must-not-persist');
    expect(JSON.stringify(settings)).not.toContain('secret-must-not-commit');
  });

  it('keeps attempt secrets inline, target-bound, and inaccessible after destruction', async () => {
    const updateAccountSettings = vi.fn();
    const hasSavedSecret = vi.fn(async () => false);
    const readSavedSecret = vi.fn(async () => null);
    let revision = 0;
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32).fill(3),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: hasSavedSecret,
        read: readSavedSecret,
      },
      readAccountSettings: () => ({}),
      updateAccountSettings,
      createConfigurationRevision: () => `configuration-${++revision}`,
    });
    const target = Object.freeze({
      kind: 'attempt' as const,
      attemptId: 'attempt-1',
      service,
      modeId: 'oauth',
    });

    const committed = await persistence.configuration.replace({
      target,
      expectedRevision: null,
      replacement: {
        values: { tenant: 'acme' },
        secretRefs: {},
        secretValues: { clientSecret: 'attempt-secret' },
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    });
    expect(committed).toMatchObject({
      status: 'committed',
      record: {
        values: { tenant: 'acme' },
        secretRefs: {},
        secretValues: { clientSecret: 'attempt-secret' },
      },
    });
    if (committed.status !== 'committed') {
      throw new Error('Expected attempt configuration to commit');
    }
    await expect(persistence.configuration.read(target)).resolves.toEqual(
      committed.record,
    );
    await expect(persistence.configuration.read({
      ...target,
      service: { pluginId: 'other.accounts', localId: 'work' },
    })).resolves.toBeNull();
    await expect(persistence.configuration.read({
      ...target,
      modeId: 'device',
    })).resolves.toBeNull();
    await expect(persistence.configuration.replace({
      target: {
        ...target,
        service: { pluginId: 'other.accounts', localId: 'work' },
      },
      expectedRevision: committed.record.revision,
      replacement: {
        values: { tenant: 'other' },
        secretRefs: {},
        secretValues: { clientSecret: 'other-secret' },
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toEqual({
      status: 'conflict',
      code: 'connected_account_configuration_changed',
    });
    await expect(persistence.configuration.replace({
      target: { ...target, attemptId: 'attempt-with-reference' },
      expectedRevision: null,
      replacement: {
        values: { tenant: 'acme' },
        secretRefs: { clientSecret: 'global-secret-id' },
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_configuration_persistence_unavailable',
    });

    await persistence.configuration.destroyAttempt(target.attemptId);
    await expect(persistence.configuration.read(target)).resolves.toBeNull();
    expect(updateAccountSettings).not.toHaveBeenCalled();
    expect(hasSavedSecret).not.toHaveBeenCalled();
    expect(readSavedSecret).not.toHaveBeenCalled();
  });

  it('persists service configuration in Account Settings and bounds attempt staging to daemon lifecycle', async () => {
    let settings: Readonly<Record<string, unknown>> = {};
    const updateAccountSettings = vi.fn(async (
      mutate: (
        current: Readonly<Record<string, unknown>>,
      ) => Readonly<Record<string, unknown>>,
    ) => {
      settings = mutate(settings);
      return settings;
    });
    let revision = 0;
    let secret = 0;
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32).fill(3),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      readAccountSettings: () => settings,
      updateAccountSettings,
      createConfigurationRevision: () => `configuration-${++revision}`,
      createSecretId: () => `connected-account-secret-${++secret}`,
    });
    const serviceTarget = Object.freeze({
      kind: 'service' as const,
      service,
      modeId: 'oauth',
    });
    await expect(persistence.configuration.replaceForControl!({
      target: serviceTarget,
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: { clientSecret: 'never-return-this' },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toEqual({
      status: 'committed',
      record: {
        revision: 'configuration-1',
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {
          clientSecret: 'connected-account-secret-1',
        },
      },
    });
    await expect(persistence.configuration.read(serviceTarget)).resolves.toEqual({
      revision: 'configuration-1',
      values: { endpoint: 'https://api.example.test' },
      secretRefs: {
        clientSecret: 'connected-account-secret-1',
      },
    });
    expect(settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY]).toEqual({
      v: 1,
      entries: [{
        service,
        modeId: 'oauth',
        revision: 'configuration-1',
        values: { endpoint: 'https://api.example.test' },
        secretRefs: { clientSecret: 'connected-account-secret-1' },
      }],
    });
    // This harness replaces the Account Settings owner with an in-memory stub, so the
    // only thing it can witness is what the adapter hands that owner. A plaintext
    // Account is genuinely keyless (`docs/encryption.md`, Account-mode invariant), so
    // the adapter must pass the canonical SavedSecret input through and must not
    // fabricate Account encryption material of its own. Which persisted form the owner
    // then writes is proven against the real seam by 'writes Connected Account service
    // configuration secrets for a plaintext Account'.
    const stagedSecrets = settings.secrets as readonly Readonly<{
      id: string;
      encryptedValue: Readonly<{ value?: unknown; encryptedValue?: unknown }>;
    }>[];
    expect(stagedSecrets).toHaveLength(1);
    expect(stagedSecrets[0]).toMatchObject({
      id: 'connected-account-secret-1',
      encryptedValue: { _isSecretValue: true, value: 'never-return-this' },
    });
    expect(stagedSecrets[0]?.encryptedValue.encryptedValue).toBeUndefined();

    const attemptTarget = Object.freeze({
      kind: 'attempt' as const,
      attemptId: 'attempt-1',
      service,
      modeId: 'oauth',
    });
    await expect(persistence.configuration.replace({
      target: attemptTarget,
      expectedRevision: null,
      replacement: {
        values: { endpoint: 'https://attempt.example.test' },
        secretRefs: {},
      },
      generation: 'generation-1',
      immutableGenerationId: 'artifact-1',
    })).resolves.toMatchObject({
      status: 'committed',
      record: { revision: 'configuration-2' },
    });
    await expect(persistence.configuration.read(attemptTarget)).resolves.toMatchObject({
      revision: 'configuration-2',
    });
    await persistence.configuration.destroyAttempt('attempt-1');
    await expect(persistence.configuration.read(attemptTarget)).resolves.toBeNull();
  });

  it('keeps restart-safe OAuth state and PKCE in daemon custody and consumes completion once', async () => {
    const createPersistence = (
      attemptTransactions?: Parameters<
        typeof createQualifiedConnectedAccountDaemonPersistence
      >[0]['attemptTransactions'],
    ) => createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      callbackUrl: 'http://127.0.0.1:4000/auth/callback',
      ...(attemptTransactions ? { attemptTransactions } : {}),
    });
    const persistence = createPersistence();

    const startingSnapshot = Object.freeze({
      attemptId: 'attempt-1',
      createdAtMs: 1_000,
      intent: 'connect' as const,
      service,
      modeId: 'oauth',
      immutableGenerationId: 'artifact-acme-1',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'configuration-1',
      phase: 'starting' as const,
      stagedCredentials: Object.freeze({}),
      stagedAccountConfigurationContent: Object.freeze({
        values: Object.freeze({ tenant: 'acme' }),
        secretRefs: Object.freeze({}),
      }),
    });
    const transaction = await persistence.attempts.oauth.create({
      attemptId: 'attempt-1',
      service,
      snapshot: startingSnapshot,
    });
    expect(() => transaction.acknowledge?.({
        ...startingSnapshot,
        phase: 'awaitingOAuth',
        expectedCredentialConfigurationRevision:
          'account-configuration-drift',
      })).toThrow(
      'Connected-account OAuth transaction acknowledgement is invalid',
    );
    const awaitingSnapshot = Object.freeze({
      ...startingSnapshot,
      phase: 'awaitingOAuth' as const,
      expiresAtMs: 61_000,
    });
    await transaction.acknowledge?.(awaitingSnapshot);

    const replacementPersistence = createPersistence({
      oauth: persistence.attempts.oauth,
    });
    const restored =
      await replacementPersistence.attempts.oauth.read?.('attempt-1');
    expect(restored).not.toBeNull();
    expect(restored).not.toBeUndefined();
    if (!restored) throw new Error('Expected a restored OAuth transaction');
    expect(restored.snapshot).toEqual(awaitingSnapshot);
    expect(JSON.stringify(restored)).not.toContain('pkceVerifier');
    await expect(replacementPersistence.configuration.read({
      kind: 'attempt',
      attemptId: 'attempt-1',
      service,
      modeId: 'oauth',
    })).resolves.toEqual({
      revision: 'configuration-1',
      values: { tenant: 'acme' },
      secretRefs: {},
    });
    const completion = await restored.acceptCompletion({
      code: 'callback-code',
      callbackUrl: transaction.request.callbackUrl,
      state: transaction.request.state,
    });

    expect(completion).toMatchObject({
      code: 'callback-code',
      callbackUrl: transaction.request.callbackUrl,
      state: transaction.request.state,
      pkceVerifier: expect.any(String),
    });
    expect(completion.pkceVerifier).not.toHaveLength(0);
    expect(() => restored.acceptCompletion({
      code: 'second-code',
      callbackUrl: transaction.request.callbackUrl,
      state: transaction.request.state,
    }))
      .toThrow('does not match its transaction');
    await restored.close();
    expect(
      await replacementPersistence.attempts.oauth.read?.('attempt-1'),
    ).toBeNull();
  });

  it('composes the injected device transaction owner used across daemon recreation', async () => {
    let durableSnapshot: ConnectedAccountDeviceTransactionSnapshot | null = null;
    const device = {
      acknowledge: vi.fn(async (snapshot: ConnectedAccountDeviceTransactionSnapshot) => {
        durableSnapshot = snapshot;
      }),
      read: vi.fn(async () => durableSnapshot),
      clear: vi.fn(async () => {
        durableSnapshot = null;
      }),
    };
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      attemptTransactions: { device },
    });
    const snapshot: ConnectedAccountDeviceTransactionSnapshot = Object.freeze({
      attemptId: 'attempt-device-1',
      createdAtMs: 1_000,
      intent: 'connect',
      service,
      modeId: 'device',
      immutableGenerationId: 'artifact-acme-1',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'configuration-1',
      expiresAtMs: 61_000,
      pollIntervalMs: 5_000,
      nextPollAtMs: 6_000,
      verificationUri: 'https://provider.example/device',
      userCode: 'ABCD',
      stagedCredentials: Object.freeze({
        deviceHandle: 'provider-device-handle',
      }),
      stagedAccountConfigurationContent: Object.freeze({
        values: Object.freeze({ tenant: 'acme-device' }),
        secretRefs: Object.freeze({}),
      }),
    });

    await persistence.attempts.deviceTransactions?.acknowledge(snapshot);
    expect(
      await persistence.attempts.deviceTransactions?.read('attempt-device-1'),
    ).toEqual(snapshot);
    await expect(persistence.configuration.read({
      kind: 'attempt',
      attemptId: 'attempt-device-1',
      service,
      modeId: 'device',
    })).resolves.toEqual({
      revision: 'configuration-1',
      values: { tenant: 'acme-device' },
      secretRefs: {},
    });
    await persistence.attempts.deviceTransactions?.clear('attempt-device-1');
    expect(
      await persistence.attempts.deviceTransactions?.read('attempt-device-1'),
    ).toBeNull();
  });

  it('settles a lossless staged credential map through the qualified V4 CAS owner', async () => {
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      const mutation = input.mutation as QualifiedConnectedAccountCredentialMutationV4;
      const opened = openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        envelope: mutation.content,
      });
      expect(QualifiedConnectedAccountCredentialPayloadV1Schema.parse(opened))
        .toEqual({
          v: 1,
          values: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
          },
        });
      expect(mutation).toMatchObject({
        ref: account,
        authenticationModeId: 'oauth',
        expectedCredentialRevision: null,
        metadata: {
          providerIdentity: {
            accountId: 'provider-1',
            email: 'person@example.test',
          },
          displayName: 'Person',
          scopes: ['read', 'write'],
        },
      });
      return {
        success: true as const,
        credentialRevision: 'credential-1',
        configurationRevision: null,
      };
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: null,
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      },
      providerIdentity: {
        accountId: 'provider-1',
        email: 'person@example.test',
      },
      displayName: 'Person',
      scopes: ['read', 'write'],
    })).resolves.toEqual({
      status: 'connected',
      account,
    });
    expect(mutateCredential).toHaveBeenCalledTimes(1);
  });

  it('writes a mapped built-in V4 credential with the exact old-CLI plaintext root', async () => {
    const builtInService = Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    });
    const builtInAccount = Object.freeze({
      service: builtInService,
      accountId: 'work',
    });
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      const mutation =
        QualifiedConnectedAccountCredentialMutationV4Schema.parse(
          input.mutation,
        );
      const plaintext = openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        envelope: mutation.content,
      });
      expect(ReleasedCredentialRecordSchema.parse(plaintext))
        .toMatchObject({
          serviceId: 'openai',
          profileId: 'work',
          kind: 'token',
          token: { token: 'sk-test' },
        });
      return {
        success: true as const,
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: null,
      };
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      now: () => 1_700_000_000_000,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service: builtInService,
      accountId: builtInAccount.accountId,
      authenticationModeId: 'api-key',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { apiKey: 'sk-test' },
      displayName: 'OpenAI',
      scopes: [],
    })).resolves.toEqual({
      status: 'connected',
      account: builtInAccount,
    });
    expect(mutateCredential).toHaveBeenCalledOnce();
  });

  it.each([
    {
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      legacyServiceId: 'openai-codex',
      authenticationModeId: 'oauth',
      stagedCredentials: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        idToken: 'codex-id',
        expiresAtMs: '1700100000000',
      },
    },
    {
      service: {
        pluginId: 'happier.voice.openai',
        localId: 'openai',
      },
      legacyServiceId: 'openai',
      authenticationModeId: 'api-key',
      stagedCredentials: { apiKey: 'openai-key' },
    },
    {
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
      },
      legacyServiceId: 'anthropic',
      authenticationModeId: 'api-key',
      stagedCredentials: { token: 'anthropic-key' },
    },
    {
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      },
      legacyServiceId: 'claude-subscription',
      authenticationModeId: 'setup-token',
      stagedCredentials: { setupToken: 'claude-setup-token' },
    },
    {
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      },
      legacyServiceId: 'claude-subscription',
      authenticationModeId: 'oauth',
      stagedCredentials: {
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAtMs: '1700200000000',
      },
    },
    {
      service: {
        pluginId: 'happier.agent.gemini',
        localId: 'gemini-account',
      },
      legacyServiceId: 'gemini',
      authenticationModeId: 'api-key',
      stagedCredentials: { apiKey: 'gemini-key' },
    },
    {
      service: {
        pluginId: 'happier.scm.forge.github',
        localId: 'github-account',
      },
      legacyServiceId: 'github',
      authenticationModeId: 'fine-grained-pat',
      stagedCredentials: { token: 'github-token' },
    },
    {
      service: {
        pluginId: 'happier.scm.forge.bitbucket',
        localId: 'bitbucket-account',
      },
      legacyServiceId: 'bitbucket',
      authenticationModeId: 'manual',
      stagedCredentials: {
        identity: 'person@example.test',
        token: 'bitbucket-token',
      },
    },
  ] as const)(
    'writes $legacyServiceId/$authenticationModeId through the production V4 E2EE writer for the exact old CLI opener',
    async ({
      service: mappedService,
      legacyServiceId,
      authenticationModeId,
      stagedCredentials,
    }) => {
      const machineKey = new Uint8Array(32).fill(8);
      const mutateCredential = vi.fn(async (input: Readonly<{
        token: string;
        mutation: unknown;
      }>) => {
        const mutation =
          QualifiedConnectedAccountCredentialMutationV4Schema.parse(
            input.mutation,
          );
        if (mutation.content.t !== 'encrypted') {
          throw new Error('test expected an encrypted V4 credential envelope');
        }
        const opened = openConnectedServiceCredentialCiphertext({
          material: { type: 'dataKey', machineKey },
          ciphertext: mutation.content.c,
        });
        expect(ReleasedCredentialRecordSchema.parse(opened?.value))
          .toMatchObject({
            serviceId: legacyServiceId,
            profileId: 'work',
          });
        return {
          success: true as const,
          credentialRevision: 'csr_1234567890123456789012',
          configurationRevision: null,
        };
      });
      const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials: {
          token: 'token-1',
          encryption: {
            type: 'dataKey',
            publicKey: new Uint8Array(32).fill(7),
            machineKey,
          },
        },
        getAccountEncryptionMode:
          vi.fn(async (): Promise<'e2ee'> => 'e2ee'),
        mutateCredential,
        readCredential: vi.fn(async () => null),
        readConfiguration: vi.fn(async () => null),
        mutateConfiguration: vi.fn(),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
        now: () => 1_700_000_000_000,
        randomBytes: (length) => new Uint8Array(length).fill(7),
      });

      await expect(persistence.attempts.settlement.settle({
        intent: 'connect',
        service: mappedService,
        accountId: 'work',
        authenticationModeId,
        expectedCredentialRevision: null,
        expectedCredentialConfigurationRevision: null,
        expectedConfigurationRevision: 'unconfigured',
        generation: 'generation-1',
        stagedCredentials: retainStringValues(stagedCredentials),
        displayName: legacyServiceId,
        scopes: ['read', 'write'],
      })).resolves.toEqual({
        status: 'connected',
        account: {
          service: mappedService,
          accountId: 'work',
        },
      });
      expect(mutateCredential).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    'account-configuration-7',
  ] as const)(
    'settles reconnect with the captured account-configuration revision %s instead of the admitted service revision',
    async (configurationRevision) => {
      const credentialRevision = 'csr_1234567890123456789012';
      const readCredential = vi.fn(async () => null);
      const mutateCredential = vi.fn(async (input: Readonly<{
        token: string;
        mutation: unknown;
      }>) => {
        expect(
          QualifiedConnectedAccountCredentialMutationV4Schema.parse(
            input.mutation,
          ),
        ).toMatchObject({
          ref: account,
          authenticationModeId: 'manual',
          expectedCredentialRevision: credentialRevision,
          expectedConfigurationRevision: configurationRevision,
        });
        return {
          success: true as const,
          credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
          configurationRevision,
        };
      });
      const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials: {
          token: 'token-1',
          encryption: {
            type: 'dataKey',
            publicKey: new Uint8Array(32),
            machineKey: new Uint8Array(32),
          },
        },
        getAccountEncryptionMode:
          vi.fn(async (): Promise<'plain'> => 'plain'),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        mutateCredential,
        mutateConfiguration: vi.fn(),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      });

      await expect(persistence.attempts.settlement.settle({
        intent: 'reconnect',
        service,
        accountId: account.accountId,
        authenticationModeId: 'manual',
        expectedCredentialRevision: credentialRevision,
        expectedCredentialConfigurationRevision: configurationRevision,
        expectedConfigurationRevision: 'admitted-service-configuration',
        generation: 'generation-1',
        stagedCredentials: { token: 'new-token' },
        providerIdentity: { accountId: 'provider-account-1' },
        displayName: 'Person',
        scopes: ['read'],
      })).resolves.toEqual({
        status: 'connected',
        account,
      });
      expect(readCredential).not.toHaveBeenCalled();
      expect(mutateCredential).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed when first-connect configuration settlement does not return an atomic configuration revision', async () => {
    const updateAccountSettings = vi.fn();
    const mutateConfiguration = vi.fn();
    const mutateCredential = vi.fn(async () => ({
      success: true as const,
      credentialRevision: 'csr_1234567890123456789012',
      configurationRevision: null,
    }));
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential,
      mutateConfiguration,
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      readAccountSettings: () => ({}),
      updateAccountSettings,
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'configuration-1',
      generation: 'generation-1',
      stagedCredentials: { accessToken: 'access-1' },
      stagedAccountConfigurationContent: {
        values: { tenant: 'acme' },
        secretRefs: {},
        secretValues: { clientSecret: 'attempt-secret' },
      },
      displayName: 'Person',
      scopes: [],
    })).rejects.toThrow(
      'Qualified Connected Account settlement did not commit the exact configuration basis',
    );
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(mutateConfiguration).not.toHaveBeenCalled();
    expect(updateAccountSettings).not.toHaveBeenCalled();
  });

  it('returns a stale settlement conflict without a configuration or Account Settings side effect', async () => {
    const updateAccountSettings = vi.fn();
    const mutateConfiguration = vi.fn();
    const mutateCredential = vi.fn(async () => {
      const conflict = new Error('stale credential');
      Object.assign(conflict, { response: { status: 409 } });
      throw conflict;
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential,
      mutateConfiguration,
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      readAccountSettings: () => ({}),
      updateAccountSettings,
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { accessToken: 'access-1' },
      displayName: 'Person',
      scopes: [],
    })).resolves.toEqual({
      status: 'conflict',
      code: 'connected_account_settlement_conflict',
    });
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(mutateConfiguration).not.toHaveBeenCalled();
    expect(updateAccountSettings).not.toHaveBeenCalled();
  });

  it('preserves the server-named credential refusal instead of one settlement conflict', async () => {
    // Identity and authentication-mode mismatch are not CAS races: the caller
    // must be able to tell them apart from a stale write.
    for (const [serverCode, expected] of [
      [
        'connect_reconnect_provider_identity_mismatch',
        { status: 'conflict', code: 'connected_account_reconnect_provider_identity_mismatch' },
      ],
      [
        'connect_authentication_mode_mismatch',
        { status: 'conflict', code: 'connected_account_authentication_mode_mismatch' },
      ],
    ] as const) {
      const updateAccountSettings = vi.fn();
      const mutateConfiguration = vi.fn();
      const readCredential = vi.fn(async () => null);
      const mutateCredential = vi.fn(async () => {
        throw new QualifiedConnectedAccountCredentialConflictError(serverCode);
      });
      const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials: {
          token: 'token-1',
          encryption: {
            type: 'dataKey',
            publicKey: new Uint8Array(32),
            machineKey: new Uint8Array(32),
          },
        },
        getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        mutateCredential,
        mutateConfiguration,
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
        readAccountSettings: () => ({}),
        updateAccountSettings,
      });

      await expect(persistence.attempts.settlement.settle({
        intent: 'connect',
        service,
        accountId: account.accountId,
        authenticationModeId: 'oauth',
        expectedCredentialRevision: null,
        expectedCredentialConfigurationRevision: null,
        expectedConfigurationRevision: 'unconfigured',
        generation: 'generation-1',
        stagedCredentials: { accessToken: 'access-1' },
        displayName: 'Person',
        scopes: [],
      })).resolves.toEqual(expected);
      expect(mutateCredential).toHaveBeenCalledOnce();
      // A named refusal is terminal: no read-back reconciliation, no
      // configuration write and no Account Settings effect.
      expect(readCredential).not.toHaveBeenCalled();
      expect(mutateConfiguration).not.toHaveBeenCalled();
      expect(updateAccountSettings).not.toHaveBeenCalled();
    }
  });

  it('rejects reconnect staging and account SavedSecret references before any credential effect', async () => {
    const mutateCredential = vi.fn();
    const updateAccountSettings = vi.fn();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential,
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      readAccountSettings: () => ({}),
      updateAccountSettings,
    });
    const common = {
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'configuration-1',
      generation: 'generation-1',
      stagedCredentials: { accessToken: 'access-1' },
      displayName: 'Person',
      scopes: [],
    } as const;

    await expect(persistence.attempts.settlement.settle({
      ...common,
      intent: 'reconnect',
      expectedCredentialRevision: 'csr_1234567890123456789012',
      stagedAccountConfigurationContent: {
        values: { tenant: 'acme' },
        secretRefs: {},
        secretValues: { clientSecret: 'attempt-secret' },
      },
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_settlement_configuration_invalid',
    });
    await expect(persistence.attempts.settlement.settle({
      ...common,
      intent: 'connect',
      expectedCredentialRevision: null,
      stagedAccountConfigurationContent: {
        values: { tenant: 'acme' },
        secretRefs: { clientSecret: 'global-secret-id' },
      },
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'connected_account_settlement_configuration_invalid',
    });
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(updateAccountSettings).not.toHaveBeenCalled();
  });

  it('reconciles a lost settlement acknowledgement from the exact committed credential and initial configuration', async () => {
    const readCredential = vi.fn(async () =>
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: 'configuration-1',
        content: {
          t: 'plain',
          v: {
            v: 1,
            values: {
              accessToken: 'access-1',
              refreshToken: 'refresh-1',
            },
          },
        },
        metadata: { displayName: 'Person', scopes: ['read'] },
      }));
    const readConfiguration = vi.fn(async () =>
      QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
        target: { kind: 'account', ref: account },
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: 'configuration-1',
        configurationContent: {
          t: 'plain',
          v: {
            values: { endpoint: 'https://api.example.test' },
            secretRefs: {},
          },
        },
      }));
    const mutateCredential = vi.fn(async () => {
      throw new Error('acknowledgement lost after commit');
    });
    const updateAccountSettings = vi.fn();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration,
      mutateCredential,
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      readAccountSettings: () => ({}),
      updateAccountSettings,
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
      },
      stagedAccountConfigurationContent: {
        values: { endpoint: 'https://api.example.test' },
        secretRefs: {},
      },
      displayName: 'Person',
      scopes: ['read'],
    })).resolves.toEqual({
      status: 'connected',
      account,
    });
    expect(mutateCredential).toHaveBeenCalledTimes(1);
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(readConfiguration).toHaveBeenCalledTimes(1);
    expect(updateAccountSettings).not.toHaveBeenCalled();
  });

  it('reconciles an outcome-unknown retry conflict from the exact committed reconnect row', async () => {
    const oldCredential =
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0000000000000000000000',
        configurationRevision: null,
        content: {
          t: 'plain',
          v: { v: 1, values: { accessToken: 'old-access' } },
        },
        metadata: { scopes: [] },
      });
    const committedCredential =
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: null,
        content: {
          t: 'plain',
          v: { v: 1, values: { accessToken: 'access-1' } },
        },
        metadata: { displayName: 'Person', scopes: [] },
      });
    const readCredential = vi.fn()
      .mockResolvedValueOnce(oldCredential)
      .mockResolvedValueOnce(committedCredential);
    const lostAcknowledgement =
      new Error('acknowledgement and first proof read lost');
    const staleRetry = Object.assign(
      new Error('the exact retry observed the committed revision'),
      { response: { status: 409 } },
    );
    const mutateCredential = vi.fn()
      .mockRejectedValueOnce(lostAcknowledgement)
      .mockRejectedValueOnce(staleRetry);
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential,
      readConfiguration: vi.fn(async () => null),
      mutateCredential,
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });
    const request = {
      intent: 'reconnect' as const,
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: oldCredential.credentialRevision,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { accessToken: 'access-1' },
      displayName: 'Person',
      scopes: [],
    };

    await expect(
      persistence.attempts.settlement.settle(request),
    ).rejects.toThrow(lostAcknowledgement);
    expect(persistence.attempts.settlement.reconcile).toBeTypeOf('function');
    await expect(
      persistence.attempts.settlement.reconcile!(request),
    ).resolves.toEqual({
      status: 'connected',
      account,
    });
    expect(mutateCredential).toHaveBeenCalledTimes(2);
    expect(readCredential).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      divergentBasis: 'prepared metadata',
      metadata: { displayName: 'Someone else', scopes: [] },
      configurationRevision: 'configuration-1',
    },
    {
      divergentBasis: 'non-staged configuration revision',
      metadata: { displayName: 'Person', scopes: [] },
      configurationRevision: 'configuration-2',
    },
  ])(
    'rejects an outcome-unknown retry when the committed $divergentBasis differs',
    async ({ metadata, configurationRevision }) => {
      const committedCredential =
        QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: account,
          authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned',
          credentialRevision: 'csr_1234567890123456789012',
          configurationRevision,
          content: {
            t: 'plain',
            v: { v: 1, values: { accessToken: 'access-1' } },
          },
          metadata,
        });
      const readCredential = vi.fn(async () => committedCredential);
      const mutateCredential = vi.fn(async () => {
        throw Object.assign(
          new Error('the exact retry observed a committed revision'),
          { response: { status: 409 } },
        );
      });
      const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials: {
          token: 'token-1',
          encryption: {
            type: 'dataKey',
            publicKey: new Uint8Array(32),
            machineKey: new Uint8Array(32),
          },
        },
        getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        mutateCredential,
        mutateConfiguration: vi.fn(),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      });

      await expect(persistence.attempts.settlement.reconcile!({
        intent: 'reconnect',
        service,
        accountId: account.accountId,
        authenticationModeId: 'oauth',
        expectedCredentialRevision: 'csr_0000000000000000000000',
        expectedCredentialConfigurationRevision: 'configuration-1',
        expectedConfigurationRevision: 'configuration-1',
        generation: 'generation-1',
        stagedCredentials: { accessToken: 'access-1' },
        displayName: 'Person',
        scopes: [],
      })).resolves.toEqual({
        status: 'conflict',
        code: 'connected_account_settlement_conflict',
      });
      expect(mutateCredential).toHaveBeenCalledTimes(1);
      expect(readCredential).toHaveBeenCalledTimes(1);
    },
  );

  it('retains an unknown settlement outcome when the reread cannot prove the staged bytes', async () => {
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(async () => {
        throw new Error('acknowledgement lost with no committed proof');
      }),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service,
      accountId: account.accountId,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { accessToken: 'access-1' },
      displayName: 'Person',
      scopes: [],
    })).rejects.toThrow('acknowledgement lost with no committed proof');
  });

  it('reads exact qualified account and account-configuration revisions', async () => {
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'manual',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: 'configuration-7',
        content: { t: 'plain', v: { v: 1, values: { token: 'secret' } } },
        metadata: { scopes: [] },
      })),
      readConfiguration: vi.fn(async () => QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
        target: { kind: 'account', ref: account },
        authenticationModeId: 'manual',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012',
        configurationRevision: 'configuration-7',
        configurationContent: {
          t: 'plain',
          v: {
            values: { endpoint: 'https://api.example.test' },
            secretRefs: {},
          },
        },
      })),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(persistence.attempts.accounts.readExact(account)).resolves.toEqual({
      account,
      authenticationModeId: 'manual',
      credentialRevision: 'csr_1234567890123456789012',
      configurationRevision: 'configuration-7',
    });
    await expect(persistence.configuration.read({
      kind: 'account',
      account,
      modeId: 'manual',
    })).resolves.toEqual({
      revision: 'configuration-7',
      values: { endpoint: 'https://api.example.test' },
      secretRefs: {},
    });
  });

  it('rejects an unfenced credential snapshot at the qualified attempt boundary', async () => {
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'manual',
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        configurationRevision: null,
        content: { t: 'plain', v: { v: 1, values: { token: 'secret' } } },
        metadata: { scopes: [] },
      })),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(persistence.attempts.accounts.readExact(account)).resolves.toBeNull();
  });

  it.each(['plain', 'e2ee'] as const)(
    'stores %s account secrets only inside the exact opaque configuration row and rejects invalid storage shapes',
    async (accountMode) => {
      const material = {
        type: 'dataKey' as const,
        machineKey: new Uint8Array(32).fill(5),
      };
      const credentials = {
        token: 'token-1',
        encryption: {
          type: 'dataKey' as const,
          publicKey: new Uint8Array(32),
          machineKey: material.machineKey,
        },
      };
      const credentialRevision = 'csr_1234567890123456789012';
      const credentialContent =
        accountMode === 'plain'
          ? sealQualifiedConnectedAccountContentEnvelope({
              kind: 'credential',
              accountMode: 'plain',
              payload: { v: 1, values: { accessToken: 'credential-secret' } },
              randomBytes: (length) => new Uint8Array(length).fill(7),
            })
          : sealQualifiedConnectedAccountContentEnvelope({
              kind: 'credential',
              accountMode: 'e2ee',
              material,
              payload: { v: 1, values: { accessToken: 'credential-secret' } },
              randomBytes: (length) => new Uint8Array(length).fill(7),
            });
      let storedConfigurationContent:
        ReturnType<
          typeof QualifiedConnectedAccountConfigurationPatchV4Schema.parse
        >['replacementContentEnvelope']
        | null = null;
      const mutateConfiguration = vi.fn(async (input: Readonly<{
        token: string;
        patch: unknown;
      }>) => {
        const patch =
          QualifiedConnectedAccountConfigurationPatchV4Schema.parse(input.patch);
        storedConfigurationContent = patch.replacementContentEnvelope;
        return {
          success: true as const,
          credentialRevision,
          configurationRevision: 'configuration-1',
        };
      });
      const readCredential = vi.fn(async () =>
        QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ref: account,
          authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned',
          credentialRevision,
          configurationRevision:
            storedConfigurationContent ? 'configuration-1' : null,
          content: credentialContent,
          metadata: { scopes: [] },
        }));
      const readConfiguration = vi.fn(async () => {
        if (!storedConfigurationContent) return null;
        return QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
          target: { kind: 'account', ref: account },
          authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned',
          credentialRevision,
          configurationRevision: 'configuration-1',
          configurationContent: storedConfigurationContent,
        });
      });
      const updateAccountSettings = vi.fn();
      const hasSavedSecret = vi.fn(async () => false);
      const readSavedSecret = vi.fn(async () => null);
      const persistence = createQualifiedConnectedAccountDaemonPersistence({
        credentials,
        getAccountEncryptionMode:
          vi.fn(async (): Promise<typeof accountMode> => accountMode),
        readCredential,
        readConfiguration,
        mutateCredential: vi.fn(),
        mutateConfiguration,
        secrets: {
          has: hasSavedSecret,
          read: readSavedSecret,
        },
        randomBytes: (length) => new Uint8Array(length).fill(7),
        readAccountSettings: () => ({}),
        updateAccountSettings,
      });
      const target = Object.freeze({
        kind: 'account' as const,
        account,
        modeId: 'oauth',
      });
      const replacement = Object.freeze({
        values: { tenant: 'acme' },
        secretRefs: {},
        secretValues: { clientSecret: 'account-secret' },
      });

      await expect(persistence.configuration.replace({
        target,
        expectedRevision: null,
        replacement,
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toEqual({
        status: 'committed',
        record: {
          revision: 'configuration-1',
          ...replacement,
        },
      });
      expect(mutateConfiguration).toHaveBeenCalledOnce();
      const storedPatch =
        QualifiedConnectedAccountConfigurationPatchV4Schema.parse(
          mutateConfiguration.mock.calls[0]![0].patch,
        );
      expect(storedPatch.replacementContentEnvelope.t).toBe(
        accountMode === 'plain' ? 'plain' : 'encrypted',
      );
      await expect(persistence.configuration.read(target)).resolves.toEqual({
        revision: 'configuration-1',
        ...replacement,
      });
      await expect(persistence.configuration.read({
        ...target,
        modeId: 'manual',
      })).resolves.toBeNull();
      expect(updateAccountSettings).not.toHaveBeenCalled();
      expect(hasSavedSecret).not.toHaveBeenCalled();
      expect(readSavedSecret).not.toHaveBeenCalled();

      storedConfigurationContent =
        accountMode === 'plain'
          ? sealQualifiedConnectedAccountContentEnvelope({
              kind: 'configuration',
              accountMode: 'plain',
              payload: {
                values: { tenant: 'acme' },
                secretRefs: { clientSecret: 'global-secret-id' },
              },
              randomBytes: (length) => new Uint8Array(length).fill(8),
            })
          : sealQualifiedConnectedAccountContentEnvelope({
              kind: 'configuration',
              accountMode: 'e2ee',
              material,
              payload: {
                values: { tenant: 'acme' },
                secretRefs: { clientSecret: 'global-secret-id' },
              },
              randomBytes: (length) => new Uint8Array(length).fill(8),
            });
      await expect(persistence.configuration.read(target)).rejects.toThrow(
        'Connected-account account and attempt configuration cannot contain SavedSecret references',
      );

      storedConfigurationContent =
        accountMode === 'plain'
          ? sealQualifiedConnectedAccountContentEnvelope({
              kind: 'configuration',
              accountMode: 'e2ee',
              material,
              payload: replacement,
              randomBytes: (length) => new Uint8Array(length).fill(9),
            })
          : sealQualifiedConnectedAccountContentEnvelope({
              kind: 'configuration',
              accountMode: 'plain',
              payload: replacement,
              randomBytes: (length) => new Uint8Array(length).fill(9),
            });
      await expect(persistence.configuration.read(target)).resolves.toBeNull();

      await expect(persistence.configuration.replace({
        target,
        expectedRevision: 'configuration-1',
        replacement: {
          values: { tenant: 'acme' },
          secretRefs: { clientSecret: 'global-secret-id' },
        },
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
      })).resolves.toEqual({
        status: 'unavailable',
        code: 'connected_account_configuration_persistence_unavailable',
      });
      expect(mutateConfiguration).toHaveBeenCalledOnce();
      expect(updateAccountSettings).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      legacyServiceId: 'openai' as const,
      service: {
        pluginId: 'happier.voice.openai',
        localId: 'openai',
      },
      authenticationModeId: 'api-key',
      stagedCredentials: { apiKey: 'sk-test' },
    },
    {
      legacyServiceId: 'github' as const,
      service: {
        pluginId: 'happier.scm.forge.github',
        localId: 'github-account',
      },
      authenticationModeId: 'fine-grained-pat',
      stagedCredentials: { token: 'github-token' },
    },
  ])(
    'settles unconfigured $legacyServiceId through its revisioned V2/V3 owner when V4 is absent',
    async ({
      legacyServiceId,
      service: builtInService,
      authenticationModeId,
      stagedCredentials,
    }) => {
    const oldPeerFeatures = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
          publisherAuthority: { protocolVersion: 1 },
        },
      },
    });
    const registerPlain = vi.fn(async (input: Readonly<{
      content: unknown;
    }>) => {
      const content = z.object({
        t: z.literal('plain'),
        v: z.unknown(),
      }).parse(input.content);
      expect(ReleasedCredentialRecordSchema.parse(content.v)).toMatchObject({
        serviceId: legacyServiceId,
        profileId: 'work',
        kind: 'token',
      });
      return {
        success: true as const,
        credentialRevision: 'csr_1234567890123456789012',
      };
    });
    const mutateCredential = vi.fn();
    const legacyCredentialApi = {
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      getServerFeaturesSnapshot:
        vi.fn(async () => ({
          status: 'ready' as const,
          features: oldPeerFeatures,
        })),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceCredentialPlain: registerPlain,
      registerConnectedServiceCredentialSealed: vi.fn(),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: legacyServiceId,
        profiles: [],
      })),
    };
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: oldPeerFeatures,
      }),
      legacyCredentialApi,
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service: builtInService,
      accountId: 'work',
      authenticationModeId,
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: retainStringValues(stagedCredentials),
      displayName: legacyServiceId,
      scopes: [],
    })).resolves.toEqual({
      status: 'connected',
      account: {
        service: builtInService,
        accountId: 'work',
      },
    });
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(registerPlain).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: legacyServiceId,
      profileId: 'work',
      expectedCredentialRevision: null,
      content: {
        t: 'plain',
        v: expect.objectContaining({
          serviceId: legacyServiceId,
          profileId: 'work',
          kind: 'token',
          token: expect.objectContaining({
            token: legacyServiceId === 'github'
              ? 'github-token'
              : 'sk-test',
          }),
        }),
      },
    }));
    },
  );

  it('reconciles a revisioned V2/V3 ambiguous settlement without repeating its credential write', async () => {
    const revisionedFeatures = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
      },
    });
    let committedRecord:
      ReturnType<typeof ConnectedServiceCredentialRecordV1Schema.parse>
      | null = null;
    let credentialRead = 0;
    const getConnectedServiceCredentialPlain = vi.fn(async () => {
      credentialRead += 1;
      if (credentialRead <= 2) return null;
      if (credentialRead === 3) {
        throw new Error('the first exact proof read was unavailable');
      }
      if (!committedRecord) {
        throw new Error('expected the attempted credential write');
      }
      return {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_1234567890123456789012',
        content: {
          t: 'plain' as const,
          v: committedRecord,
        },
      };
    });
    const lostAcknowledgement =
      new Error('revisioned credential acknowledgement lost');
    const registerConnectedServiceCredentialPlain = vi.fn(async (
      input: Readonly<{ content: unknown }>,
    ) => {
      const content = z.object({
        t: z.literal('plain'),
        v: ConnectedServiceCredentialRecordV1Schema,
      }).parse(input.content);
      committedRecord = content.v;
      throw lostAcknowledgement;
    });
    const legacyCredentialApi = {
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      getServerFeaturesSnapshot:
        vi.fn(async () => ({
          status: 'ready' as const,
          features: revisionedFeatures,
        })),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceCredentialPlain,
      registerConnectedServiceCredentialSealed: vi.fn(),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai' as const,
        profiles: [],
      })),
    };
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: revisionedFeatures,
      }),
      legacyCredentialApi,
      mutateCredential: vi.fn(),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });
    const builtInService = Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    });
    const request = {
      intent: 'connect' as const,
      service: builtInService,
      accountId: 'work',
      authenticationModeId: 'api-key',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { apiKey: 'sk-test' },
      displayName: 'OpenAI',
      scopes: [],
    };

    await expect(
      persistence.attempts.settlement.settle(request),
    ).rejects.toThrow(lostAcknowledgement);
    await expect(
      persistence.attempts.settlement.reconcile!(request),
    ).resolves.toEqual({
      status: 'connected',
      account: {
        service: builtInService,
        accountId: 'work',
      },
    });
    expect(registerConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(4);
  });

  it('rejects configured revisioned authentication before provider or credential effects', () => {
    const revisionedFeatures = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
          publisherAuthority: { protocolVersion: 1 },
        },
      },
    });
    const mutateCredential = vi.fn();
    const readCredential = vi.fn(async () => null);
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: revisionedFeatures,
      }),
      mutateCredential,
      readCredential,
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });
    const builtInService = Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    });

    expect(() => persistence.attempts
      .assertAuthenticationActionAllowed?.({
        intent: 'connect',
        service: builtInService,
      })).not.toThrow();
    expect(() => persistence.attempts
      .assertAuthenticationActionAllowed?.({
        intent: 'connect',
        service: builtInService,
        configurationState: 'configured',
      })).toThrow(expect.objectContaining({
      code: 'connected_account_legacy_operation_unsupported',
    }));
    expect(() => persistence.attempts
      .assertAuthenticationActionAllowed?.({
        intent: 'connect',
        service: builtInService,
        authenticationModeId: 'service-account',
        configurationState: 'unconfigured',
        authenticationModeCardinality: 'single',
      })).toThrow(expect.objectContaining({
        code: 'connected_account_legacy_operation_unsupported',
      }));
    expect(readCredential).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
  });

  it('rejects multi-mode revisioned authentication during begin preflight', () => {
    const revisionedFeatures = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
          publisherAuthority: { protocolVersion: 1 },
        },
      },
    });
    const mutateCredential = vi.fn();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: revisionedFeatures,
      }),
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    expect(() => persistence.attempts
      .assertAuthenticationActionAllowed?.({
        intent: 'connect',
        service: {
          pluginId: 'happier.agent.gemini',
          localId: 'gemini-account',
        },
      })).toThrow(expect.objectContaining({
        code: 'connected_account_legacy_operation_unsupported',
      }));
    expect(mutateCredential).not.toHaveBeenCalled();
  });

  it('rejects exact-old connect settlement before any credential read or mutation effect', async () => {
    const exactOldFeatures = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
        },
      },
      capabilities: {},
    });
    const readPlain = vi.fn(async () => null);
    const registerPlain = vi.fn();
    const mutateCredential = vi.fn();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: exactOldFeatures,
      }),
      resolveSessionSyncPendingInputServerContractResult: () => ({
        mode: 'released_server_v0_2_1',
        runtimeActivity: 'legacy',
        pendingInput: 'released_server_v0_2_1',
        publisherAuthority: 'indeterminate',
        sessionConnectionEpoch: 4,
        socket: { connected: true },
      }),
      legacyCredentialApi: {
        getAccountEncryptionMode:
          vi.fn(async (): Promise<'plain'> => 'plain'),
        getServerFeaturesSnapshot:
          vi.fn(async () => ({
            status: 'ready' as const,
            features: exactOldFeatures,
          })),
        getConnectedServiceCredentialPlain: readPlain,
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
        registerConnectedServiceCredentialPlain: registerPlain,
        registerConnectedServiceCredentialSealed: vi.fn(),
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai' as const,
          profiles: [],
        })),
      },
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });
    const builtInService = Object.freeze({
      pluginId: 'happier.voice.openai',
      localId: 'openai',
    });

    expect(() => persistence.attempts
      .assertAuthenticationActionAllowed?.({
        intent: 'connect',
        service: builtInService,
      })).toThrow(expect.objectContaining({
        code: 'connected_account_legacy_operation_unsupported',
      }));
    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service: builtInService,
      accountId: 'work',
      authenticationModeId: 'api-key',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { apiKey: 'sk-test' },
      displayName: 'OpenAI',
      scopes: [],
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(readPlain).not.toHaveBeenCalled();
    expect(registerPlain).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
  });

  it('rejects a multi-mode built-in before either credential transport on an old peer', async () => {
    const revisionedFeatures = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
      },
    });
    const mutateCredential = vi.fn();
    const registerPlain = vi.fn();
    const readPlain = vi.fn(async () => null);
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token-1',
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(32),
          machineKey: new Uint8Array(32),
        },
      },
      getAccountEncryptionMode:
        vi.fn(async (): Promise<'plain'> => 'plain'),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: revisionedFeatures,
      }),
      legacyCredentialApi: {
        getAccountEncryptionMode:
          vi.fn(async (): Promise<'plain'> => 'plain'),
        getServerFeaturesSnapshot:
          vi.fn(async () => ({
            status: 'ready' as const,
            features: revisionedFeatures,
          })),
        getConnectedServiceCredentialPlain: readPlain,
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
        registerConnectedServiceCredentialPlain: registerPlain,
        registerConnectedServiceCredentialSealed: vi.fn(),
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'claude-subscription' as const,
          profiles: [],
        })),
      },
      mutateCredential,
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(persistence.attempts.settlement.settle({
      intent: 'connect',
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      },
      accountId: 'work',
      authenticationModeId: 'setup-token',
      expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null,
      expectedConfigurationRevision: 'unconfigured',
      generation: 'generation-1',
      stagedCredentials: { setupToken: 'setup-token' },
      displayName: 'Claude',
      scopes: [],
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(readPlain).not.toHaveBeenCalled();
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it('writes Connected Account service configuration secrets for a plaintext Account', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    // A plaintext Account correctly holds no client Account data-encryption material.
    // The adapter must hand the raw secret to the canonical Account Settings owner and let
    // that owner apply the Account's actual encryption mode.
    // A plaintext Account's stored credential genuinely carries no Account
    // data-encryption material; `encryption: null` is that fact, not a stub.
    const credentials = { token: 'plain-account-token', encryption: null };
    commitActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      rawSettings: {},
      settingsVersion: 1,
      loadedAtMs: 100,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials),
    });
    let submittedContent: AccountSettingsStoredContentEnvelope | null | undefined;
    const updateSettings = vi.fn(async (request: Readonly<{
      expectedVersion: number;
      content: AccountSettingsStoredContentEnvelope | null;
    }>) => {
      submittedContent = request.content;
      return { success: true as const, version: 2 };
    });
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials,
      getAccountEncryptionMode: vi.fn(async (): Promise<'plain'> => 'plain'),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      createConfigurationRevision: () => 'configuration-plain',
      createSecretId: () => 'secret-plain-1',
      accountSettingsUpdateDeps: {
        fetchSettings: async () => ({ content: { t: 'plain' as const, v: {} }, version: 1 }),
        updateSettings,
        resolveAccountEncryptionMode: async () => 'plain',
        resolveCachePath: () => '/tmp/plain-account-settings',
        writeCache: async () => {},
      },
    });

    const result = await persistence.configuration.replaceForControl!({
      target: { kind: 'service', service, modeId: 'oauth' },
      expectedRevision: null,
      values: { endpoint: 'https://api.example.test' },
      currentSecretRefs: {},
      secretValues: { clientSecret: 'plain-client-secret' },
      generation: 'generation-plain',
      immutableGenerationId: 'artifact-plain',
    });

    expect(result).toMatchObject({
      status: 'committed',
      record: {
        revision: 'configuration-plain',
        secretRefs: { clientSecret: 'secret-plain-1' },
      },
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(submittedContent?.t).toBe('plain');
    const persisted = submittedContent?.t === 'plain'
      ? submittedContent.v as Readonly<{ secrets?: readonly Readonly<{
        id: string;
        encryptedValue: Readonly<{ value?: string; encryptedValue?: unknown }>;
      }>[] }>
      : null;
    const written = persisted?.secrets?.find((entry) => entry.id === 'secret-plain-1');
    expect(written?.encryptedValue.value).toBe('plain-client-secret');
    expect(written?.encryptedValue.encryptedValue).toBeUndefined();
    resetActiveAccountSettingsSnapshotForTests();
  });
});
