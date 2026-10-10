import { describe, expect, it } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol/connect/build-connected-service-credential-record';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { deriveSettingsSecretsKeyV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { openConnectedServiceCredentialCiphertext, sealConnectedServiceCredentialCiphertext } from '@happier-dev/protocol/connect/connectedServiceCipher';
import { SessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { loadProfileCatalogV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { sealProfileTransferContentV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { connectedAccountCatalogCipherKindV1, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

import { buildAccountEncryptionMigrateToPlainRequest } from './buildAccountEncryptionMigrateToPlainRequest';

const EMPTY_STORAGE_DIRECTIVES = {
  machines: { action: 'assert_empty' as const },
  todos: { action: 'assert_empty' as const },
  artifacts: { action: 'assert_empty' as const },
  sessions: { action: 'assert_empty' as const },
  reviewComments: { action: 'assert_empty' as const },
  sessionOrganization: { action: 'assert_empty' as const },
  pets: { action: 'assert_empty' as const },
};
const CREDENTIAL_REVISION =
  'csr_0123456789ABCDEFGHJKMNPQRS';
const CURRENTNESS = {
  expectedAccountVersion: 4,
  expectedSigningKeyFingerprint: 'aemk1_signing',
  expectedContentKeyFingerprint: 'aemk1_content',
} as const;
const D10_CATALOGS = [
  { field: 'remoteHosts', kind: 'account_remote_host_catalog', record: { v: 1, hosts: [{
    id: 'host-a', name: 'Work', ssh: { target: 'user@work.test', authMode: 'agent' },
    createdAt: 1, updatedAt: 2, lastUsedAt: null,
  }] }, open: openRemoteHostCatalogContentV1, collection: 'hosts' },
  { field: 'notificationChannels', kind: 'account_notification_channels', record: { v: 1, channels: [{
    v: 1, id: 'channel-a', kind: 'webhook', enabled: true, url: 'https://hooks.example.test', signingSecretRef: null,
    topics: { ready: true, permissionRequest: false, userActionRequest: true, connectedServiceAccountSwitch: false,
      connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: true, connectedServiceUsage: false },
    readyIncludeMessageText: false, requestIncludeMessageText: false,
  }] }, open: openNotificationChannelCatalogContentV1, collection: 'channels' },
  { field: 'connectedPresentation', kind: 'account_connected_presentation_catalog', record: { v: 1, entries: [{
    v: 1, subject: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      accountId: 'default' } }, label: 'Work',
  }] }, open: openConnectedPresentationContentV1, collection: 'entries' },
  { field: 'connectedAcknowledgements', kind: 'account_connected_acknowledgement_catalog', record: { v: 1, entries: [{
    v: 1, subject: { kind: 'warning', warningId: 'installation', scope: { kind: 'machine', machineId: 'exact-machine' } },
    acknowledged: false,
  }] }, open: openConnectedAcknowledgementsContentV1, collection: 'entries' },
] as const;
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { settingsParse } from '@/sync/domains/settings/settings';

function createLegacyCredentials(): Extract<AuthCredentials, { secret: string }> {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url'),
  };
}

function createSettingsWithSavedSecret(encryptedValue: unknown) {
  return {
    schemaVersion: 7,
    secrets: [{
      id: 'sec1',
      name: 'Nested Saved Secret',
      kind: 'apiKey',
      encryptedValue: {
        _isSecretValue: true,
        encryptedValue,
      },
      createdAt: 1,
      updatedAt: 1,
    }],
  } as any;
}

async function buildPlainRequestWithSettings(
  credentials: AuthCredentials,
  settings: any,
) {
  return await buildAccountEncryptionMigrateToPlainRequest({
    storageDirectives: EMPTY_STORAGE_DIRECTIVES,
    ...CURRENTNESS,
    credentials,
    expectedSettingsVersion: 9,
    settings,
    rawSettings: settings,
    connectedServiceProfiles: [],
    automations: [],
    fetchConnectedServiceCredentialSealed: async () => {
      throw new Error('unexpected fetchConnectedServiceCredentialSealed');
    },
    decryptAutomationTemplateRaw: async () => {
      throw new Error('unexpected decryptAutomationTemplateRaw');
    },
  });
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Expected ${name} to be an object`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${name} to be a string`);
  }
}

