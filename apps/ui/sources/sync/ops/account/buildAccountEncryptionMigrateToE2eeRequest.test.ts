import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol/connect/build-connected-service-credential-record';
import { deriveAccountMachineKeyFromRecoverySecret, openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { deriveSettingsSecretsKeyV1, encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { createAccountEncryptionMigrateProofSigningInputV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { openConnectedServiceCredentialCiphertext } from '@happier-dev/protocol/connect/connectedServiceCipher';
import { SessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { encodeAutomationTemplateForTransport } from '@/sync/domains/automations/automationTemplateTransport';
import { settingsParse } from '@/sync/domains/settings/settings';
import { openProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { openProfileTransferContentV1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { openPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { openRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { openNotificationChannelCatalogContentV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { openConnectedPresentationContentV1, openConnectedAcknowledgementsContentV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { connectedAccountCatalogCipherKindV1, openConnectedAccountCatalogContentV1,
  type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

import { buildAccountEncryptionMigrateToE2eeRequest } from './buildAccountEncryptionMigrateToE2eeRequest';

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
  accountId: 'account-1',
  expectedAccountVersion: 4,
  expectedSigningKeyFingerprint: null,
  expectedContentKeyFingerprint: null,
} as const;

function createLegacyCredentials(): Extract<AuthCredentials, { secret: string }> {
  return {
    token: 't',
    secret: Buffer.from(new Uint8Array(32).fill(9)).toString('base64url'),
  };
}

const CONTENT_KEY_PROOF = {
  v: 1 as const,
  publicKey: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
  contentPublicKey: Buffer.from(new Uint8Array(32).fill(2)).toString('base64'),
  contentPublicKeySig: 'content-public-key-signature',
  sign: () => 'request-signature',
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

describe('buildAccountEncryptionMigrateToE2eeRequest', () => {
  it('converts both populated Connected catalogs to E2EE without losing retained JSON', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
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
      const input = { key: record.key, mode: 'plain' as const, material: null,
        content: { t: 'plain' as const, v: payload, retainedEnvelope }, admission: 'migration' as const };
      const opened = openConnectedAccountCatalogContentV1(input);
      if (opened.status !== 'opened') throw new Error('Expected complete Connected source');
      return [record.key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes',
        { revision: 7, migrationSource: opened.migrationSource }];
    }));
    const result = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS, keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...candidates,
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    for (const record of records) {
      const directive = result[record.key === 'configurations' ? 'connectedConfigurations' : 'connectedPurposes'];
      expect(directive?.expectedRevision).toBe(7);
      if (directive?.content?.t !== 'encrypted') throw new Error('Expected encrypted Connected directive');
      expect(directive.content).toMatchObject({ retainedEnvelope });
      expect(openAccountScopedBlobCiphertext({ kind: connectedAccountCatalogCipherKindV1(record.key), material,
        ciphertext: directive.content.c })?.value).toEqual({ ...record, retainedWrapper: { color: 'blue' },
          value: { ...record.value, retainedCatalog: { color: 'green' } } });
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
  ])('preserves exact $name prompt sources instead of materializing parsed defaults during E2EE conversion', async ({ rawSettings }) => {
    const source: Readonly<Record<string, unknown>> = rawSettings;
    const credentials = createLegacyCredentials();
    const parsedSettings = settingsParse(rawSettings);
    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS, keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 11, settings: parsedSettings, rawSettings,
      connectedServiceProfiles: [], automations: [],
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    if (request.settingsContent?.t !== 'encrypted') throw new Error('expected encrypted settings');
    const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), ciphertext: request.settingsContent.c });
    if (!opened) throw new Error('expected opened settings');
    assertObject(opened.value, 'opened settings');
    const sourceRoots = ['promptStacksV1', 'promptFoldersV1', 'promptInvocationsV1', 'promptExternalLinksV1',
      'promptRegistrySourcesV1', 'contextSelectionsV1', 'rolesV1', 'executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled', 'providerSettingsV1',
      'remoteHostsV1', 'notificationChannelsV1', 'connectedServicesProfileLabelByKey', 'connectedServicesCollapsedItemKeysV1',
      'connectedServicesDefaultAuthPoolAdoptionDismissedByKey', 'dismissedCLIWarnings'];
    for (const root of sourceRoots) {
      expect(Object.hasOwn(opened.value, root), root).toBe(Object.hasOwn(rawSettings, root));
      if (Object.hasOwn(source, root)) expect(opened.value[root]).toEqual(source[root]);
    }
    expect(opened.value.preferredLanguage).toEqual(parsedSettings.preferredLanguage);
    expect(request.expectedSettingsVersion).toBe(11);
  });

  it.each(['live', 'deleted'] as const)('converts D10 singleton catalogs into their E2EE purpose without resealing tombstones (%s)', async state => {
    const credentials = createLegacyCredentials();
    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS, keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...Object.fromEntries(D10_CATALOGS.map(({ field, record, open }) => [field,
        { revision: 7, opened: state === 'deleted' ? null : open({ content: { t: 'plain', v: record }, mode: 'plain', material: null }) }])),
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    assertObject(request, 'migration request');
    for (const { field, kind, record } of D10_CATALOGS) {
      const directive = request[field];
      assertObject(directive, field);
      expect(directive.expectedRevision).toBe(7);
      if (state === 'deleted') {
        expect(directive.content).toBeNull();
        continue;
      }
      assertObject(directive.content, 'catalog content');
      expect(directive.content.t).toBe('encrypted');
      assertString(directive.content.c, 'catalog ciphertext');
      expect(openAccountScopedBlobCiphertext({ kind,
        material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), ciphertext: directive.content.c })?.value).toEqual(record);
    }
  });

  it.each(D10_CATALOGS)('refuses partial $field census before creating an E2EE migration', async ({ field, record, open, collection }) => {
    const opened = open({ mode: 'plain', material: null, content: { t: 'plain', v: { ...record, [collection]: [{ malformed: true }] } } });
    expect(opened.status).toBe('partial');
    await expect(buildAccountEncryptionMigrateToE2eeRequest({
      credentials: createLegacyCredentials(), storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS, keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      ...{ [field]: { revision: 7, opened } },
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    })).rejects.toThrow();
  });

  it('includes all 257 Profiles and captured reference guard in the signed E2EE migration', async () => {
    const credentials = createLegacyCredentials();
    const acpPayload = { v: 1 as const, definitions: [], catalogMetadata: { label: 'Retained catalog' } };
    const envelopeMetadata = { note: 'Retained envelope' };
    const openedAcp = openAcpCatalogContentV1({ mode: 'plain', material: null, admission: 'migration',
      content: { t: 'plain', v: acpPayload, envelopeMetadata } });
    if (openedAcp.status !== 'opened') throw new Error('expected complete ACP migration source');
    const records = Array.from({ length: 257 }, (_, index) => ({ revision: index + 1, record: {
      v: 1 as const, id: `profile-${index}`, definition: { kind: 'artifact' as const, artifactId: `artifact-${index}` },
      enabled: index % 2 === 0, promptStack: [], secretBindings: {},
    } }));
    const control = { v: 1 as const, phase: 'prepared' as const, sourceSettingsVersion: 7, migratedLogicalRevision: 519,
      inventory: records.map(({ record, revision }) => ({ kind: 'account_row' as const, id: record.id, revision })),
    };
    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      credentials, storageDirectives: EMPTY_STORAGE_DIRECTIVES, ...CURRENTNESS, keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 7, settings: settingsParse({}), rawSettings: {}, connectedServiceProfiles: [], automations: [],
      profileRows: { status: 'ready', authority: 'inactive', control: { record: control, revision: 6 }, controlRevision: 6,
        records, diagnostics: [], referenceGuardRevision: 519 },
      acpCatalog: { revision: 4, record: openedAcp.record, migrationSource: openedAcp.migrationSource },
      promptLibrary: [{ revision: 5, record: { key: 'role-overrides', value: { v: 1, overrides: {
        reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Review only' },
      } } } }],
      fetchConnectedServiceCredentialPlain: async () => { throw new Error('unexpected credential read'); },
    });
    expect(request.profileRows?.items).toHaveLength(257);
    expect(request.acpCatalog).toMatchObject({ expectedRevision: 4, content: { t: 'encrypted', envelopeMetadata } });
    if (request.acpCatalog?.content?.t !== 'encrypted') throw new Error('expected encrypted ACP catalog');
    expect(openAccountScopedBlobCiphertext({ kind: 'account_acp_catalog', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      ciphertext: request.acpCatalog.content.c })?.value).toEqual(acpPayload);
    expect(openAcpCatalogContentV1({ mode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      content: request.acpCatalog?.content })).toEqual({ status: 'opened', record: { v: 1, definitions: [] } });
    expect(request.promptLibrary?.items[0]).toMatchObject({ key: 'role-overrides', expectedRevision: 5, content: { t: 'encrypted' } });
    expect(openPromptLibraryContentV1({ mode: 'e2ee', key: 'role-overrides',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials), content: request.promptLibrary?.items[0]?.content,
    })).toEqual({ status: 'opened', record: { key: 'role-overrides', value: { v: 1, overrides: {
      reviewer: { roleId: 'reviewer', workspaceWrites: 'deny', instructionsOverride: 'Review only' },
    } } } });
    expect(request.profileRows?.expectedReferenceGuardRevision).toBe(519);
    expect(request.profileRows?.transferControl.expectedRevision).toBe(6);
    expect(request.profileRows?.transferControl.content?.t).toBe('encrypted');
    expect(openProfileTransferContentV1({ mode: 'e2ee',
      material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
      content: request.profileRows?.transferControl.content,
    })).toEqual({ status: 'opened', record: control });
    for (const [index, item] of (request.profileRows?.items ?? []).entries()) {
      expect(item.id).toBe(records[index].record.id);
      expect(item.expectedRevision).toBe(records[index].revision);
      expect(item.content.t).toBe('encrypted');
      expect(openProfileRecordContentV1({
        mode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
        expectedId: item.id, content: item.content,
      })).toEqual({ status: 'opened', record: records[index].record });
    }
    expect(JSON.stringify(request.profileRows)).not.toContain('artifact-256');
  });

  it.each([1, 2] as const)('includes Account-owned new-session drafts in the signed atomic e2ee migration request (epoch %s)', async (epoch) => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const sign = vi.fn(() => 'request-signature');
    const address = {
      kind: 'newSession' as const,
      draftId: '00000000-0000-4000-8000-000000000101',
    };
    const document = SessionDraftDocumentV2Schema.parse({
      v: epoch,
      composer: {
        text: { mutationId: '00000000-0000-4000-8000-000000000102', value: 'draft' },
        mentions: { mutationId: '00000000-0000-4000-8000-000000000103', value: [] },
        attachments: { mutationId: '00000000-0000-4000-8000-000000000104', value: [] },
      },
      target: { kind: 'newSession' as const, authoring: epoch === 1 ? {} : {
        executionTarget: { mutationId: '00000000-0000-4000-8000-000000000105', value: {
          kind: 'temporary_computer', serverId: 'server-a', artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' },
        } },
      } },
      extensions: {},
    });

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: { ...CONTENT_KEY_PROOF, sign },
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      rawSettings: {},
      connectedServiceProfiles: [],
      automations: [],
      sessionDrafts: [{ address, baseRevision: 7, document }],
      authoringMemory: [{ key: 'lastUsedProfile', revision: 3, value: 'profile-a' }],
      projectTrust: [{ project: { serverId: 'home', projectId: 'project' }, revision: 4,
        value: { project: { serverId: 'home', projectId: 'project' }, reviewedEffectDigest: 'effect', approvedAtMs: 1 } }],
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.sessionDrafts?.items).toHaveLength(1);
    expect(request.sessionDrafts).toEqual(expect.objectContaining(epoch === 2 ? { v: 2 } : {}));
    const item = request.sessionDrafts!.items[0];
    expect(item).toMatchObject({ address, expectedRevision: 7, content: { t: 'encrypted', ...(epoch === 2 ? { v: 2 } : {}) } });
    if (item.content.t !== 'encrypted') throw new Error('expected encrypted draft');
    expect(openAccountScopedBlobCiphertext({
      kind: 'account_session_draft_private_payload',
      material,
      ciphertext: item.content.c,
    })?.value).toEqual({ v: epoch, address, document });
    expect(sign).toHaveBeenCalledWith(
      createAccountEncryptionMigrateProofSigningInputV1({
        request,
        accountId: CURRENTNESS.accountId,
        sourceMode: 'plain',
      }),
    );
    const memory = request.authoringMemory!.items[0]!;
    expect(memory).toMatchObject({ key: 'lastUsedProfile', expectedRevision: 3, content: { t: 'encrypted' } });
    if (memory.content.t !== 'encrypted') throw new Error('expected encrypted authoring memory');
    expect(openAccountScopedBlobCiphertext({ kind: 'authoring_memory', material, ciphertext: memory.content.c })?.value)
      .toEqual({ key: 'lastUsedProfile', value: 'profile-a' });
    const trust = request.projectTrust!.items[0]!;
    expect(trust).toMatchObject({ project: { serverId: 'home', projectId: 'project' }, expectedRevision: 4 });
    if (trust.content.t !== 'encrypted') throw new Error('expected encrypted Project Trust');
    expect(openAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material, ciphertext: trust.content.c })?.value)
      .toEqual({ project: { serverId: 'home', projectId: 'project' }, reviewedEffectDigest: 'effect', approvedAtMs: 1 });
  });

  it('builds assert_empty directives when no connected services or automations exist', async () => {
    const credentials = createLegacyCredentials();
    const sign = vi.fn(() => 'request-signature');

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: {
        ...CONTENT_KEY_PROOF,
        sign,
      },
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      rawSettings: {},
      connectedServiceProfiles: [],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.toMode).toBe('e2ee');
    expect(request.connectedServices).toEqual({ action: 'assert_empty' });
    expect(request.automations).toEqual({ action: 'assert_empty' });
    expect(request.settingsContent?.t).toBe('encrypted');
    expect(request.keyProof).toEqual({
      v: 1,
      publicKey: CONTENT_KEY_PROOF.publicKey,
      signature: 'request-signature',
      contentPublicKey: CONTENT_KEY_PROOF.contentPublicKey,
      contentPublicKeySig: CONTENT_KEY_PROOF.contentPublicKeySig,
    });
    expect(typeof (request.settingsContent as any).c).toBe('string');
    expect(request.sessions).toEqual({ action: 'assert_empty' });
    expect(request.sessionDrafts).toBeUndefined();
    expect(sign).toHaveBeenCalledWith(
      createAccountEncryptionMigrateProofSigningInputV1({
        request,
        accountId: CURRENTNESS.accountId,
        sourceMode: 'plain',
      }),
    );
  });

  it('includes the released legacy Voice adapter projection in encrypted full-settings migrations', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    const recoverySecret = Buffer.from(credentials.secret, 'base64url');
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(
      deriveAccountMachineKeyFromRecoverySecret(recoverySecret),
    );
    const elevenLabsDefaults = settingsParse({}).voice.providers[
      'happier.voice.elevenlabs/realtime-elevenlabs'
    ];
    if (!elevenLabsDefaults) throw new Error('expected ElevenLabs defaults');
    assertObject(elevenLabsDefaults.config, 'ElevenLabs default config');

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
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
      fetchConnectedServiceCredentialPlain: async () => {
        throw new Error('unexpected fetchConnectedServiceCredentialPlain');
      },
    });

    expect(request.settingsContent?.t).toBe('encrypted');
    if (!request.settingsContent || request.settingsContent.t !== 'encrypted') {
      throw new Error('expected encrypted settings content');
    }
    const openedSettings = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      ciphertext: request.settingsContent.c,
    });
    expect(openedSettings).not.toBeNull();
    if (!openedSettings) throw new Error('expected opened settings');
    assertObject(openedSettings.value, 'opened settings');
    assertObject(openedSettings.value.voice, 'legacy voice projection');
    assertObject(openedSettings.value.voice.adapters, 'legacy voice adapters');
    assertObject(
      openedSettings.value.voice.adapters.realtime_elevenlabs,
      'legacy ElevenLabs adapter',
    );
    assertObject(
      openedSettings.value.voice.adapters.realtime_elevenlabs.byo,
      'legacy ElevenLabs BYO settings',
    );

    expect(openedSettings.value.voiceSettingsV1).toEqual(
      expect.objectContaining({
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      }),
    );
    expect(openedSettings.value.voice.adapters.realtime_elevenlabs.byo.apiKey).toHaveProperty(
      'encryptedValue',
    );
    expect(openedSettings.value.voice.adapters.realtime_elevenlabs.byo.apiKey).not.toHaveProperty(
      'value',
    );
  });

  it('migrates plaintext connected service credentials and automations to encrypted envelopes', async () => {
    const credentials = createLegacyCredentials();
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'tok-1',
        providerAccountId: 'acct-1',
        providerEmail: 'x@example.com',
      },
    });

    const plainTemplateCiphertext = await encodeAutomationTemplateForTransport({
      accountMode: 'plain',
      template: {
        directory: '/tmp/project',
        prompt: 'Hi',
        existingSessionId: 's1',
      },
    });

    const request = await buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {}, pushEnabled: true } as any,
      rawSettings: {},
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [{ id: 'auto_1', templateVersion: 6, templateCiphertext: plainTemplateCiphertext }],
      fetchConnectedServiceCredentialPlain: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        content: { t: 'plain', v: record },
      }),
    });

    expect(request.connectedServices.action).toBe('migrate');
    if (request.connectedServices.action !== 'migrate') throw new Error('expected migrate');
    expect(request.connectedServices.credentials).toHaveLength(1);
    const cred = request.connectedServices.credentials[0];
    assertObject(cred, 'connected service credential');
    expect(cred.kind).toBe('sealed');
    expect(cred.expectedCredentialRevision).toBe(
      CREDENTIAL_REVISION,
    );
    assertObject(cred.sealed, 'sealed connected service credential');
    expect(cred.sealed.format).toBe('account_scoped_v1');
    assertString(cred.sealed.ciphertext, 'sealed ciphertext');

    const openedCred = openConnectedServiceCredentialCiphertext({
      material,
      ciphertext: cred.sealed.ciphertext,
    });
    expect(openedCred).not.toBeNull();
    if (!openedCred) throw new Error('Expected opened credential');
    expect(openedCred.value).toEqual(expect.objectContaining({ kind: 'token' }));

    expect(request.settingsContent?.t).toBe('encrypted');
    const openedSettings = openAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material,
      ciphertext: (request.settingsContent as any).c,
    });
    expect(openedSettings?.value).toEqual(expect.objectContaining({ pushEnabled: true }));

    expect(request.automations.action).toBe('migrate');
    if (request.automations.action !== 'migrate') throw new Error('expected migrate');
    const template = request.automations.templates[0];
    assertObject(template, 'automation template');
    expect(template.expectedTemplateVersion).toBe(6);
    assertString(template.templateCiphertext, 'automation templateCiphertext');
    const envelope = JSON.parse(template.templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
  });

  it('rejects a fetched plaintext credential whose embedded binding differs from the requested profile', async () => {
    const credentials = createLegacyCredentials();
    const misboundRecord = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'token',
      token: { token: 'tok-foreign', providerAccountId: 'acct-1', providerEmail: null },
    });

    await expect(buildAccountEncryptionMigrateToE2eeRequest({
      storageDirectives: EMPTY_STORAGE_DIRECTIVES,
      ...CURRENTNESS,
      credentials,
      keyProof: CONTENT_KEY_PROOF,
      expectedSettingsVersion: 1,
      settings: { schemaVersion: 2, backendEnabledById: {} } as any,
      rawSettings: {},
      connectedServiceProfiles: [{ serviceId: 'openai-codex', profileId: 'work' }],
      automations: [],
      fetchConnectedServiceCredentialPlain: async () => ({
        revisionSemantics: 'revisioned',
        credentialRevision: CREDENTIAL_REVISION,
        content: { t: 'plain', v: misboundRecord },
      }),
    })).rejects.toMatchObject({ code: 'connected_service_credential_binding_mismatch' });
  });
});