describe('buildAccountEncryptionMigrateToPlainRequest', () => {
  it('converts both populated Connected catalogs without losing retained JSON or inventing Account keys', async () => {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(createLegacyCredentials());
    const service = { pluginId: 'happier.connected-account.example', localId: 'cloud' };
    const records = [
      { key: 'configurations', value: { v: 1, entries: [{ service, modeId: 'native-api', revision: 'config-1',
        values: { region: 'west' }, secretRefs: {} }] } },
      { key: 'purposes', value: { v: 1, bindings: [{ purpose: {
        consumer: { pluginId: 'happier.agent.example', localId: 'coding' }, purpose: 'model' },
        target: { kind: 'group', service, groupId: 'pool' } }] } },
    ] satisfies readonly ConnectedAccountCatalogRecordV1[];
    const retainedEnvelope = { color: 'orange' };
    const candidates = Object.fromEntries(records.map(record => {
      const payload = { ...record, retainedWrapper: { color: 'blue' }, value: { ...record.value, retainedCatalog: { color: 'green' } } };
      const content = { t: 'encrypted' as const, retainedEnvelope,
        c: sealAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(record.key), material,
          payload, randomBytes: length => new Uint8Array(length).fill(36) }) };
      const input = { key: record.key, mode: 'e2ee' as const, material, content, admission: 'migration' as const };
      const opened = openConnectedAccountCatalogContentV1(input);
      if (opened.status !== 'opened') throw new Error('Expected complete Connected source');
      return [record.key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes',
        { revision: 7, migrationSource: opened.migrationSource }];
    }));
    const result = await buildAccountEncryptionMigrateToPlainRequest({
      credentials: { token: 'plain-target-token' }, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...candidates,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    for (const record of records) {
      expect(result[record.key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes']).toEqual({
        expectedRevision: 7, content: { t: 'plain', retainedEnvelope, v: { ...record,
          retainedWrapper: { color: 'blue' }, value: { ...record.value, retainedCatalog: { color: 'green' } } } },
      });
    }
  });
  it.each([
    { name: 'retired', rawSettings: {} },
    { name: 'retained', rawSettings: {
      executionRunsGuidanceEnabled: 'unreadable',
      executionRunsGuidanceEntries: [{ id: 'retained-role', description: null }],
      promptStacksV1: { v: 1, surfaces: { profilesById: { 'retained-profile': [] } } },
      providerSettingsV1: { v: 2, retainedCatalog: { connectionId: 'retained-provider' } },
      remoteHostsV1: [], notificationChannelsV1: [], connectedServicesProfileLabelByKey: { 'service/default': 'Work' },
      connectedServicesCollapsedItemKeysV1: { 'service:account:default': false },
      connectedServicesDefaultAuthPoolAdoptionDismissedByKey: { 'agent:service:group': true }, dismissedCLIWarnings: { global: { installation: false }, perMachine: {} },
    } },
  ])('preserves exact $name prompt sources instead of materializing parsed defaults during Plain conversion', async ({ rawSettings }) => {
    const source: Readonly<Record<string, unknown>> = rawSettings;
    const parsedSettings = settingsParse(rawSettings);
    const request = await buildAccountEncryptionMigrateToPlainRequest({
      credentials: createLegacyCredentials(), storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 11, settings: parsedSettings, rawSettings,
      connectedServiceProfiles: [], automations: [],
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    if (request.settingsContent?.t !== 'plain') throw new Error('expected plain settings');
    assertObject(request.settingsContent.v, 'plain settings');
    const sourceRoots = ['promptStacksV1', 'promptFoldersV1', 'promptInvocationsV1', 'promptExternalLinksV1',
      'promptRegistrySourcesV1', 'contextSelectionsV1', 'rolesV1', 'executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled', 'providerSettingsV1',
      'remoteHostsV1', 'notificationChannelsV1', 'connectedServicesProfileLabelByKey', 'connectedServicesCollapsedItemKeysV1',
      'connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings'];
    for (const root of sourceRoots) {
      expect(Object.hasOwn(request.settingsContent.v, root), root).toBe(Object.hasOwn(rawSettings, root));
      if (Object.hasOwn(source, root)) expect(request.settingsContent.v[root]).toEqual(source[root]);
    }
    expect(request.settingsContent.v.preferredLanguage).toEqual(parsedSettings.preferredLanguage);
    expect(request.expectedSettingsVersion).toBe(11);
  });

  it.each(['live', 'deleted'] as const)('converts D10 singleton catalogs to Plain without requiring Account keys (%s)', async state => {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(createLegacyCredentials());
    const candidates = Object.fromEntries(D10_CATALOGS.map(({ field, kind, record, open }) => [field,
      { revision: 7, opened: state === 'deleted' ? null : open({ mode: 'e2ee', material,
        content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind, material, payload: record,
          randomBytes: length => new Uint8Array(length).fill(36) }) } }) }]));
    const request = await buildAccountEncryptionMigrateToPlainRequest({
      credentials: { token: 'plain-target-token' }, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...candidates,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(request).toMatchObject(Object.fromEntries(D10_CATALOGS.map(({ field, record }) => [field,
      { expectedRevision: 7, content: state === 'live' ? { t: 'plain', v: record } : null }])));
  });

  it.each(D10_CATALOGS)('refuses partial encrypted $field census before creating a Plain migration', async ({ field, kind, record, open, collection }) => {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(createLegacyCredentials());
    const opened = open({ mode: 'e2ee', material, content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind, material, payload: { ...record, [collection]: [{ malformed: true }] }, randomBytes: length => new Uint8Array(length).fill(36),
    }) } });
    expect(opened.status).toBe('partial');
    await expect(buildAccountEncryptionMigrateToPlainRequest({
      credentials: { token: 'plain-target-token' }, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...{ [field]: { revision: 7, opened } },
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    })).rejects.toThrow();
  });

  it('converts all 257 opened Profiles to Plain with captured revisions and no Account key requirement', async () => {
    const records = Array.from({ length: 257 }, (_, index) => ({ revision: index + 1, record: {
      v: 1 as const, id: `profile-${index}`, definition: { kind: 'artifact' as const, artifactId: `artifact-${index}` },
      enabled: index % 2 === 0, promptStack: [], secretBindings: {},
    } }));
    const material = resolveAccountScopedCryptoMaterialFromCredentials(createLegacyCredentials());
    const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 7, migratedLogicalRevision: 519,
      inventory: records.map(({ record, revision }) => ({ kind: 'account_row' as const, id: record.id, revision })),
    };
    const transferControl = { status: 'present' as const, revision: 6,
      content: sealProfileTransferContentV1({ mode: 'e2ee', material, record: control,
        randomBytes: length => new Uint8Array(length).fill(8) }),
    };
    const profileRows = await loadProfileCatalogV1({ mode: 'e2ee', material,
      readPage: async () => ({ status: 'listed', rows: records.map(({ revision, record }) => ({
        id: record.id, revision, content: sealProfileRecordContentV1({ mode: 'e2ee', material, record,
          randomBytes: length => new Uint8Array(length).fill(7) }),
      })), nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 519,
        transferControl }),
      readReferenceGuard: async () => ({ status: 'ready', revision: 519 }),
      readTransfer: async () => transferControl,
    });
    const request = await buildAccountEncryptionMigrateToPlainRequest({
      credentials: { token: 'plain-target-token' }, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      profileRows,
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(request.profileRows?.items).toHaveLength(257);
    expect(request.profileRows).toEqual({ expectedReferenceGuardRevision: 519,
      transferControl: { expectedRevision: 6, content: { t: 'plain', v: control } },
      items: records.map(({ revision, record }) => ({
      id: record.id, expectedRevision: revision, content: { t: 'plain', v: record },
    })) });
  });

  it('refuses a partial Profile census rather than producing an incomplete Plain migration', async () => {
    await expect(buildAccountEncryptionMigrateToPlainRequest({
      credentials: createLegacyCredentials(), storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      profileRows: { status: 'partial', authority: 'inactive', control: null, controlRevision: 'absent', records: [], referenceGuardRevision: 'absent',
        diagnostics: [{ id: 'profile-locked', revision: 0, reason: 'invalid-stored-content' }] },
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    })).rejects.toThrow('Profile catalog is not complete');
  });

  it('preserves Profile and transfer tombstone revisions without resealing deleted payloads', async () => {
    const request = await buildAccountEncryptionMigrateToPlainRequest({
      credentials: { token: 'plain-target-token' }, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      profileRows: { status: 'ready', authority: 'inactive', control: null, controlRevision: 9, records: [], tombstones: [{ id: 'deleted-profile', revision: 8 }],
        diagnostics: [], referenceGuardRevision: 11 },
      fetchConnectedServiceCredentialSealed: async () => { throw new Error('unexpected credential read'); },
      decryptAutomationTemplateRaw: async () => { throw new Error('unexpected automation read'); },
    });
    expect(request.profileRows).toEqual({ items: [], expectedReferenceGuardRevision: 11,
      transferControl: { expectedRevision: 9, content: null } });
  });

  it.each([1, 2] as const)('includes Account-owned new-session drafts in the atomic plain migration request (epoch %s)', async (epoch) => {
    const credentials = createLegacyCredentials();
    const acpPayload = { v: 1 as const, definitions: [], catalogMetadata: { label: 'Retained catalog' } };
    const envelopeMetadata = { note: 'Retained envelope' };
    const openedAcp = openAcpCatalogContentV1({ mode: 'e2ee', admission: 'migration',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), content: { t: 'encrypted', envelopeMetadata,
        c: sealAccountScopedBlobCiphertext({ kind: 'account_acp_catalog', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
          payload: acpPayload, randomBytes: length => new Uint8Array(length).fill(7) }) } });
    if (openedAcp.status !== 'opened') throw new Error('expected complete ACP migration source');
    const address = {
      kind: 'newSession' as const,
      draftId: '00000000-0000-4000-8000-000000000111',
    };
    const document = SessionDraftDocumentV2Schema.parse({
      v: epoch,
      composer: {
        text: { mutationId: '00000000-0000-4000-8000-000000000112', value: 'draft' },
        mentions: { mutationId: '00000000-0000-4000-8000-000000000113', value: [] },
        attachments: { mutationId: '00000000-0000-4000-8000-000000000114', value: [] },
      },
      target: { kind: 'newSession' as const, authoring: epoch === 1 ? {} : {
        executionTarget: { mutationId: '00000000-0000-4000-8000-000000000105', value: {
          kind: 'temporary_computer', serverId: 'server-a', artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' },
        } },
      } },
      extensions: {},
    });

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      rawSettings: {},
      connectedServiceProfiles: [],
      automations: [],
      sessionDrafts: [{ address, baseRevision: 8, document }],
      authoringMemory: [{ key: 'lastUsedProfile', revision: 3, value: 'profile-a' }],
      acpCatalog: { revision: 4, record: openedAcp.record, migrationSource: openedAcp.migrationSource },
      promptLibrary: [{ revision: 5, record: { key: 'role-overrides', value: { v: 1, overrides: {
        reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Review only' },
      } } } }],
      projectTrust: [{ project: { serverId: 'home', projectId: 'project' }, revision: 4,
        value: { project: { serverId: 'home', projectId: 'project' }, reviewedEffectDigest: 'effect', approvedAtMs: 1 } }],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.sessionDrafts).toEqual({
      ...(epoch === 2 ? { v: 2 } : {}),
      items: [{
        address,
        expectedRevision: 8,
        content: { t: 'plain', v: { v: epoch, address, document } },
      }],
    });
    expect(request.authoringMemory).toEqual({ items: [{
      key: 'lastUsedProfile', expectedRevision: 3, content: { t: 'plain', v: 'profile-a' },
    }] });
    expect(request.acpCatalog).toEqual({ expectedRevision: 4, content: { t: 'plain', v: acpPayload, envelopeMetadata } });
    expect(request.promptLibrary).toEqual({ items: [{ key: 'role-overrides', expectedRevision: 5,
      content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {
        reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Review only' },
      } } } },
    }] });
    expect(request.projectTrust).toEqual({ items: [{ project: { serverId: 'home', projectId: 'project' }, expectedRevision: 4,
      content: { t: 'plain', v: { project: { serverId: 'home', projectId: 'project' }, reviewedEffectDigest: 'effect', approvedAtMs: 1 } },
    }] });
  });

  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      rawSettings: {},
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.toMode).toBe('plain');
    expect(request.expectedSettingsVersion).toBe(7);
    expect(request.settingsContent?.t).toBe('plain');
    expect(request.connectedServices).toEqual({ action: 'assert_empty' });
    expect(request.automations).toEqual({ action: 'assert_empty' });
    expect(request.sessions).toEqual({ action: 'assert_empty' });
    expect(request.sessionDrafts).toBeUndefined();
  });

  it('includes the released legacy Voice adapter projection in plain full-settings migrations', async () => {
    const credentials = createLegacyCredentials();
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const elevenLabsDefaults = settingsParse({}).voice.providers[
      'happier.voice.elevenlabs/realtime-elevenlabs'
    ];
    if (!elevenLabsDefaults) throw new Error('expected ElevenLabs defaults');
    assertObject(elevenLabsDefaults.config, 'ElevenLabs default config');

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: settingsParse({
        secrets: [{
          id: 'voice-elevenlabs-secret',
          name: 'Voice ElevenLabs',
          kind: 'apiKey',
          encryptedValue: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'xi_migration_key',
              settingsSecretsKey,
              () => new Uint8Array(24).fill(8),
            ),
          },
          createdAt: 1,
          updatedAt: 1,
        }],
        voice: {
          providerId: 'realtime_elevenlabs',
          credentialBindings: [{
            providerId: 'realtime_elevenlabs',
            credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
          }],
          providers: {
            'happier.voice.elevenlabs/realtime-elevenlabs': {
              schemaVersion: 2,
              config: {
                ...elevenLabsDefaults.config,
                billingMode: 'byo',
                agentId: 'agent_1',
              },
            },
          },
        },
      }),
      rawSettings: {},
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.settingsContent?.t).toBe('plain');
    if (!request.settingsContent || request.settingsContent.t !== 'plain') {
      throw new Error('expected plain settings content');
    }
    assertObject(request.settingsContent.v, 'plain settings');
    assertObject(request.settingsContent.v.voice, 'legacy voice projection');
    assertObject(request.settingsContent.v.voice.adapters, 'legacy voice adapters');
    assertObject(
      request.settingsContent.v.voice.adapters.realtime_elevenlabs,
      'legacy ElevenLabs adapter',
    );
    assertObject(
      request.settingsContent.v.voice.adapters.realtime_elevenlabs.byo,
      'legacy ElevenLabs BYO settings',
    );

    expect(request.settingsContent.v.voiceSettingsV1).toEqual(
      expect.objectContaining({
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      }),
    );
    expect(request.settingsContent.v.voice.adapters.realtime_elevenlabs.byo.apiKey).toEqual({
      _isSecretValue: true,
      value: 'xi_migration_key',
    });
  });

  it('migrates connected service credentials and plaintext-safe automation templates to plain envelopes', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-1',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material,
      payload: record,
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    // Sanity: opening yields the record.
    const opened = openConnectedServiceCredentialCiphertext({ material, ciphertext: sealedCiphertext });
    expect(opened).not.toBeNull();
    if (!opened) throw new Error('Expected opened credential');
    expect(opened.value).toEqual(expect.objectContaining({ kind: 'oauth' }));

    const sensitiveTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'e2ee',
      template: {
        directory: '/tmp/project',
        prompt: 'Hi',
        existingSessionId: 's1',
        sessionEncryptionKeyBase64: 'dek',
        sessionEncryptionVariant: 'dataKey',
      },
      encryptRaw: async (value) => `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`,
    });

    const safeTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'e2ee',
      template: {
        directory: '/tmp/project',
        prompt: 'Hello',
        existingSessionId: 's2',
      },
      encryptRaw: async (value) => `cipher:${Buffer.from(JSON.stringify(value)).toString('base64')}`,
    });

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      rawSettings: {},
      automations: [
        { id: 'auto_sensitive', templateVersion: 3, templateCiphertext: sensitiveTemplateCiphertext },
        { id: 'auto_safe', templateVersion: 5, templateCiphertext: safeTemplateCiphertext },
      ],
      resolveSession: async (sessionId) => ({ sessionId, encryptionMode: sessionId === 's1' ? 'e2ee' : 'plain' }),
      fetchConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct-1', expiresAt: 123 },
      }),
      decryptAutomationTemplateRaw: async (payloadCiphertext) => {
        // See encodeAutomationTemplateForTransport above.
        const prefix = 'cipher:';
        const b64 = payloadCiphertext.startsWith(prefix) ? payloadCiphertext.slice(prefix.length) : payloadCiphertext;
        const json = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(json);
      },
    });

    expect(request.connectedServices.action).toBe('migrate');
    if (request.connectedServices.action !== 'migrate') throw new Error('expected migrate');
    expect(request.connectedServices.credentials).toHaveLength(1);
    expect(request.connectedServices.credentials[0]).toEqual(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: CREDENTIAL_REVISION,
      kind: 'plain',
      record: expect.objectContaining({ kind: 'oauth' }),
    }));

    expect(request.automations.action).toBe('migrate');
    if (request.automations.action !== 'migrate') throw new Error('expected migrate');
    expect(request.automations.templates).toHaveLength(2);

    const sensitive = request.automations.templates[0];
    assertObject(sensitive, 'sensitive automation template');
    expect(sensitive.automationId).toBe('auto_sensitive');
    expect(sensitive.expectedTemplateVersion).toBe(3);
    expect(sensitive.templateCiphertext).toBe(sensitiveTemplateCiphertext);

    const safe = request.automations.templates[1];
    assertObject(safe, 'safe automation template');
    expect(safe.automationId).toBe('auto_safe');
    expect(safe.expectedTemplateVersion).toBe(5);
    assertString(safe.templateCiphertext, 'safe automation templateCiphertext');
    const plainEnvelope = JSON.parse(safe.templateCiphertext);
    expect(plainEnvelope.kind).toBe('happier_automation_template_plain_v1');
  });

  it('rejects a decrypted sealed credential whose embedded binding differs from the requested profile', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const misboundRecord = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'token',
      token: { token: 'tok-foreign', providerAccountId: 'acct-1', providerEmail: null },
    });
    const sealedCiphertext = sealConnectedServiceCredentialCiphertext({
      material,
      payload: misboundRecord,
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    await expect(buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 7,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      rawSettings: {},
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'token', providerEmail: null, providerAccountId: 'acct-1', expiresAt: null },
      }),
      decryptAutomationTemplateRaw: async () => null,
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });

  it('unseals canonical machine-key-sealed saved secrets when migrating a legacy account to plain storage', async () => {
    const credentials = createLegacyCredentials();
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);

    const request = await buildAccountEncryptionMigrateToPlainRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      expectedSettingsVersion: 9,
      rawSettings: {},
      settings: {
        schemaVersion: 2,
        backendEnabledById: {},
        secrets: [
          {
            id: 'sec1',
            name: 'Canonical Secret',
            kind: 'apiKey',
            encryptedValue: {
              _isSecretValue: true,
              encryptedValue: encryptSecretStringV1(
                'sk-canonical',
                canonicalSettingsKey,
                () => new Uint8Array(24).fill(8),
              ),
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      } as any,
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialSealed: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialSealed');
      },
      decryptAutomationTemplateRaw: async () => {
        throw new Error('unexpected decryptAutomationTemplateRaw');
      },
    });

    expect(request.settingsContent?.t).toBe('plain');
    if (!request.settingsContent || request.settingsContent.t !== 'plain') {
      throw new Error('expected plain settings content');
    }
    expect((request.settingsContent.v as any)?.secrets?.[0]?.encryptedValue?.value).toBe('sk-canonical');
  });

  it('refuses a target-plain request when a nested SavedSecret was encrypted with a different key', async () => {
    const credentials = createLegacyCredentials();
    const otherSettingsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(9)),
    );
    const encryptedValue = encryptSecretStringV1(
      'sk-wrong-key',
      otherSettingsKey,
      () => new Uint8Array(24).fill(7),
    );

    await expect(buildPlainRequestWithSettings(
      credentials,
      createSettingsWithSavedSecret(encryptedValue),
    )).rejects.toMatchObject({ code: 'local_secret_unavailable' });
  });

  it('refuses a target-plain request when a nested SavedSecret ciphertext is malformed', async () => {
    await expect(buildPlainRequestWithSettings(
      createLegacyCredentials(),
      createSettingsWithSavedSecret({ t: 'enc-v1', c: 'not-valid-base64' }),
    )).rejects.toMatchObject({ code: 'local_secret_unavailable' });
  });

  it('refuses a target-plain request when token-only credentials cannot open a nested SavedSecret', async () => {
    const sourceSettingsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(4)),
    );
    const encryptedValue = encryptSecretStringV1(
      'sk-token-only',
      sourceSettingsKey,
      () => new Uint8Array(24).fill(6),
    );

    await expect(buildPlainRequestWithSettings(
      { token: 'token-only' },
      createSettingsWithSavedSecret(encryptedValue),
    )).rejects.toMatchObject({ code: 'local_secret_unavailable' });
  });
});
