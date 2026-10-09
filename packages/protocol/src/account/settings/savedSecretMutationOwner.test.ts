import { describe, expect, it } from 'vitest';

import {
  AccountSettingsSavedSecretMutationError,
  applyAccountSettingsSavedSecretMutation,
  applyAccountSettingsVoiceCredentialSourceMutation,
  eraseAccountSettingsPluginSecretBindings,
  formatSharedSavedSecretRefV1,
  listAccountSettingsSavedSecretReferences,
  parseSavedSecretRefV1,
  promotePersonalSavedSecretReference,
  qualifyPluginAccountSecretBindingKey,
  rekeyPersonalSavedSecret,
  resolveAccountSettingsPluginSecretBinding,
  resolveAccountSettingsPluginSecret,
  resolveAccountSettingsVoiceCredentialSecret,
  resolveAccountSettingsVoiceCredentialSource,
  type AccountSettingsVoiceCredentialSourceMutation,
} from './savedSecretMutationOwner.js';
import { VoiceProviderContributionSchema } from '../../plugins/contributions/voiceProviders.js';
import { LegacyVoiceCredentialBindingV1Schema, VoiceCredentialBindingV1Schema } from '../../voice/realtime/providerSettings.js';
import { SAVED_SECRET_COLLECTION_MAX_ENTRIES, SavedSecretSchema } from '../../profiles/backendProfileSchema.js';
import { accountSettingsParse } from './accountSettings.js';
import { ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES } from './catalog/accountSettingBounds.js';
import { ProfileRecordV1Schema } from '../../profiles/profileRecordV1.js';
import * as savedSecretOwner from './savedSecretMutationOwner.js';
import type { ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import { ProfileTransferControlV1Schema } from '../../profiles/profileTransferV1.js';
import { McpServerCatalogV1Schema } from '../../mcp/servers/serverRowsV1.js';
import { AcpCatalogRecordV1Schema } from '../../acp/catalog/catalogRowsV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '../../providers/connections/connectionRowsV1.js';
import { ConnectedConfigurationCatalogV1Schema } from '../../connect/connectedAccountConfigurationRowsV1.js';
import { NotificationChannelCatalogRecordV1Schema } from './notificationChannelSchemasV1.js';
import { SecretStringV1Schema } from '../../crypto/settingsSecretStringSchemasV1.js';

describe('notification signing-secret source identity', () => {
  it('uses the exact Account and stable channel identity for resource preparation', () => {
    const first = savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner',
      source: { kind: 'notification-channel-signing-secret', channelId: 'workflow-hook' } });
    expect(first).toMatch(/^[0-9a-f-]+$/);
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner',
      source: { kind: 'notification-channel-signing-secret', channelId: 'workflow-hook' } })).toBe(first);
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'other',
      source: { kind: 'notification-channel-signing-secret', channelId: 'workflow-hook' } })).not.toBe(first);
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner',
      source: { kind: 'notification-channel-signing-secret', channelId: 'second-hook' } })).not.toBe(first);
  });
});

describe('notification channel SavedSecret reference census', () => {
  it('includes opened signing slots and rewrites only those slots through the complete owner', () => {
    const reference = formatSharedSavedSecretRefV1('notification-signing');
    const replacement = formatSharedSavedSecretRefV1('replacement-signing');
    const notificationChannels = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [
      { v: 1, id: 'signed-webhook', kind: 'webhook', url: 'https://example.test/signed', topics: {}, signingSecretRef: reference },
      { v: 1, id: 'unsigned-webhook', kind: 'webhook', url: 'https://example.test/unsigned', topics: {}, signingSecretRef: null },
    ] });
    const catalogs = { profileRecords: [], notificationChannels };
    expect(listAccountSettingsSavedSecretReferences({}, reference, catalogs)).toEqual([
      { owner: 'notificationChannel', path: 'notificationChannelsCatalog.channels[0].signingSecretRef' },
    ]);
    const rewritten = savedSecretOwner.rewriteSavedSecretReferenceCatalogsV1(catalogs, reference, replacement);
    expect(rewritten).toEqual({ ...catalogs, notificationChannels: { ...notificationChannels, channels: [
      { ...notificationChannels.channels[0], signingSecretRef: replacement }, notificationChannels.channels[1],
    ] } });
    expect(listAccountSettingsSavedSecretReferences({}, reference, rewritten)).toEqual([]);
    expect(notificationChannels.channels[0]).toHaveProperty('signingSecretRef', reference);
  });

  it('refuses incomplete and malformed signing inventories instead of permitting resource deletion', () => {
    const reference = formatSharedSavedSecretRefV1('notification-signing');
    const channel = { v: 1, id: 'signed-webhook', kind: 'webhook', url: 'https://example.test/signed', topics: {}, signingSecretRef: reference };
    for (const notificationChannels of [
      { v: 1, channels: [{ ...channel, futureCredential: { savedSecretId: reference } }] },
      { v: 1, channels: [{ ...channel, signingSecretRef: 'happier:shared-secret:v1:' }] },
      { v: 1, channels: [channel, channel] },
    ]) {
      const catalogs = { profileRecords: [], notificationChannels };
      expect(() => listAccountSettingsSavedSecretReferences({}, reference, catalogs)).toThrow(AccountSettingsSavedSecretMutationError);
    }
  });

  it('keeps the captured signing inventory in the personal promotion result', () => {
    const notificationChannels = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [
      { v: 1, id: 'signed-webhook', kind: 'webhook', url: 'https://example.test/signed', topics: {},
        signingSecretRef: formatSharedSavedSecretRefV1('unrelated-signing') },
    ] });
    const settings = { secrets: [secret] };
    const result = promotePersonalSavedSecretReference(settings, { secretId: secret.id,
      expectedUpdatedAt: secret.updatedAt, sharedSecretRef: formatSharedSavedSecretRefV1('promoted-personal') },
      { profileRecords: [], notificationChannels });
    expect(result).toHaveProperty('notificationChannels', notificationChannels);
    expect(result.settings.secrets).toEqual([]);
    expect(settings.secrets).toEqual([secret]);
  });
});

describe('remote host SavedSecret reference census', () => {
  it('distinguishes inactive sources from active empty catalogs and authoritative tombstones', () => {
    const reference = formatSharedSavedSecretRefV1('retained-source-reference');
    const settings = { remoteHostsV1: [{ futureCredential: { savedSecretId: reference } }],
      notificationChannelsV1: [{ futureCredential: { savedSecretId: reference } }] };
    expect(listAccountSettingsSavedSecretReferences(settings, reference, { profileRecords: [] })).toHaveLength(2);
    for (const catalogs of [
      { profileRecords: [], remoteHostRecords: null, notificationChannels: null },
      { profileRecords: [], remoteHostRecords: [], notificationChannels: { v: 1 as const, channels: [] } },
    ]) {
      expect(listAccountSettingsSavedSecretReferences(settings, reference, catalogs)).toEqual([]);
    }
    expect(settings.remoteHostsV1).toEqual([{ futureCredential: { savedSecretId: reference } }]);
  });

  it('propagates the exact host tombstone without rewriting retained source bytes during personal promotion', () => {
    const settings = { secrets: [secret], remoteHostsV1: [{ futureCredential: { savedSecretId: secret.id } }],
      notificationChannelsV1: [{ futureCredential: { savedSecretId: secret.id } }] };
    const before = structuredClone(settings);
    const result = promotePersonalSavedSecretReference(settings, { secretId: secret.id, expectedUpdatedAt: secret.updatedAt,
      sharedSecretRef: formatSharedSavedSecretRefV1('promoted-personal') },
      { profileRecords: [], remoteHostRecords: null, notificationChannels: null });
    expect(result).toHaveProperty('remoteHostRecords', null);
    expect(result).toHaveProperty('notificationChannels', null);
    expect(result.settings).toEqual({ ...settings, secrets: [] });
    expect(settings).toEqual(before);
  });

  it('identifies retained SSH credential resources by Account, host identity and slot', () => {
    const source = { kind: 'remote-host-ssh-credential' as const, hostId: 'host-id', slot: 'password' as const };
    const resourceId = savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner', source });
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner', source })).toBe(resourceId);
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'other', source })).not.toBe(resourceId);
    expect(savedSecretOwner.deriveSavedSecretImportResourceIdV1({ accountId: 'owner',
      source: { ...source, slot: 'identityPrivateKey' } })).not.toBe(resourceId);
  });

  it('finds password and identity-key references in the complete opened host inventory', () => {
    const reference = formatSharedSavedSecretRefV1('ssh-reference');
    const catalogs = { profileRecords: [], remoteHostRecords: [{ id: 'host-id', name: 'Build host',
      ssh: { target: 'builder@example.test', authMode: 'password' as const,
        passwordSecretRef: reference, identityPrivateKeySecretRef: reference },
      createdAt: 1, updatedAt: 1, lastUsedAt: null }] };
    expect(listAccountSettingsSavedSecretReferences({}, reference, catalogs)).toEqual([
      { owner: 'remoteHost', path: 'remoteHostRows["host-id"].ssh.passwordSecretRef' },
      { owner: 'remoteHost', path: 'remoteHostRows["host-id"].ssh.identityPrivateKeySecretRef' },
    ]);
    expect(listAccountSettingsSavedSecretReferences({}, formatSharedSavedSecretRefV1('other-reference'), catalogs)).toEqual([]);
  });

  it('refuses a partial or duplicate host inventory instead of permitting secret deletion', () => {
    const reference = formatSharedSavedSecretRefV1('ssh-reference');
    const host = { id: 'host-id', name: 'Build host', ssh: { target: 'builder@example.test', authMode: 'agent' as const },
      createdAt: 1, updatedAt: 1, lastUsedAt: null };
    for (const remoteHostRecords of [[host, host], [{ ...host, ssh: { ...host.ssh, futureCredentialSecretRef: reference } }]]) {
      expect(() => listAccountSettingsSavedSecretReferences({}, reference, { profileRecords: [], remoteHostRecords }))
        .toThrow(AccountSettingsSavedSecretMutationError);
    }
  });
});

const voiceContribution = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'realtime-openai',
});

const voicePurpose = Object.freeze({
  consumer: voiceContribution,
  purpose: 'credential-api-key',
});

const voiceDeclaration = VoiceProviderContributionSchema.parse({
  id: voiceContribution.localId,
  title: 'OpenAI realtime',
  kind: 'conversation',
  roles: ['realtime_conversation'],
  platforms: ['web'],
  capabilities: {
    turn: { cancelResponse: false, bargeIn: false },
  },
  credentials: {
    slot: {
      id: 'api_key',
      purpose: voicePurpose.purpose,
      title: 'API key',
    },
    requirement: { kind: 'always' },
    sources: [{
      kind: 'savedSecret',
      secretKinds: ['apiKey'],
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    }, {
      kind: 'connectedAccount',
      service: { pluginId: 'happier.voice.openai', localId: 'openai' },
      rawGrants: [{
        realm: 'web',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
      }],
    }],
  },
  client: {
    artifactId: 'web-runtime',
    exportName: 'activate',
  },
});

function applyVoiceCredentialSourceMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: Omit<AccountSettingsVoiceCredentialSourceMutation, 'expectedSettingsVersion'>
    & Partial<Pick<AccountSettingsVoiceCredentialSourceMutation, 'expectedSettingsVersion'>>,
): ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation> {
  return applyAccountSettingsVoiceCredentialSourceMutation(settings, {
    ...mutation,
    expectedSettingsVersion: mutation.expectedSettingsVersion ?? 4,
  }, voiceDeclaration);
}

function resolveVoiceCredentialSource(
  settings: Readonly<Record<string, unknown>>,
  machineId: string | null,
): ReturnType<typeof resolveAccountSettingsVoiceCredentialSource> {
  return resolveAccountSettingsVoiceCredentialSource(settings, {
    contribution: voiceContribution,
    credentialSlotId: 'api_key',
    purpose: voicePurpose,
    machineId,
  });
}

const secret = {
  id: 'secret-shared',
  name: 'Shared',
  kind: 'apiKey' as const,
  encryptedValue: {
    _isSecretValue: true as const,
    encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-old' },
  },
  createdAt: 1,
  updatedAt: 1,
  futureSecretMetadata: {
    envelope: { t: 'future', c: 'opaque-target-metadata' },
  },
};

const unrelatedSecret = {
  ...secret,
  id: 'secret-unrelated',
  name: 'Unrelated',
  encryptedValue: {
    _isSecretValue: true as const,
    encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-unrelated' },
  },
};

describe('destination catalog SavedSecret reference ownership', () => {
  it('resolves and replaces the exact Voice purpose from its uncapped destination without a Settings mirror', () => {
    const target = { kind: 'account', account: { service: { pluginId: 'happier.voice.openai', localId: 'openai' }, accountId: 'voice-account' } };
    const unrelated = Array.from({ length: 257 }, (_, index) => ({
      purpose: { consumer: { pluginId: 'happier.fixture', localId: 'voice' }, purpose: `credential-${index}` },
      target,
    }));
    const connectedPurposes = { v: 1, bindings: [{ purpose: voicePurpose, target }, ...unrelated] };
    const catalogs = { profileRecords: [], connectedPurposes };
    const settings = { voiceSettingsV1: { credentialBindings: [{ contribution: voiceContribution, credentialSlotId: 'api_key',
      credentialSource: { kind: 'connectedAccount' }, credentialBindings: {} }], diagnostics: { retained: true } }, preferredLanguage: 'de' };
    const resolved = Reflect.apply(resolveAccountSettingsVoiceCredentialSource, undefined,
      [settings, { contribution: voiceContribution, credentialSlotId: 'api_key', purpose: voicePurpose, machineId: null }, catalogs]);
    expect(resolved.selection).toEqual({ kind: 'connectedAccount', target });
    const result = Reflect.apply(applyAccountSettingsVoiceCredentialSourceMutation, undefined,
      [settings, { contribution: voiceContribution, credentialSlotId: 'api_key', selection: { kind: 'none' }, expectedSettingsVersion: 4 }, voiceDeclaration, catalogs]);
    expect(result.connectedPurposes).toEqual({ v: 1, bindings: unrelated });
    expect(result.settings).not.toHaveProperty('connectedAccountPurposeBindingsV1');
    expect(result.settings.voiceSettingsV1.diagnostics).toEqual({ retained: true });
    expect(result.settings.preferredLanguage).toBe('de');
  });

  it('uses a catalog tombstone as empty authority while an absent catalog keeps its sole raw adapter', () => {
    const settings = { mcpServersSettingsV1: { v: 1, strictMode: false, bindings: [],
      servers: [{ id: 'retained-source', name: 'retained-source', transport: 'http',
        remote: { url: 'https://example.test/mcp', headers: {} },
        env: { TOKEN: { t: 'savedSecret', secretId: secret.id } }, createdAt: 1, updatedAt: 1 }] } };
    expect(listAccountSettingsSavedSecretReferences(settings, secret.id, { profileRecords: [] })).toHaveLength(1);
    expect(Reflect.apply(listAccountSettingsSavedSecretReferences, undefined,
      [settings, secret.id, { profileRecords: [], mcp: null }])).toEqual([]);
  });

  it('rewrites every MCP destination slot atomically and preserves nullable patches and inactive source bytes', () => {
    const reference = { t: 'savedSecret', secretId: secret.id };
    const mcp = { v: 1, servers: [{ id: 'server-a', name: 'server-a', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: { Authorization: reference } },
      env: { TOKEN: reference }, createdAt: 1, updatedAt: 1 }],
      bindings: [{ id: 'binding-a', serverId: 'server-a', enabled: true, target: { t: 'allMachines' },
        overrides: { envPatch: { TOKEN: reference, REMOVED: null }, remote: { headersPatch: { Authorization: reference, Removed: null } } },
        createdAt: 1, updatedAt: 1 }] };
    const settings = { secrets: [secret], mcpServersSettingsV1: { v: 1, strictMode: true,
      servers: [{ ...mcp.servers[0], id: 'retired-source', name: 'retired-source' }], bindings: [] },
      preferredLanguage: 'de' };
    const catalogs = { profileRecords: [], mcp };
    const references = Reflect.apply(listAccountSettingsSavedSecretReferences, undefined, [settings, secret.id, catalogs]);
    expect(references).toHaveLength(4);
    expect(references.every((entry: { owner: string; path: string }) => entry.owner === 'mcp' && entry.path.startsWith('mcpCatalog'))).toBe(true);
    const target = formatSharedSavedSecretRefV1('catalog-secret');
    const rewrite = Reflect.apply(promotePersonalSavedSecretReference, undefined,
      [settings, { secretId: secret.id, expectedUpdatedAt: 1, sharedSecretRef: target }, catalogs]);
    expect(rewrite.settings.mcpServersSettingsV1).toEqual(settings.mcpServersSettingsV1);
    expect(rewrite.settings.preferredLanguage).toBe('de');
    expect(rewrite.mcp.bindings[0].overrides.envPatch.REMOVED).toBeNull();
    expect(rewrite.mcp.bindings[0].overrides.remote.headersPatch.Removed).toBeNull();
    expect(Reflect.apply(listAccountSettingsSavedSecretReferences, undefined,
      [rewrite.settings, secret.id, { ...catalogs, mcp: rewrite.mcp }])).toEqual([]);
    expect(Reflect.apply(listAccountSettingsSavedSecretReferences, undefined,
      [rewrite.settings, target, { ...catalogs, mcp: rewrite.mcp }])).toHaveLength(4);
  });

  it('keeps Account and Machine Provider slots and qualified connected fields in the same complete census', () => {
    const providerConnections = { v: 1, connections: [{ v: 1, id: 'connection.a',
      source: { kind: 'contribution', contributionKey: 'happier.provider.fixture/default' }, role: 'default',
      displayName: 'Fixture', displayNameMode: 'automatic', deployment: { kind: 'external' }, revision: 1, createdAt: 1, updatedAt: 1 }],
      connectionTombstones: [], accountGrants: [], machineGrants: [],
      secretBindingsByConnectionId: { 'connection.a': { account: { api_key: secret.id }, byMachineId: { 'machine.a': { api_key: secret.id } } } },
      manualModelsByConnectionId: {}, modelVisibilityByRef: {}, experimentalBindingConfirmations: [] };
    const connectedConfigurations = { v: 1, entries: [{ service: { pluginId: 'happier.fixture', localId: 'service' },
      modeId: 'api', revision: 'v1', values: { unchanged: 'config' }, secretRefs: { 'api.key': secret.id } }] };
    const catalogs = { profileRecords: [], providerConnections, connectedConfigurations };
    const settings = { secrets: [secret] };
    const target = formatSharedSavedSecretRefV1('mixed-catalog-secret');
    const references = Reflect.apply(listAccountSettingsSavedSecretReferences, undefined, [settings, secret.id, catalogs]);
    expect(references.map((entry: { owner: string }) => entry.owner).sort()).toEqual(['connectedAccountConfiguration', 'provider', 'provider']);
    const rewrite = Reflect.apply(promotePersonalSavedSecretReference, undefined,
      [settings, { secretId: secret.id, expectedUpdatedAt: 1, sharedSecretRef: target }, catalogs]);
    expect(rewrite.providerConnections.secretBindingsByConnectionId['connection.a']).toEqual({
      account: { api_key: target }, byMachineId: { 'machine.a': { api_key: target } } });
    expect(rewrite.connectedConfigurations.entries[0]).toEqual({ ...connectedConfigurations.entries[0], secretRefs: { 'api.key': target } });
    expect(Reflect.apply(listAccountSettingsSavedSecretReferences, undefined,
      [rewrite.settings, target, { ...catalogs, providerConnections: rewrite.providerConnections,
        connectedConfigurations: rewrite.connectedConfigurations }])).toHaveLength(3);
  });
});

describe('classified legacy credential import', () => {
  it.each(['mcp', 'acp', 'providerConnections', 'connectedConfigurations'] as const)(
    'refuses a Profile literal import target already referenced by the captured %s catalog', (owner) => {
      const rawProfile = { id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 2,
        environmentVariables: [{ name: 'TOKEN', value: 'private-literal', isSecret: true }] };
      const record = ProfileRecordV1Schema.parse({ v: 1, id: 'legacy', definition: { kind: 'legacy', profile: rawProfile },
        enabled: true, promptStack: [], secretBindings: {} });
      const sharedSecretRef = formatSharedSavedSecretRefV1('occupied-import');
      const mcp = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'server', name: 'server', transport: 'http',
        remote: { url: 'https://example.test/mcp', headers: {} }, env: { TOKEN: { t: 'savedSecret', secretId: sharedSecretRef } },
        createdAt: 1, updatedAt: 1 }], bindings: [] });
      const acp = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'configured', name: 'configured', title: 'Configured',
        command: 'agent', env: { TOKEN: { t: 'savedSecret', secretId: sharedSecretRef } }, createdAt: 1, updatedAt: 1 }] });
      const providerConnections = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'connection', source: { kind: 'contribution', contributionKey: 'happier.provider.fixture/default' },
          role: 'default', displayName: 'Fixture', displayNameMode: 'automatic', deployment: { kind: 'external' },
          revision: 1, createdAt: 1, updatedAt: 1 }],
        secretBindingsByConnectionId: { connection: { account: { api_key: sharedSecretRef } } } });
      const connectedConfigurations = ConnectedConfigurationCatalogV1Schema.parse({ v: 1, entries: [{
        service: { pluginId: 'happier.fixture', localId: 'service' }, modeId: 'api', revision: 'v1', values: {},
        secretRefs: { 'api.key': sharedSecretRef } }] });
      const destinations = { mcp, acp, providerConnections, connectedConfigurations };
      const catalogs = { profileRecords: [record], mcp: null, acp: null, providerConnections: null,
        connectedConfigurations: null, connectedPurposes: null, [owner]: destinations[owner] };
      const settings = { profiles: [rawProfile], preferredLanguage: 'de' };
      const input = { source: { kind: 'profile-environment-variable' as const, profileId: 'legacy', envName: 'TOKEN' }, sharedSecretRef };
      for (const capture of [catalogs, { ...catalogs, profileRows: [{ record, revision: 4 }] }]) {
        expect(() => savedSecretOwner.promoteProfileEnvironmentVariableSavedSecretReferenceV1(settings, input, capture))
          .toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));
      }
      expect(settings.profiles[0].environmentVariables[0].value).toBe('private-literal');
      expect(record.secretBindings).toEqual({});
    });

  it('uses active destination authority for validation without replacing the retained raw Profile carrier', () => {
    const rawProfile = { id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 2,
      environmentVariables: [{ name: 'TOKEN', value: 'private-literal', isSecret: true }] };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'legacy', definition: { kind: 'legacy', profile: rawProfile },
      enabled: true, promptStack: [], secretBindings: {} });
    const settings = { profiles: [rawProfile], providerSettingsV1: 'superseded-malformed-source', preferredLanguage: 'de' };
    const catalogs = { profileRecords: [record], mcp: null, acp: null,
      providerConnections: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connectedConfigurations: null, connectedPurposes: null };
    const input = { source: { kind: 'profile-environment-variable' as const, profileId: 'legacy', envName: 'TOKEN' },
      sharedSecretRef: formatSharedSavedSecretRefV1('available-import') };
    const result = savedSecretOwner.promoteProfileEnvironmentVariableSavedSecretReferenceV1(settings, input, catalogs);
    expect(result.value).toBe('private-literal');
    expect(result.settings.providerSettingsV1).toBe(settings.providerSettingsV1);
    expect(result.settings.preferredLanguage).toBe('de');
    expect(result.settings.secretBindingsByProfileId).toEqual({ legacy: { TOKEN: input.sharedSecretRef } });
    expect(() => savedSecretOwner.promoteProfileEnvironmentVariableSavedSecretReferenceV1(settings, input,
      { profileRecords: [record] })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
  });

  it('classifies inference credentials separately from personal SavedSecret objects and preserves unknown material', () => {
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ inferenceOpenAIKey: ' exact-private-inference-fixture ' }))
      .toEqual({ secrets: [], complete: true, inferenceCredential: {
        source: { kind: 'legacy-inference-openai-key' }, value: ' exact-private-inference-fixture ',
        displayName: expect.any(String), kind: 'apiKey',
      } });
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ inferenceOpenAIKey: { futureCredential: 'retain-fixture' } }))
      .toEqual({ secrets: [], complete: false });
  });

  it('classifies the original inline legacy Chat envelope without synthesizing a personal SavedSecret record', () => {
    const encryptedValue = { _isSecretValue: true as const,
      encryptedValue: { t: 'enc-v1' as const, c: 'original-chat-ciphertext' } };
    expect(SecretStringV1Schema.safeParse(encryptedValue).success).toBe(true);
    const raw = { voice: { adapters: { local_conversation: { agent: { backend: 'openai_compat',
      openaiCompat: { chatApiKey: encryptedValue, chatBaseUrl: 'https://example.test/chat',
        chatModel: 'chat-model', commitModel: 'commit-model' } } } } }, preferredLanguage: 'de' };
    const before = structuredClone(raw);
    const source = { kind: 'personal-saved-secret' as const, secretId: 'voice:openai_compat:chat_api_key' };
    expect(savedSecretOwner.readSavedSecretTransferSourceV1(raw)).toEqual({ secrets: [], complete: true,
      legacyChatCredential: { source, encryptedValue, displayName: expect.any(String), kind: 'apiKey' } });
    expect(raw).toEqual(before);
    expect(raw).not.toHaveProperty('secrets');
  });

  it('preserves malformed present inline legacy Chat material as an incomplete source', () => {
    for (const chatApiKey of ['unwrapped-chat-material', { futureCredential: 'retain-chat-material' }]) {
      expect(SecretStringV1Schema.safeParse(chatApiKey).success).toBe(false);
      const raw = { voice: { adapters: { local_conversation: { agent: { backend: 'openai_compat',
        openaiCompat: { chatApiKey } } } } } };
      const before = structuredClone(raw);
      expect(savedSecretOwner.readSavedSecretTransferSourceV1(raw)).toEqual({ secrets: [], complete: false });
      expect(raw).toEqual(before);
    }
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ voice: { adapters: { local_conversation: {
      agent: { backend: 'openai_compat', openaiCompat: { chatApiKey: null } },
    } } } })).toEqual({ secrets: [], complete: true });
  });

  it('does not merge inline legacy Chat material with a conflicting personal alias or existing binding', () => {
    const inline = SecretStringV1Schema.parse({ _isSecretValue: true,
      encryptedValue: { t: 'enc-v1', c: 'inline-chat-ciphertext' } });
    const alias = 'voice:openai_compat:chat_api_key';
    const voice = { adapters: { local_conversation: { agent: { backend: 'openai_compat',
      openaiCompat: { chatApiKey: inline } } } } };
    const record = SavedSecretSchema.parse({ id: alias, name: 'Retained personal credential', kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'different-chat-ciphertext' } },
      createdAt: 1, updatedAt: 2 });
    const binding = LegacyVoiceCredentialBindingV1Schema.parse({ providerId: 'openai_compat',
      credentialBindings: { account: { chat_api_key: 'custom-chat-source' } } });
    for (const raw of [
      { secrets: [record], voice },
      { secrets: [{ ...record, id: 'custom-chat-source' }], voice: { ...voice, credentialBindings: [binding] } },
    ]) {
      const before = structuredClone(raw);
      expect(savedSecretOwner.readSavedSecretTransferSourceV1(raw)).toEqual({ secrets: raw.secrets, complete: false });
      expect(raw).toEqual(before);
    }
    const matching = { ...record, encryptedValue: inline };
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ secrets: [matching], voice }))
      .toEqual({ secrets: [matching], complete: true });
    const matchingBoundSource = { ...matching, id: 'custom-chat-source' };
    const boundRaw = { secrets: [matchingBoundSource], voice: { ...voice, credentialBindings: [binding] } };
    const before = structuredClone(boundRaw);
    expect(savedSecretOwner.readSavedSecretTransferSourceV1(boundRaw))
      .toEqual({ secrets: boundRaw.secrets, complete: true });
    expect(boundRaw).toEqual(before);
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ ...boundRaw, secrets: [matchingBoundSource, record] }))
      .toEqual({ secrets: [matchingBoundSource, record], complete: true });
  });

  it('describes an already Shared-bound inline legacy Chat carrier without inventing a personal alias', () => {
    const resourceRef = formatSharedSavedSecretRefV1('original-chat-resource');
    const encryptedValue = SecretStringV1Schema.parse({ _isSecretValue: true,
      encryptedValue: { t: 'enc-v1', c: 'original-chat-ciphertext' } });
    const binding = LegacyVoiceCredentialBindingV1Schema.parse({ providerId: 'openai_compat',
      credentialBindings: { account: { chat_api_key: resourceRef } } });
    const voice = { credentialBindings: [binding], adapters: { local_conversation: { agent: { backend: 'openai_compat',
      openaiCompat: { chatApiKey: encryptedValue } } } } };
    const raw = { voice };
    const before = structuredClone(raw);
    expect(savedSecretOwner.readSavedSecretTransferSourceV1(raw)).toEqual({ secrets: [], complete: true,
      legacyChatCredential: { source: { kind: 'existing-resource-reference', resourceRef }, encryptedValue,
        displayName: expect.any(String), kind: 'apiKey' } });
    expect(raw).toEqual(before);
    const colliding = SavedSecretSchema.parse({ id: resourceRef, name: 'Opaque retained personal source', kind: 'apiKey',
      encryptedValue, createdAt: 1, updatedAt: 2 });
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ voice, secrets: [colliding] }))
      .toEqual({ secrets: [colliding], complete: false });
    const malformed = LegacyVoiceCredentialBindingV1Schema.parse({ ...binding,
      credentialBindings: { account: { chat_api_key: 'happier:shared-secret:v1:' } } });
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ voice: { ...voice, credentialBindings: [malformed] } }))
      .toEqual({ secrets: [], complete: false });
    const unknownBinding = { providerId: 'openai_compat', credentialBindings: { account: {
      chat_api_key: { futureReference: resourceRef },
    } } };
    expect(LegacyVoiceCredentialBindingV1Schema.safeParse(unknownBinding).success).toBe(false);
    expect(savedSecretOwner.readSavedSecretTransferSourceV1({ voice: { ...voice, credentialBindings: [unknownBinding] } }))
      .toEqual({ secrets: [], complete: false });
  });

  it('preserves the exact bare inference credential through a distinct Account/source resource identity', () => {
    const source = { kind: 'legacy-inference-openai-key' };
    const identify = (accountId: string, importSource: unknown = source) => Reflect.apply(
      savedSecretOwner.deriveSavedSecretImportResourceIdV1, undefined, [{ accountId, source: importSource }]);
    const id = identify('account-a');
    expect(identify('account-a')).toBe(id);
    expect(identify('account-b')).not.toBe(id);
    expect(identify('account-a', { kind: 'personal-saved-secret', secretId: 'inferenceOpenAIKey' })).not.toBe(id);
    expect(() => identify('account-a', { ...source, secretId: 'invented' })).toThrow();
    const rewrite = Reflect.get(savedSecretOwner, 'promoteLegacyInferenceSavedSecretReferenceV1');
    expect(typeof rewrite).toBe('function');
    if (typeof rewrite !== 'function') throw new Error('missing_inference_credential_import');
    const raw = { inferenceOpenAIKey: ' exact-private-inference-fixture ', preferredLanguage: 'de',
      voice: { untouched: true }, futurePreference: { opaque: true } };
    const input = { source, sharedSecretRef: `happier:shared-secret:v1:${id}` };
    expect(rewrite(raw, input)).toEqual({ value: raw.inferenceOpenAIKey,
      settings: { preferredLanguage: 'de', voice: raw.voice, futurePreference: raw.futurePreference } });
    expect(raw.inferenceOpenAIKey).toBe(' exact-private-inference-fixture ');
    for (const value of [undefined, null, '', { futureCredential: 'retain-fixture' }]) {
      expect(() => rewrite({ ...raw, inferenceOpenAIKey: value }, input)).toThrow();
    }
    expect(() => rewrite(raw, { ...input, source: { kind: 'personal-saved-secret', secretId: 'inferenceOpenAIKey' } })).toThrow();
  });

  it('rewrites only the exact classified Profile environment carrier and preserves private unrelated bytes', () => {
    const rewrite = 'promoteProfileEnvironmentVariableSavedSecretReferenceV1' in savedSecretOwner
      ? savedSecretOwner.promoteProfileEnvironmentVariableSavedSecretReferenceV1 : undefined;
    expect(typeof rewrite).toBe('function');
    if (typeof rewrite !== 'function') throw new Error('missing_classified_credential_import');
    const sibling = { id: 'untouched', name: 'Untouched', environmentVariables: [], createdAt: 1, updatedAt: 1 };
    const raw = { profiles: [{ id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 2,
      environmentVariables: [{ name: 'TOKEN', value: 'private-literal', isSecret: true },
        { name: 'MODE', value: 'dev' }], opaque: { retained: true } }, sibling],
      machineLogin: { untouched: true }, unknown: { nested: 'private-unrelated' } };
    const result = rewrite(raw, { source: { kind: 'profile-environment-variable', profileId: 'legacy', envName: 'TOKEN' },
      sharedSecretRef: 'happier:shared-secret:v1:imported' });
    expect(result.value).toBe('private-literal');
    expect(result.settings.profiles[0]).toEqual({ ...raw.profiles[0], environmentVariables: [
      { name: 'TOKEN', value: '${TOKEN}', isSecret: true }, { name: 'MODE', value: 'dev' }] });
    expect(result.settings.profiles[1]).toBe(sibling);
    expect(result.settings.machineLogin).toBe(raw.machineLogin);
    expect(result.settings.unknown).toBe(raw.unknown);
    expect(result.settings.secretBindingsByProfileId).toEqual({ legacy: { TOKEN: 'happier:shared-secret:v1:imported' } });
    expect(raw.profiles[0].environmentVariables[0].value).toBe('private-literal');
    expect(() => rewrite({ ...raw, profiles: [raw.profiles[0], raw.profiles[0]] }, {
      source: { kind: 'profile-environment-variable', profileId: 'legacy', envName: 'TOKEN' },
      sharedSecretRef: 'happier:shared-secret:v1:imported' })).toThrow();
    expect(() => rewrite(result.settings, { source: { kind: 'profile-environment-variable', profileId: 'legacy', envName: 'TOKEN' },
      sharedSecretRef: 'happier:shared-secret:v1:other' })).toThrow();
  });
  it('synchronizes the exact staged source carrier without overwriting divergent rows or private attachments', () => {
    const rawProfile = { id: 'legacy', name: 'Legacy', createdAt: 1, updatedAt: 2,
      environmentVariables: [{ name: 'TOKEN', value: 'private-literal', isSecret: true }] };
    const staged = { record: ProfileRecordV1Schema.parse({ v: 1, id: 'legacy',
      definition: { kind: 'legacy', profile: rawProfile }, enabled: false, promptStack: [],
      secretBindings: { OTHER: 'other-personal' } }), revision: 4 };
    const sibling = { record: ProfileRecordV1Schema.parse({ v: 1, id: 'sibling',
      definition: { kind: 'legacy', profile: { id: 'sibling', name: 'Sibling', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
      enabled: true, promptStack: [], secretBindings: {} }), revision: 2 };
    const input = { source: { kind: 'profile-environment-variable' as const, profileId: 'legacy', envName: 'TOKEN' },
      sharedSecretRef: 'happier:shared-secret:v1:imported' };
    const rewrite = savedSecretOwner.promoteProfileEnvironmentVariableSavedSecretReferenceV1;
    const sourceCatalog = { profileRecords: [staged.record, sibling.record], profileRows: [staged, sibling] };
    const result = rewrite({ profiles: [rawProfile] }, input, sourceCatalog);
    expect(result.profileRows?.[0]).toMatchObject({ revision: 4, record: { enabled: false,
      definition: { profile: { environmentVariables: [{ name: 'TOKEN', value: '${TOKEN}', isSecret: true }] } },
      secretBindings: { OTHER: 'other-personal', TOKEN: input.sharedSecretRef } } });
    expect(result.profileRows?.[1]).toBe(sibling);
    expect(staged.record.secretBindings).toEqual({ OTHER: 'other-personal' });
    if (staged.record.definition.kind !== 'legacy') throw new Error('wrong_fixture_definition');
    expect(staged.record.definition.profile.environmentVariables[0]?.value).toBe('private-literal');
    const divergent = { ...staged, record: ProfileRecordV1Schema.parse({ ...staged.record,
      definition: { kind: 'legacy', profile: { ...rawProfile,
        environmentVariables: [{ name: 'TOKEN', value: 'newer-private-literal', isSecret: true }] } } }) };
    expect(() => rewrite({ profiles: [rawProfile] }, input, { ...sourceCatalog,
      profileRecords: [divergent.record], profileRows: [divergent] })).toThrow();
    expect(() => rewrite({ profiles: [rawProfile] }, input, { ...sourceCatalog,
      profileRecords: [staged.record, staged.record], profileRows: [staged, staged] })).toThrow();
    expect(() => rewrite(result.settings, input, sourceCatalog)).toThrow();
  });
  it('derives import identity from Account and encoded stable source identity, never labels or credential values', () => {
    const identify = 'deriveSavedSecretImportResourceIdV1' in savedSecretOwner ? savedSecretOwner.deriveSavedSecretImportResourceIdV1 : undefined;
    expect(typeof identify).toBe('function');
    if (typeof identify !== 'function') throw new Error('missing_saved_secret_import_identity');
    const source = { kind: 'profile-environment-variable', profileId: 'a:b', envName: 'TOKEN' };
    expect(identify({ accountId: 'account-a', source })).toBe(identify({ accountId: 'account-a', source }));
    expect(identify({ accountId: 'account-b', source })).not.toBe(identify({ accountId: 'account-a', source }));
    expect(identify({ accountId: 'account-a', source: { kind: 'profile-environment-variable', profileId: 'a', envName: 'b:TOKEN' } }))
      .not.toBe(identify({ accountId: 'account-a', source }));
    expect(identify({ accountId: 'account-a', source: { kind: 'personal-saved-secret', secretId: 'a:b' } }))
      .not.toBe(identify({ accountId: 'account-a', source }));
  });
});

describe('explicit reached Artifact SavedSecret reference census', () => {
  it('counts effective Artifact defaults and promotes with an Account-private override without editing foreign content', () => {
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'selected' },
      enabled: true, promptStack: [], secretBindings: {} });
    const artifact = { artifactId: 'selected', ownerAccountId: 'foreign-account', access: 'view',
      revision: { headerVersion: 2, bodyVersion: 4 },
      header: { kind: 'launch-profile.v1', profileId: 'p', name: 'Selected' }, body: JSON.stringify({
        kind: 'launch-profile.v1', profile: { id: 'p', name: 'Selected', environmentVariables: [],
          envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }], createdAt: 1, updatedAt: 1 },
        secretBindings: { TOKEN: secret.id },
      }) } satisfies ArtifactSharingResourceV1;
    const unselected = { ...artifact, artifactId: 'unselected' } satisfies ArtifactSharingResourceV1;
    const catalogs = { profileRecords: [record], artifactsById: new Map([['selected', artifact], ['unselected', unselected]]) };
    const raw = { secrets: [secret], opaque: { retained: true } };
    expect(listAccountSettingsSavedSecretReferences(raw, secret.id, catalogs)).toEqual([
      { owner: 'profile', path: 'profileRows.p.secretBindings.TOKEN' },
    ]);
    const promoted = promotePersonalSavedSecretReference(raw, { secretId: secret.id, expectedUpdatedAt: 1,
      sharedSecretRef: 'happier:shared-secret:v1:imported' }, catalogs);
    expect(promoted.profileRecords?.[0]?.secretBindings).toEqual({ TOKEN: 'happier:shared-secret:v1:imported' });
    expect(artifact.body).toContain(secret.id);
    expect(promoted.settings.opaque).toBe(raw.opaque);
    const overridden = { ...catalogs, profileRecords: [{ ...record, secretBindings: { TOKEN: unrelatedSecret.id } }] };
    expect(listAccountSettingsSavedSecretReferences(raw, secret.id, overridden)).toEqual([]);
    expect(() => listAccountSettingsSavedSecretReferences(raw, secret.id,
      { ...catalogs, artifactsById: new Map() })).toThrow();
    const unknown = { ...artifact, body: JSON.stringify({ ...JSON.parse(artifact.body),
      futureSource: { bootstrapCredentialRef: secret.id } }) };
    expect(() => listAccountSettingsSavedSecretReferences(raw, secret.id,
      { ...catalogs, artifactsById: new Map([['selected', unknown]]) })).toThrow();
  });
});

describe('legacy SavedSecret per-item transfer', () => {
  it('moves a recognized source while preserving an unrelated future material entry byte-for-byte', () => {
    const future = { ...secret, id: 'future-secret', encryptedValue: {
      _isSecretValue: true, encryptedValue: { t: 'future-secret-envelope', c: 'opaque-future-material' },
    } };
    const raw = { secrets: [secret, future], secretBindingsByProfileId: { builtin: { TOKEN: secret.id } },
      futurePreference: { retained: true } };
    const promoted = promotePersonalSavedSecretReference(raw, { secretId: secret.id, expectedUpdatedAt: 1,
      sharedSecretRef: 'happier:shared-secret:v1:imported' });
    expect(promoted.settings.secrets).toEqual([future]);
    expect((promoted.settings.secrets as readonly unknown[])[0]).toBe(future);
    expect(promoted.settings.secretBindingsByProfileId).toEqual({ builtin: { TOKEN: 'happier:shared-secret:v1:imported' } });
    expect(promoted.settings.futurePreference).toBe(raw.futurePreference);
    expect(raw.secrets).toEqual([secret, future]);
  });
});

describe('SavedSecret census respects the opened Profile transfer authority', () => {
  it('ignores only superseded Profile source roots after activation and preserves their bytes during a personal promotion', () => {
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'legacy', profile: {
      id: 'p', name: 'Current', environmentVariables: [], createdAt: 1, updatedAt: 1 } },
      enabled: true, promptStack: [], secretBindings: {} });
    const profileControl = ProfileTransferControlV1Schema.parse({ v: 1, phase: 'active', sourceSettingsVersion: 4,
      migratedLogicalRevision: 4, inventory: [{ kind: 'account_row', id: 'p', revision: 2 }] });
    const raw = { secrets: [secret], profiles: [{ id: 'p', futureSource: { bootstrapCredentialRef: secret.id } }],
      secretBindingsByProfileId: { p: { TOKEN: secret.id } }, providerSettingsV1: { v: 1,
        secretBindingsByConnectionId: { pc_a: { account: { api_key: secret.id }, byMachineId: {} } } } };
    const catalogs = { profileRecords: [record], profileControl };
    expect(listAccountSettingsSavedSecretReferences(raw, secret.id, catalogs)).toEqual([
      { owner: 'provider', path: 'providerSettingsV1.secretBindingsByConnectionId.pc_a.account.api_key' },
    ]);
    const promoted = promotePersonalSavedSecretReference(raw, { secretId: secret.id, expectedUpdatedAt: 1,
      sharedSecretRef: 'happier:shared-secret:v1:imported' }, catalogs);
    expect(promoted.settings.profiles).toBe(raw.profiles);
    expect(promoted.settings.secretBindingsByProfileId).toBe(raw.secretBindingsByProfileId);
    expect(promoted.settings.providerSettingsV1).toMatchObject({ secretBindingsByConnectionId: {
      pc_a: { account: { api_key: 'happier:shared-secret:v1:imported' } } } });
    const prepared = { ...catalogs, profileControl: { ...profileControl, phase: 'prepared' as const } };
    expect(listAccountSettingsSavedSecretReferences(raw, secret.id, prepared)).toContainEqual({
      owner: 'unknown', path: 'profiles[0].futureSource.bootstrapCredentialRef' });
    expect(() => promotePersonalSavedSecretReference(raw, { secretId: secret.id, expectedUpdatedAt: 1,
      sharedSecretRef: 'happier:shared-secret:v1:imported' }, prepared)).toThrow();
    const knownRaw = { ...raw, profiles: [] };
    expect(listAccountSettingsSavedSecretReferences(knownRaw, secret.id, prepared)).toContainEqual({
      owner: 'profile', path: 'secretBindingsByProfileId.p.TOKEN' });
  });
});

describe('Voice source mutation resource-use admission', () => {
  const sharedA = formatSharedSavedSecretRefV1('voice-a');
  const sharedB = formatSharedSavedSecretRefV1('voice-b');
  const sharedC = formatSharedSavedSecretRefV1('voice-c');
  const target = { contribution: voiceContribution, credentialSlotId: 'api_key', machineId: null };
  const sourceMutation = { contribution: voiceContribution, credentialSlotId: 'api_key',
    selection: { kind: 'savedSecret' as const }, expectedSettingsVersion: 4 };
  const purposes = { connectedPurposes: { v: 1 as const, bindings: [] } };
  const binding = (kind: 'none' | 'savedSecret' | 'connectedAccount', account?: string, machine?: string) =>
    VoiceCredentialBindingV1Schema.parse({ contribution: voiceContribution, credentialSlotId: 'api_key',
      credentialSource: { kind }, credentialBindings: {
        ...(account ? { account: { api_key: account } } : {}),
        ...(machine ? { byMachineId: { machine: { api_key: machine } } } : {}),
      } });
  const state = (...bindings: ReturnType<typeof binding>[]) => ({ voiceSettingsV1: { credentialBindings: bindings } });
  const project = (current: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>,
    requestedReferences?: readonly string[]): readonly string[] => {
    const owner = Reflect.get(savedSecretOwner, 'listSavedSecretVoiceCredentialMutationReferencesV1');
    expect(typeof owner).toBe('function');
    if (typeof owner !== 'function') throw new Error('missing_voice_resource_use_projection');
    return owner(current, next, { requestedReferences });
  };

  it('binds with only opened purposes and retains user-owned personal secrets and unrelated source bytes', () => {
    const settings = { ...state(binding('none', secret.id)), secrets: [secret],
      profiles: 'unrelated-malformed-source', providerSettingsV1: 'unrelated-malformed-source' };
    const result = savedSecretOwner.applySavedSecretCatalogVoiceCredentialSourceMutationV1(settings, {
      ...sourceMutation, savedSecretMutation: { kind: 'bindVoiceCredentialSavedSecret', target,
        expectedSecretId: secret.id, expectedSecretUpdatedAt: secret.updatedAt, secretId: sharedA },
    }, voiceDeclaration, purposes);
    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.profiles).toBe(settings.profiles);
    expect(result.settings.providerSettingsV1).toBe(settings.providerSettingsV1);
    expect(resolveVoiceCredentialSource(result.settings, null).savedSecret?.secretId).toBe(sharedA);
  });

  it('refuses replacement without full opened catalogs even when no old slot-local secret needs deletion', () => {
    const mutation = { ...sourceMutation, savedSecretMutation: { kind: 'replaceVoiceCredentialSecret' as const,
      target, expectedSecretId: null, expectedSecretUpdatedAt: null, secret: { ...secret, id: 'new-voice-secret' } } };
    expect(() => savedSecretOwner.applySavedSecretCatalogVoiceCredentialSourceMutationV1({}, mutation,
      voiceDeclaration, purposes)).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
    const full = { ...purposes, profileRecords: [], mcp: null, acp: null, providerConnections: null,
      connectedConfigurations: null };
    expect(savedSecretOwner.applySavedSecretCatalogVoiceCredentialSourceMutationV1({}, mutation,
      voiceDeclaration, full).settings.secrets).toEqual([mutation.savedSecretMutation.secret]);
    expect(() => savedSecretOwner.applySavedSecretCatalogVoiceCredentialSourceMutationV1({}, mutation,
      voiceDeclaration, { ...full, profileRecords: [{ invalid: true }] } as never))
      .toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
  });

  it('requires only changed or newly activated next selected shared references, not revoked or unrelated old refs', () => {
    const sibling = VoiceCredentialBindingV1Schema.parse({ ...binding('savedSecret', sharedC), credentialSlotId: 'other',
      credentialBindings: { account: { other: sharedC } } });
    expect(project(state(binding('none', sharedA), sibling), state(binding('savedSecret', sharedA), sibling))).toEqual([sharedA]);
    expect(project(state(binding('savedSecret', sharedA), sibling), state(binding('savedSecret', sharedB), sibling))).toEqual([sharedB]);
    expect(project(state(binding('savedSecret', sharedA)), state(binding('none', sharedA)), [sharedA])).toEqual([]);
    expect(project(state(binding('savedSecret', sharedA)), state(binding('connectedAccount', sharedA)), [sharedA])).toEqual([]);
    expect(project({}, state(binding('savedSecret', sharedA)))).toEqual([sharedA]);
  });

  it('admits requested reselection only for references actually selected next, never dormant or ghost refs', () => {
    const next = state(binding('savedSecret', sharedA, sharedB));
    expect(project(next, next)).toEqual([]);
    expect(project(next, next, [sharedA, sharedB, sharedC, sharedA])).toEqual([sharedA, sharedB]);
    expect(project(state(binding('none', sharedA)), state(binding('none', sharedA)), [sharedA])).toEqual([]);
    expect(project({}, {}, [sharedC])).toEqual([]);
  });

  it('uses exact machine override and account fallback when selected carriers change', () => {
    expect(project(state(binding('savedSecret', sharedA, sharedB)), state(binding('savedSecret', sharedA)))).toEqual([sharedA]);
    expect(project(state(binding('savedSecret', sharedA, sharedB)), state(binding('savedSecret', sharedC, sharedB)))).toEqual([sharedC]);
    expect(project(state(binding('none', sharedA, sharedB)), state(binding('savedSecret', sharedA, sharedB)))).toEqual([sharedA, sharedB]);
  });

  it('fails malformed or duplicate qualified Voice state closed through the canonical typed owner', () => {
    const canonical = binding('savedSecret', sharedA);
    for (const invalid of [{ voiceSettingsV1: null }, state(canonical, canonical),
      { voiceSettingsV1: { credentialBindings: [{ ...canonical, credentialSource: { kind: 'unknown' } }] } }]) {
      expect(() => project({}, invalid)).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
      expect(() => project(invalid, {})).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
    }
  });
});

function referencedSettings(): Record<string, unknown> {
  return {
    secrets: [secret],
    secretBindingsByProfileId: {
      profile_a: { TOKEN: secret.id },
    },
    providerSettingsV1: {
      v: 1,
      secretBindingsByConnectionId: {
        pc_a: {
          account: { api_key: secret.id },
          byMachineId: { machine_a: { token: secret.id } },
        },
      },
    },
    voice: {
      credentialBindings: [{
        providerId: 'openai_compat',
        credentialBindings: { account: { api_key: secret.id } },
      }],
    },
    voiceSettingsV1: {
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          account: { api_key: secret.id },
        },
      }],
    },
    mcpServersSettingsV1: {
      v: 1,
      strictMode: false,
      servers: [{
        id: 'server-a',
        env: {
          TOKEN: { t: 'savedSecret', secretId: secret.id },
          LITERAL: { t: 'literal', v: secret.id },
        },
        remote: {
          headers: {
            Authorization: { t: 'savedSecret', secretId: secret.id },
          },
        },
      }],
      bindings: [{
        id: 'binding-a',
        overrides: {
          envPatch: {
            TOKEN: { t: 'savedSecret', secretId: secret.id },
            REMOVED: null,
          },
          remote: {
            headersPatch: {
              Authorization: { t: 'savedSecret', secretId: secret.id },
            },
          },
        },
      }],
    },
    acpCatalogSettingsV1: {
      v: 2,
      backends: [{
        id: 'backend-a',
        env: { TOKEN: { t: 'savedSecret', secretId: secret.id } },
      }],
    },
    connectedAccountServiceConfigurationsV1: {
      v: 1,
      entries: [
        {
          service: { pluginId: 'plugin.example', localId: 'service-a' },
          modeId: 'token',
          revision: 'configuration-1',
          values: {},
          secretRefs: { api_key: secret.id },
        },
        {
          service: { pluginId: 'plugin.example', localId: 'service-b' },
          modeId: 'token',
          revision: 'configuration-2',
          values: {},
          secretRefs: { api_key: secret.id },
        },
      ],
    },
  };
}

function settingsWithEverySavedSecretReferenceFamily(): Record<string, unknown> {
  const pluginTarget = {
    pluginId: 'acme.notifications',
    localId: 'webhook-token',
  };
  const settings = {
    ...referencedSettings(),
    secrets: [secret, unrelatedSecret],
    pluginSecretBindingsV1: {
      [qualifyPluginAccountSecretBindingKey(pluginTarget)]: {
        ...pluginTarget,
        custody: 'account',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    },
    untouchedFutureRoot: {
      nestedLiteral: secret.id,
    },
  };

  const profileBindings = settings.secretBindingsByProfileId as Record<string, unknown>;
  profileBindings.profile_unrelated = { TOKEN: unrelatedSecret.id };

  const providerSettings = settings.providerSettingsV1 as Record<string, unknown>;
  const providerBindings = providerSettings.secretBindingsByConnectionId as Record<string, unknown>;
  providerBindings.pc_unrelated = { account: { api_key: unrelatedSecret.id } };

  const voice = settings.voice as Record<string, unknown>;
  (voice.credentialBindings as unknown[]).push({
    providerId: 'unrelated',
    credentialBindings: { account: { api_key: unrelatedSecret.id } },
  });

  const voiceV1 = settings.voiceSettingsV1 as Record<string, unknown>;
  (voiceV1.credentialBindings as unknown[]).push({
    contribution: voiceContribution,
    credentialSlotId: 'unrelated',
    credentialSource: { kind: 'savedSecret' },
    credentialBindings: { account: { unrelated: unrelatedSecret.id } },
  });

  const mcp = settings.mcpServersSettingsV1 as Record<string, unknown>;
  (mcp.servers as unknown[]).push({
    id: 'server-unrelated',
    env: { TOKEN: { t: 'savedSecret', secretId: unrelatedSecret.id } },
  });

  const acp = settings.acpCatalogSettingsV1 as Record<string, unknown>;
  (acp.backends as unknown[]).push({
    id: 'backend-unrelated',
    env: { TOKEN: { t: 'savedSecret', secretId: unrelatedSecret.id } },
  });

  const unrelatedPluginTarget = {
    pluginId: 'acme.notifications',
    localId: 'unrelated-token',
  };
  (settings.pluginSecretBindingsV1 as Record<string, unknown>)[
    qualifyPluginAccountSecretBindingKey(unrelatedPluginTarget)
  ] = {
    ...unrelatedPluginTarget,
    custody: 'account',
    savedSecretId: unrelatedSecret.id,
    createdForBinding: false,
  };

  const connectedAccounts = settings.connectedAccountServiceConfigurationsV1 as Record<string, unknown>;
  (connectedAccounts.entries as unknown[]).push({
    service: { pluginId: 'plugin.example', localId: 'service-unrelated' },
    modeId: 'token',
    revision: 'configuration-unrelated',
    values: {},
    secretRefs: { api_key: unrelatedSecret.id },
  });

  return settings;
}

describe('Account Settings SavedSecret mutation owner', () => {
  it('round-trips strict shared refs while preserving opaque legacy personal ids', () => {
    const sharedRef = formatSharedSavedSecretRefV1('resource_01');
    const maxResourceId = 'r'.repeat(256 - 'happier:shared-secret:v1:'.length);

    expect(sharedRef).toBe('happier:shared-secret:v1:resource_01');
    expect(parseSavedSecretRefV1(sharedRef)).toEqual({
      kind: 'shared_resource',
      resourceId: 'resource_01',
    });
    expect(parseSavedSecretRefV1('voice:realtime_elevenlabs:api_key')).toEqual({
      kind: 'personal',
      personalId: 'voice:realtime_elevenlabs:api_key',
    });
    expect(formatSharedSavedSecretRefV1(maxResourceId)).toHaveLength(256);
    expect(parseSavedSecretRefV1(formatSharedSavedSecretRefV1(maxResourceId))).toEqual({
      kind: 'shared_resource',
      resourceId: maxResourceId,
    });
    for (const malformed of [
      '',
      'happier:shared-secret:v1:',
      'happier:shared-secret:v1: resource',
      'happier:shared-secret:v1:resource\u0000',
      `happier:shared-secret:v1:${'r'.repeat(256)}`,
    ]) {
      expect(() => parseSavedSecretRefV1(malformed)).toThrow();
    }
    for (const invalidResourceId of ['', ' resource', 'resource\u007f', `${maxResourceId}r`]) {
      expect(() => formatSharedSavedSecretRefV1(invalidResourceId)).toThrow();
    }
  });

  it('rekeys a colliding legacy personal id before shared-ref activation', () => {
    const collidingPersonalId = formatSharedSavedSecretRefV1('resource_collision');
    const settings = {
      secrets: [{ ...secret, id: collidingPersonalId }],
      secretBindingsByProfileId: {
        profile_a: { TOKEN: collidingPersonalId },
      },
    };

    const result = rekeyPersonalSavedSecret(settings, {
      secretId: collidingPersonalId,
      expectedUpdatedAt: secret.updatedAt,
      newSecretId: 'secret-after-collision-migration',
    });

    expect(result.settings.secrets).toEqual([{
      ...secret,
      id: 'secret-after-collision-migration',
    }]);
    expect(result.settings.secretBindingsByProfileId).toEqual({
      profile_a: { TOKEN: 'secret-after-collision-migration' },
    });
    expect(settings.secrets).toEqual([{ ...secret, id: collidingPersonalId }]);

    const mcp = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'active-server', name: 'active', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} },
      env: { TOKEN: { t: 'savedSecret', secretId: collidingPersonalId } }, createdAt: 1, updatedAt: 1 }], bindings: [] });
    const catalogs = { profileRecords: [], mcp, acp: null, providerConnections: null,
      connectedConfigurations: null, connectedPurposes: null };
    const sourceQualified = rekeyPersonalSavedSecret(settings, { secretId: collidingPersonalId,
      expectedUpdatedAt: secret.updatedAt, newSecretId: 'secret-after-collision-migration' }, catalogs);
    expect(sourceQualified.mcp).toBe(mcp);
    expect(sourceQualified.settings).toEqual(result.settings);
    expect(listAccountSettingsSavedSecretReferences(sourceQualified.settings, collidingPersonalId, catalogs)
      .map(reference => reference.owner)).toEqual(['mcp']);
    expect(savedSecretOwner.listSavedSecretPersonalImportSourceReferencesV1(sourceQualified.settings,
      collidingPersonalId, catalogs)).toEqual([]);
    expect(() => rekeyPersonalSavedSecret({ ...settings,
      futureCatalog: { value: { t: 'savedSecret', secretId: collidingPersonalId } } }, {
      secretId: collidingPersonalId, expectedUpdatedAt: secret.updatedAt, newSecretId: 'repaired-personal-source',
    }, catalogs)).toThrowError(expect.objectContaining({ code: 'saved_secret_ref_collision_migration_required' }));
  });

  it('promotes a proven reserved-prefix personal source without rebinding the same-string active MCP Resource', () => {
    const collidingPersonalId = formatSharedSavedSecretRefV1('retained-collision');
    const retained = { ...secret, id: collidingPersonalId };
    const rawProfile = { id: 'predecessor-profile', name: 'Predecessor', createdAt: 1, updatedAt: 1,
      environmentVariables: [{ name: 'TOKEN', value: '${TOKEN}', isSecret: true }] };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: rawProfile.id,
      definition: { kind: 'legacy', profile: rawProfile }, enabled: true, promptStack: [], secretBindings: {} });
    const mcp = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'active-server', name: 'active', transport: 'http',
      remote: { url: 'https://example.test/mcp', headers: {} },
      env: { TOKEN: { t: 'savedSecret', secretId: collidingPersonalId } }, createdAt: 1, updatedAt: 1 }], bindings: [] });
    const catalogs = { profileRecords: [record], mcp, acp: null, providerConnections: null,
      connectedConfigurations: null, connectedPurposes: null };
    const settings = { secrets: [retained], profiles: [rawProfile],
      secretBindingsByProfileId: { [rawProfile.id]: { TOKEN: collidingPersonalId } } };
    const before = structuredClone(settings);
    const sharedSecretRef = formatSharedSavedSecretRefV1(savedSecretOwner.deriveSavedSecretImportResourceIdV1({
      accountId: 'account', source: { kind: 'personal-saved-secret', secretId: collidingPersonalId },
    }));
    expect(savedSecretOwner.listSavedSecretPersonalImportSourceReferencesV1(settings, collidingPersonalId, catalogs)
      .map(reference => reference.owner)).toEqual(['profile']);
    const result = promotePersonalSavedSecretReference(settings, { secretId: collidingPersonalId,
      expectedUpdatedAt: retained.updatedAt, sharedSecretRef }, catalogs);
    expect(result.settings.secrets).toEqual([]);
    expect(result.settings.secretBindingsByProfileId).toEqual({ [rawProfile.id]: { TOKEN: sharedSecretRef } });
    expect(result.mcp).toBe(mcp);
    expect(listAccountSettingsSavedSecretReferences(result.settings, collidingPersonalId, { ...catalogs, mcp: result.mcp })
      .map(reference => reference.owner)).toEqual(['mcp']);
    expect(savedSecretOwner.listSavedSecretPersonalImportSourceReferencesV1(result.settings, collidingPersonalId,
      { ...catalogs, mcp: result.mcp })).toEqual([]);
    expect(listAccountSettingsSavedSecretReferences(result.settings, sharedSecretRef, catalogs)
      .map(reference => reference.owner)).toEqual(['profile']);
    expect(settings).toEqual(before);
  });

  it.each(['voice', 'plugin'] as const)('refuses ambiguous live %s Shared bindings despite a same-string retained personal source', (owner) => {
    const collidingPersonalId = formatSharedSavedSecretRefV1('ambiguous-live-resource');
    const bound = owner === 'voice'
      ? applyVoiceCredentialSourceMutation({}, { contribution: voiceContribution, credentialSlotId: 'api_key',
        selection: { kind: 'savedSecret' }, savedSecretMutation: { kind: 'bindVoiceCredentialSavedSecret',
          target: { contribution: voiceContribution, credentialSlotId: 'api_key', machineId: null },
          expectedSecretId: null, expectedSecretUpdatedAt: null, secretId: collidingPersonalId } }).settings
      : applyAccountSettingsSavedSecretMutation({}, { kind: 'bindPluginSecret',
        target: { pluginId: 'acme.notifications', localId: 'webhook-token' }, expectedSecretId: null,
        expectedSecretUpdatedAt: null, secretId: collidingPersonalId }).settings;
    const settings = { ...bound, secrets: [{ ...secret, id: collidingPersonalId }] };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'unrelated-profile', definition: { kind: 'legacy',
      profile: { id: 'unrelated-profile', name: 'Unrelated', createdAt: 1, updatedAt: 1, environmentVariables: [] } },
      enabled: true, promptStack: [], secretBindings: {} });
    const catalogs = { profileRecords: [record], mcp: null, acp: null, providerConnections: null,
      connectedConfigurations: null, connectedPurposes: null };
    const before = structuredClone(settings);
    const sharedSecretRef = formatSharedSavedSecretRefV1(savedSecretOwner.deriveSavedSecretImportResourceIdV1({
      accountId: 'account', source: { kind: 'personal-saved-secret', secretId: collidingPersonalId },
    }));
    expect(() => promotePersonalSavedSecretReference(settings, { secretId: collidingPersonalId,
      expectedUpdatedAt: secret.updatedAt, sharedSecretRef }, catalogs))
      .toThrowError(expect.objectContaining({ code: 'saved_secret_ref_collision_migration_required' }));
    expect(() => savedSecretOwner.listSavedSecretPersonalImportSourceReferencesV1(settings, collidingPersonalId, catalogs))
      .toThrowError(expect.objectContaining({ code: 'saved_secret_ref_collision_migration_required' }));
    expect(() => rekeyPersonalSavedSecret(settings, { secretId: collidingPersonalId,
      expectedUpdatedAt: secret.updatedAt, newSecretId: 'repaired-personal-source' }, catalogs))
      .toThrowError(expect.objectContaining({ code: 'saved_secret_ref_collision_migration_required' }));
    expect(settings).toEqual(before);
    expect(listAccountSettingsSavedSecretReferences(settings, collidingPersonalId, catalogs).map(reference => reference.owner))
      .toEqual([owner]);
  });

  it('rekeys the personal record and every recognized reference family without mutating input', () => {
    const settings = settingsWithEverySavedSecretReferenceFamily();
    const before = structuredClone(settings);
    const unrelatedReferences = listAccountSettingsSavedSecretReferences(
      settings,
      unrelatedSecret.id,
    );
    expect(unrelatedReferences.map((reference) => reference.owner)).toEqual([
      'profile',
      'provider',
      'voice',
      'voice',
      'mcp',
      'acp',
      'plugin',
      'connectedAccountConfiguration',
    ]);

    const result = rekeyPersonalSavedSecret(settings, {
      secretId: secret.id,
      expectedUpdatedAt: secret.updatedAt,
      newSecretId: 'secret-rekeyed',
    });

    expect(settings).toEqual(before);
    expect(result.settings).not.toBe(settings);
    expect((result.settings.secrets as readonly typeof secret[])[0]).toEqual({
      ...secret,
      id: 'secret-rekeyed',
    });
    expect(listAccountSettingsSavedSecretReferences(result.settings, secret.id)).toEqual([]);
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, 'secret-rekeyed')
        .map((reference) => reference.owner),
    ).toEqual([
      'profile',
      'provider',
      'provider',
      'voice',
      'voice',
      'mcp',
      'mcp',
      'mcp',
      'mcp',
      'acp',
      'plugin',
      'connectedAccountConfiguration',
      'connectedAccountConfiguration',
    ]);
    expect(result.settings.untouchedFutureRoot).toEqual({ nestedLiteral: secret.id });
    expect(listAccountSettingsSavedSecretReferences(result.settings, unrelatedSecret.id))
      .toEqual(unrelatedReferences);
  });

  it('promotes one personal record by removing it and rewriting all seven reference families', () => {
    const settings = settingsWithEverySavedSecretReferenceFamily();
    const before = structuredClone(settings);
    const sharedSecretRef = 'happier:shared-secret:v1:resource_01';
    const unrelatedReferences = listAccountSettingsSavedSecretReferences(
      settings,
      unrelatedSecret.id,
    );

    const result = promotePersonalSavedSecretReference(settings, {
      secretId: secret.id,
      expectedUpdatedAt: secret.updatedAt,
      sharedSecretRef,
    });

    expect(settings).toEqual(before);
    expect(result.settings.secrets).toEqual([unrelatedSecret]);
    expect(listAccountSettingsSavedSecretReferences(result.settings, secret.id)).toEqual([]);
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, sharedSecretRef)
        .map((reference) => reference.owner),
    ).toEqual([
      'profile',
      'provider',
      'provider',
      'voice',
      'voice',
      'mcp',
      'mcp',
      'mcp',
      'mcp',
      'acp',
      'plugin',
      'connectedAccountConfiguration',
      'connectedAccountConfiguration',
    ]);
    expect(result.settings.untouchedFutureRoot).toEqual({ nestedLiteral: secret.id });
    expect(listAccountSettingsSavedSecretReferences(result.settings, unrelatedSecret.id))
      .toEqual(unrelatedReferences);
  });

  it('blocks promotion while the target shared ref is another personal secret id', () => {
    const settings = settingsWithEverySavedSecretReferenceFamily();
    const sharedSecretRef = formatSharedSavedSecretRefV1('resource_01');
    settings.secrets = [
      ...(settings.secrets as readonly unknown[]),
      { ...unrelatedSecret, id: sharedSecretRef },
    ];
    const before = structuredClone(settings);

    expect(() => promotePersonalSavedSecretReference(settings, {
      secretId: secret.id,
      expectedUpdatedAt: secret.updatedAt,
      sharedSecretRef,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_ref_collision_migration_required',
    }));
    expect(settings).toEqual(before);
  });

  it('requires collision migration for malformed reserved-prefix personal ids', () => {
    const settings = {
      secrets: [{ ...secret, id: 'happier:shared-secret:v1:' }],
    };
    expect(() => promotePersonalSavedSecretReference(settings, {
      secretId: 'happier:shared-secret:v1:',
      expectedUpdatedAt: secret.updatedAt,
      sharedSecretRef: formatSharedSavedSecretRefV1('resource_01'),
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_ref_collision_migration_required',
    }));
  });

  it('fails rekey and promotion closed on stale records, malformed roots, and invalid targets', () => {
    const settings = settingsWithEverySavedSecretReferenceFamily();
    const before = structuredClone(settings);

    for (const operation of [
      () => rekeyPersonalSavedSecret(settings, {
        secretId: secret.id,
        expectedUpdatedAt: 2,
        newSecretId: 'secret-rekeyed',
      }),
      () => promotePersonalSavedSecretReference(settings, {
        secretId: secret.id,
        expectedUpdatedAt: 2,
        sharedSecretRef: 'happier:shared-secret:v1:resource_01',
      }),
    ]) {
      expect(operation).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
        code: 'saved_secret_conflict',
      }));
    }

    expect(() => rekeyPersonalSavedSecret(settings, {
      secretId: secret.id,
      expectedUpdatedAt: 1,
      newSecretId: 'happier:shared-secret:v1:resource_01',
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_invalid',
    }));
    expect(() => promotePersonalSavedSecretReference(settings, {
      secretId: secret.id,
      expectedUpdatedAt: 1,
      sharedSecretRef: 'resource_01',
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_reference_invalid',
    }));

    const malformed = {
      ...settings,
      mcpServersSettingsV1: {
        ...(settings.mcpServersSettingsV1 as Record<string, unknown>),
        servers: [{ id: 'broken', env: { TOKEN: { t: 'unknown', secretId: secret.id } } }],
      },
    };
    const malformedBefore = structuredClone(malformed);
    expect(() => rekeyPersonalSavedSecret(malformed, {
      secretId: secret.id,
      expectedUpdatedAt: 1,
      newSecretId: 'secret-rekeyed',
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_reference_invalid',
    }));
    expect(malformed).toEqual(malformedBefore);
    expect(settings).toEqual(before);
  });

  it.each([
    {
      kind: 'unbindAndDelete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    },
    {
      kind: 'replaceConnectedAccountConfigurationSecret',
      target: {
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        fieldId: 'api_key',
      },
      expectedConfigurationRevision: 'configuration-1',
      expectedSecretId: secret.id,
      secret: {
        ...secret,
        id: 'secret-retired-operation',
        updatedAt: 2,
      },
    },
  ])('fails the retired $kind mutation closed before settings changes', (mutation) => {
    const settings = referencedSettings();
    const before = structuredClone(settings);

    expect(() => applyAccountSettingsSavedSecretMutation(
      settings,
      mutation as never,
    )).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_invalid',
    }));
    expect(settings).toEqual(before);
  });

  it('enumerates every current canonical reference family and rejects referenced deletion typed', () => {
    const settings = referencedSettings();

    expect(
      listAccountSettingsSavedSecretReferences(settings, secret.id)
        .map((reference) => reference.owner),
    ).toEqual([
      'profile',
      'provider',
      'provider',
      'voice',
      'voice',
      'mcp',
      'mcp',
      'mcp',
      'mcp',
      'acp',
      'connectedAccountConfiguration',
      'connectedAccountConfiguration',
    ]);

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_in_use',
    }));
  });

  it('deletes the exact SavedSecret after every canonical owner has unbound it', () => {
    const result = applyAccountSettingsSavedSecretMutation({
      secrets: [secret],
      untouchedFutureRoot: { value: 'preserve-me' },
    }, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    });

    expect(result.settings).toEqual({
      secrets: [],
      untouchedFutureRoot: { value: 'preserve-me' },
    });
  });

  it('erases one plugin binding set through the canonical census without deleting shared or user-owned SavedSecrets', () => {
    const orphan = { ...secret, id: 'secret-plugin-orphan', name: 'Plugin orphan' };
    const shared = { ...secret, id: 'secret-plugin-shared', name: 'Shared with sibling' };
    const userOwned = { ...secret, id: 'secret-user-owned', name: 'Selected by user' };
    const siblingOwned = { ...secret, id: 'secret-sibling-owned', name: 'Sibling-owned' };
    const settings = {
      secrets: [orphan, shared, userOwned, siblingOwned],
      pluginSecretBindingsV1: {
        '["acme.erase","account","first"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'first',
          savedSecretId: orphan.id,
          createdForBinding: true,
        },
        '["acme.erase","account","second"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'second',
          savedSecretId: orphan.id,
          createdForBinding: false,
        },
        '["acme.erase","account","shared"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'shared',
          savedSecretId: shared.id,
          createdForBinding: true,
        },
        '["acme.erase","account","selected"]': {
          pluginId: 'acme.erase',
          custody: 'account',
          localId: 'selected',
          savedSecretId: userOwned.id,
          createdForBinding: false,
        },
        '["sibling.plugin","account","shared"]': {
          pluginId: 'sibling.plugin',
          custody: 'account',
          localId: 'shared',
          savedSecretId: shared.id,
          createdForBinding: false,
        },
        '["sibling.plugin","account","owned"]': {
          pluginId: 'sibling.plugin',
          custody: 'account',
          localId: 'owned',
          savedSecretId: siblingOwned.id,
          createdForBinding: true,
        },
      },
      untouchedFutureRoot: { preserve: true },
    };

    const result = eraseAccountSettingsPluginSecretBindings(settings, 'acme.erase');

    expect(result.removedBindingCount).toBe(4);
    expect(result.removedSavedSecretCount).toBe(1);
    expect((result.settings.secrets as Array<{ id: string }>).map(({ id }) => id))
      .toEqual([shared.id, userOwned.id, siblingOwned.id]);
    expect(result.settings.pluginSecretBindingsV1).toEqual({
      '["sibling.plugin","account","owned"]': {
        pluginId: 'sibling.plugin',
        custody: 'account',
        localId: 'owned',
        savedSecretId: siblingOwned.id,
        createdForBinding: true,
      },
      '["sibling.plugin","account","shared"]': {
        pluginId: 'sibling.plugin',
        custody: 'account',
        localId: 'shared',
        savedSecretId: shared.id,
        createdForBinding: false,
      },
    });
    expect(result.settings.untouchedFutureRoot).toEqual({ preserve: true });
  });

  it('atomically binds a declared Account plugin secret and keeps its selected SavedSecret reference-safe', () => {
    const settings = {
      secrets: [secret],
      untouchedFutureRoot: { value: 'preserve-me' },
    };

    const bound = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindPluginSecret',
      target: {
        pluginId: 'acme.notifications',
        localId: 'webhook-token',
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    });

    expect(bound.settings.pluginSecretBindingsV1).toEqual({
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    });
    expect(JSON.stringify(bound.settings.pluginSecretBindingsV1)).not.toContain('ciphertext-old');
    expect(bound.settings.untouchedFutureRoot).toEqual({ value: 'preserve-me' });

    expect(() => applyAccountSettingsSavedSecretMutation(bound.settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_in_use',
      references: [{
        owner: 'plugin',
        path: 'pluginSecretBindingsV1["[\\"acme.notifications\\",\\"account\\",\\"webhook-token\\"]"]',
      }],
    }));
  });

  it('unbinds a plugin secret without deleting its SavedSecret record', () => {
    const settings = {
      secrets: [secret],
      pluginSecretBindingsV1: {
        '["acme.notifications","account","webhook-token"]': {
          pluginId: 'acme.notifications',
          custody: 'account',
          localId: 'webhook-token',
          savedSecretId: secret.id,
          createdForBinding: true,
        },
      },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'unbindPluginSecret',
      target: {
        pluginId: 'acme.notifications',
        localId: 'webhook-token',
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
    });

    expect(result.settings.pluginSecretBindingsV1).toBeUndefined();
    expect((result.settings.secrets as readonly { id: string }[]).map(({ id }) => id))
      .toEqual([secret.id]);
  });

  it('rejects generic replacement with the stable typed result while a Connected Account configuration references the secret', () => {
    const untouchedSibling = {
      ...secret,
      id: 'secret-untouched',
      name: 'Untouched',
      futureSecretMetadata: {
        envelope: { t: 'future', c: 'opaque-secret-metadata' },
      },
    };
    const settings = {
      ...referencedSettings(),
      secrets: [secret, untouchedSibling],
      untouchedFutureSibling: {
        envelope: { t: 'future', c: 'opaque-byte-for-byte' },
      },
    };
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'rotateGlobal',
      secretId: secret.id,
      expectedUpdatedAt: 1,
      encryptedValue: {
        _isSecretValue: true,
        encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
      },
      updatedAt: 2,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_referenced_by_connected_account_configuration',
      references: [
        {
          owner: 'connectedAccountConfiguration',
          path: 'connectedAccountServiceConfigurationsV1.entries[0].secretRefs.api_key',
        },
        {
          owner: 'connectedAccountConfiguration',
          path: 'connectedAccountServiceConfigurationsV1.entries[1].secretRefs.api_key',
        },
      ],
    }));
    expect(settings.secrets).toEqual([secret, untouchedSibling]);
    expect(
      (
        settings.connectedAccountServiceConfigurationsV1 as {
          entries: Array<{ revision: string }>;
        }
      ).entries.map((entry) => entry.revision),
    ).toEqual(['configuration-1', 'configuration-2']);
  });

  it('preserves generic replacement for non-Connected-Account reference owners', () => {
    const settings = referencedSettings();
    const {
      connectedAccountServiceConfigurationsV1: _connectedAccountConfigurations,
      ...withoutConnectedAccountConfigurations
    } = settings;
    const result = applyAccountSettingsSavedSecretMutation(
      withoutConnectedAccountConfigurations,
      {
        kind: 'rotateGlobal',
        secretId: secret.id,
        expectedUpdatedAt: 1,
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
        },
        updatedAt: 2,
      },
    );

    expect(result.settings.secrets).toEqual([
      {
        ...secret,
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-new' },
        },
        updatedAt: 2,
      },
    ]);
  });

  it('target-locally creates and rebinds one Voice secret while preserving a shared sibling', () => {
    const result = applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      secret: {
        ...secret,
        id: 'secret-voice-target-local',
        name: 'Voice target local',
        encryptedValue: {
          _isSecretValue: true,
          encryptedValue: { t: 'enc-v1', c: 'ciphertext-voice-target-local' },
        },
        createdAt: 2,
        updatedAt: 2,
      },
      approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
    });

    expect((result.settings.secrets as Array<{ id: string }>).map(({ id }) => id))
      .toEqual(['secret-voice-target-local', secret.id]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
        credentialBindings: {
          account: { api_key: 'secret-voice-target-local' },
        },
      }],
    });
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, secret.id)
        .map((reference) => reference.owner),
    ).toContain('profile');
    expect(
      listAccountSettingsSavedSecretReferences(result.settings, secret.id)
        .filter((reference) => reference.owner === 'voice'),
    ).toHaveLength(1);
  });

  it('atomically saves and selects one qualified Voice SavedSecret without activating a mismatched target', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: {
            account: { api_key: secret.id },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: voicePurpose,
          target: {
            kind: 'account',
            account: {
              service: { pluginId: 'happier.voice.openai', localId: 'openai' },
              accountId: 'account-openai',
            },
          },
        }],
      },
      untouchedFutureRoot: { value: 'preserve-me' },
    };
    const before = structuredClone(settings);
    const replacement = {
      ...secret,
      id: 'secret-openai-next',
      name: 'OpenAI next',
      updatedAt: 2,
    };

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: { ...voiceContribution, localId: 'other-voice' },
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 1,
        secret: replacement,
      },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 0,
        secret: replacement,
      },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));
    expect(settings).toEqual(before);

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'replaceVoiceCredentialSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: secret.id,
        expectedSecretUpdatedAt: 1,
        secret: replacement,
      },
    });

    expect(result.settings).toMatchObject({
      secrets: [{ id: replacement.id }],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: replacement.id },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
      untouchedFutureRoot: { value: 'preserve-me' },
    });
  });

  it('selects a Connected Account while preserving dormant secrets and exact unrelated purpose bindings', () => {
    const unrelatedPurpose = {
      consumer: { pluginId: 'happier.voice.other', localId: 'conversation' },
      purpose: 'credential',
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: secret.id },
            byMachineId: { machine_a: { api_key: secret.id } },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: unrelatedPurpose,
          target: {
            kind: 'group',
            service: { pluginId: 'happier.voice.other', localId: 'service' },
            groupId: 'other-group',
          },
        }],
      },
    };
    const selectedTarget = {
      kind: 'account',
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai-next',
      },
    };

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'connectedAccount', target: selectedTarget },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: {
          account: { api_key: secret.id },
          byMachineId: { machine_a: { api_key: secret.id } },
        },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [
        { purpose: unrelatedPurpose, target: settings.connectedAccountPurposeBindingsV1.bindings[0]!.target },
        { purpose: voicePurpose, target: selectedTarget },
      ],
    });
  });

  it('refuses a Team resource as a Voice source, and keeps an Agent Team default it shares the document with', () => {
    const voiceService = { pluginId: 'happier.voice.openai', localId: 'openai' };
    const teamSelection = {
      source: 'team_resource' as const,
      resourceId: 'resource-1',
      deliveryMode: 'direct' as const,
      disclosedMember: { service: voiceService, accountId: 'source-member' },
    };
    // The purpose target union is `account | group` (lane 10 child 02 :271):
    // a Team resource is not a Voice source at the writer.
    expect(() => applyVoiceCredentialSourceMutation({ secrets: [secret] }, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: {
        kind: 'connectedAccount',
        target: { kind: 'team_resource', service: voiceService, teamId: 'team-acme', selection: teamSelection },
      } as never,
    })).toThrow(expect.objectContaining({ code: 'saved_secret_invalid' }));

    // An earlier 0.3 build could persist it as a Voice purpose target; it
    // reads forward as a Team selection, which Voice never resolves.
    const storedTeamSelection = {
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: {}, byMachineId: {} },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: voicePurpose,
          target: { kind: 'team_resource', service: voiceService, teamId: 'team-acme', selection: teamSelection },
        }],
      },
    };
    expect(() => resolveVoiceCredentialSource(storedTeamSelection, null))
      .toThrow(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));

    // A Voice write keeps the Agent's Team default in the shared document.
    const agentTeamDefault = {
      purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'model-openai' },
      teamId: 'team-acme',
      selection: { source: 'team_resource' as const, resourceId: 'resource-2', deliveryMode: 'brokered' as const },
    };
    const result = applyVoiceCredentialSourceMutation({
      secrets: [secret],
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [], teamResourceSelections: [agentTeamDefault] },
    }, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: {
        kind: 'connectedAccount',
        target: { kind: 'account', account: { service: voiceService, accountId: 'account-openai' } },
      },
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toMatchObject({
      teamResourceSelections: [agentTeamDefault],
    });
  });

  it('keeps a standalone qualified secret edit dormant under the active Connected Account selection', () => {
    const selectedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: selectedTarget }],
      },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      secret: {
        ...secret,
        id: 'secret-dormant-next',
        updatedAt: 2,
      },
    });

    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: { api_key: 'secret-dormant-next' } },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual(
      settings.connectedAccountPurposeBindingsV1,
    );
  });

  it('selects none by removing only the effective purpose binding while preserving dormant values', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{
          purpose: voicePurpose,
          target: {
            kind: 'group',
            service: { pluginId: 'happier.voice.openai', localId: 'openai' },
            groupId: 'openai-group',
          },
        }],
      },
    };

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'none' },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        credentialSource: { kind: 'none' },
        credentialBindings: { account: { api_key: secret.id } },
      }],
    });
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
  });

  it('resolves a selected qualified SavedSecret by exact machine with account fallback and ignores overrides for null', () => {
    const settings = {
      secrets: [
        { ...secret, id: 'secret-account' },
        { ...secret, id: 'secret-machine' },
      ],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: {
            account: { api_key: 'secret-account' },
            byMachineId: { machine_a: { api_key: 'secret-machine' } },
          },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(resolveVoiceCredentialSource(settings, 'machine_a')).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-machine', source: 'machine_override' },
    });
    expect(resolveVoiceCredentialSource(settings, 'machine_b')).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-account', source: 'account' },
    });
    expect(resolveVoiceCredentialSource(settings, null)).toMatchObject({
      selection: { kind: 'savedSecret' },
      savedSecret: { secretId: 'secret-account', source: 'account' },
    });
  });

  it('reactivates a dormant SavedSecret by selection only without changing its identity', () => {
    const selectedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'connectedAccount' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: selectedTarget }],
      },
    };

    expect(resolveVoiceCredentialSource(settings, null)).toEqual({
      selection: { kind: 'connectedAccount', target: selectedTarget },
      binding: { purpose: voicePurpose, target: selectedTarget },
      savedSecret: null,
      approvedRecipientContractDigest: null,
    });

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('binds an existing SavedSecret to an unbound Voice slot atomically with its purpose binding', () => {
    const orphanedTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
        accountId: 'account-openai',
      },
    };
    // The binding row was lost while the SavedSecret record survived, and the
    // purpose binding it left behind is exactly the cross-store inconsistency
    // the resolver fails closed on.
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: {
        v: 1,
        bindings: [{ purpose: voicePurpose, target: orphanedTarget }],
      },
    };
    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining<AccountSettingsSavedSecretMutationError>({
        code: 'saved_secret_reference_invalid',
      }),
    );

    const result = applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      savedSecretMutation: {
        kind: 'bindVoiceCredentialSavedSecret',
        target: {
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          machineId: null,
        },
        expectedSecretId: null,
        expectedSecretUpdatedAt: null,
        secretId: secret.id,
      },
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(result.settings.connectedAccountPurposeBindingsV1).toEqual({
      v: 1,
      bindings: [],
    });
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('re-points a bound Voice slot at another existing SavedSecret without deleting either record', () => {
    const other = { ...secret, id: 'secret-other', name: 'Other', updatedAt: 3 };
    const settings = {
      secrets: [secret, other],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
      secretId: other.id,
    });

    expect(result.settings.secrets).toEqual([secret, other]);
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: other.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('repairs a Voice slot that still points at a destroyed SavedSecret record', () => {
    // The exact state a binding-loss event leaves behind: the slot keeps its
    // reference while the record it names is gone, so every CAS the surface can
    // build carries `expectedSecretUpdatedAt: null`.
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'secret-destroyed' } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    });

    expect(result.settings.secrets).toEqual([secret]);
    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: secret.id, source: 'account' },
      approvedRecipientContractDigest: null,
    });

    // The assertion is checked, not waived: the same call conflicts once the
    // named record is present, because the caller read a different snapshot.
    expect(() => applyAccountSettingsSavedSecretMutation({
      ...settings,
      secrets: [secret, { ...secret, id: 'secret-destroyed', updatedAt: 9 }],
    }, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secretId: secret.id,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));
  });

  it('replaces the key of a Voice slot that still points at a destroyed SavedSecret record', () => {
    const settings = {
      secrets: [] as unknown[],
      voiceSettingsV1: {
        credentialBindings: [{
          contribution: voiceContribution,
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'secret-destroyed' } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    const result = applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'secret-destroyed',
      expectedSecretUpdatedAt: null,
      secret: { ...secret, id: 'secret-reentered', updatedAt: 7 },
    });

    expect(resolveVoiceCredentialSource(result.settings, null)).toEqual({
      selection: { kind: 'savedSecret' },
      binding: null,
      savedSecret: { secretId: 'secret-reentered', source: 'account' },
      approvedRecipientContractDigest: null,
    });
  });

  it('fails an existing-SavedSecret binding closed for an unknown secret id and a stale source', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secretId: 'secret-that-does-not-exist',
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_not_found',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: secret.updatedAt,
      secretId: secret.id,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(settings.voiceSettingsV1.credentialBindings).toEqual([]);
  });

  it('rejects SavedSecret selection after that source leaves the current declaration', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const withoutSavedSecret = VoiceProviderContributionSchema.parse({
      ...voiceDeclaration,
      credentials: {
        ...voiceDeclaration.credentials!,
        sources: voiceDeclaration.credentials!.sources.filter((source) => (
          source.kind !== 'savedSecret'
        )),
      },
    });

    expect(() => applyAccountSettingsVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 4,
      selection: { kind: 'savedSecret' },
    }, withoutSavedSecret)).toThrowError(expect.objectContaining({
      code: 'saved_secret_invalid',
    }));
    expect(settings.voiceSettingsV1.credentialBindings).toEqual([]);
  });

  it('rejects retired Voice identity dimensions on current qualified mutation and resolution inputs', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
      purpose: voicePurpose,
      providerId: 'realtime_openai',
      settingsKey: 'voice',
    } as never)).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(() => resolveAccountSettingsVoiceCredentialSource(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      purpose: voicePurpose,
      machineId: null,
      providerId: 'realtime_openai',
      settingsKey: 'voice',
    } as never)).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);
  });

  it('keeps a legacy provider-id row reference-enumerable but rejects it at current qualified boundaries', () => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: {
        credentialBindings: [{
          providerId: 'realtime_openai',
          credentialBindings: { account: { api_key: secret.id } },
        }],
      },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };

    expect(listAccountSettingsSavedSecretReferences(settings, secret.id)).toEqual([{
      owner: 'voice',
      path: 'voiceSettingsV1.credentialBindings[0].credentialBindings.account.api_key',
    }]);
    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining({ code: 'saved_secret_reference_invalid' }),
    );
    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
  });

  it.each([
    {
      name: 'an unknown retired providerId field',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        providerId: 'realtime_openai',
      },
    },
    {
      name: 'an unknown retired settingsKey field',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        settingsKey: 'voice',
      },
    },
    {
      name: 'a malformed dormant slot map',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {
          account: { api_key: secret.id },
          byMachineId: { dormant_machine: { dormant_slot: 42 } },
        },
      },
    },
    {
      name: 'a noncanonical recipient-contract digest',
      binding: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: { account: { api_key: secret.id } },
        approvedRecipientContractDigest: 'recipient-contract-not-canonical',
      },
    },
  ])('rejects $name at both current qualified owner boundaries', ({ binding }) => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [binding] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => resolveVoiceCredentialSource(settings, null)).toThrowError(
      expect.objectContaining({ code: 'saved_secret_reference_invalid' }),
    );
    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
    expect(settings).toEqual(before);
  });

  it('rejects a noncanonical recipient-contract digest on a current qualified approval mutation', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: 'recipient-contract-not-canonical',
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
  });

  it('renews one Voice recipient approval without replacing or exposing its SavedSecret', () => {
    const before = referencedSettings();
    const renewedDigest = `sha256:${'c'.repeat(64)}`;
    const result = applyAccountSettingsSavedSecretMutation(before, {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: renewedDigest,
    });

    expect(result.settings.secrets).toEqual(before.secrets);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        approvedRecipientContractDigest: renewedDigest,
        credentialBindings: {
          account: { api_key: secret.id },
        },
      }],
    });
  });

  it('persists, approves, and unbinds a strict shared Voice ref without inventing a personal record', () => {
    const sharedRef = formatSharedSavedSecretRefV1('resource-voice');
    const before = referencedSettings();
    const bound = applyAccountSettingsSavedSecretMutation(before, {
      kind: 'bindVoiceCredentialSavedSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
      secretId: sharedRef,
    });
    const approved = applyAccountSettingsSavedSecretMutation(bound.settings, {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: sharedRef,
      expectedSecretUpdatedAt: 7,
      approvedRecipientContractDigest: `sha256:${'e'.repeat(64)}`,
    });
    const removed = applyAccountSettingsSavedSecretMutation(approved.settings, {
      kind: 'removeVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: sharedRef,
      expectedSecretUpdatedAt: 7,
    });

    expect(bound.settings.secrets).toEqual(before.secrets);
    expect(approved.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        approvedRecipientContractDigest: `sha256:${'e'.repeat(64)}`,
        credentialBindings: { account: { api_key: sharedRef } },
      }],
    });
    expect(removed.settings.secrets).toEqual(before.secrets);
    expect(resolveAccountSettingsVoiceCredentialSecret(removed.settings, {
      contribution: voiceContribution,
      credentialSlotId: 'api_key',
      machineId: null,
    }).reference).toBeNull();
  });

  it('binds and unbinds a strict shared plugin ref without inventing a personal record', () => {
    const sharedRef = formatSharedSavedSecretRefV1('resource-plugin');
    const target = { pluginId: 'acme.notifications', localId: 'webhook-token' };
    const before = { secrets: [secret] };

    const bound = applyAccountSettingsSavedSecretMutation(before, {
      kind: 'bindPluginSecret',
      target,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secretId: sharedRef,
    });

    expect(bound.settings.secrets).toEqual(before.secrets);
    expect(resolveAccountSettingsPluginSecretBinding(bound.settings, target)).toEqual({
      pluginId: target.pluginId,
      custody: 'account',
      localId: target.localId,
      savedSecretId: sharedRef,
      createdForBinding: false,
    });
    expect(() => resolveAccountSettingsPluginSecret(bound.settings, target)).toThrow();

    const unbound = applyAccountSettingsSavedSecretMutation(bound.settings, {
      kind: 'unbindPluginSecret',
      target,
      expectedSecretId: sharedRef,
      expectedSecretUpdatedAt: null,
    });
    expect(resolveAccountSettingsPluginSecretBinding(unbound.settings, target)).toBeNull();
    expect(unbound.settings.secrets).toEqual(before.secrets);
  });

  it('rejects Voice recipient approval when the bound SavedSecret changed concurrently', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'approveVoiceCredentialRecipientContract',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 0,
      approvedRecipientContractDigest: `sha256:${'d'.repeat(64)}`,
    })).toThrow(expect.objectContaining({
      code: 'saved_secret_conflict',
    }));
  });

  it('atomically removes one Voice binding and deletes its secret only when no sibling still references it', () => {
    const exclusive = {
      ...referencedSettings(),
      secretBindingsByProfileId: {},
      providerSettingsV1: { v: 1, secretBindingsByConnectionId: {} },
      voice: { credentialBindings: [] },
      mcpServersSettingsV1: { v: 1, servers: [], bindings: [] },
      acpCatalogSettingsV1: { v: 2, backends: [] },
      connectedAccountServiceConfigurationsV1: { v: 1, entries: [] },
    };
    const result = applyAccountSettingsSavedSecretMutation(exclusive, {
      kind: 'removeVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 1,
    });

    expect(result.settings.secrets).toEqual([]);
    expect(result.settings.voiceSettingsV1).toMatchObject({
      credentialBindings: [{
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'savedSecret' },
        credentialBindings: {},
      }],
    });
  });

  it('rejects a stale Voice target before creating or deleting any SavedSecret', () => {
    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      secret: {
        ...secret,
        id: 'secret-must-not-be-created',
        updatedAt: 2,
      },
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'replaceVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: secret.id,
      expectedSecretUpdatedAt: 0,
      secret: {
        ...secret,
        id: 'secret-must-not-rebind-a-rotated-source',
        updatedAt: 2,
      },
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));

    expect(() => applyAccountSettingsSavedSecretMutation(referencedSettings(), {
      kind: 'removeVoiceCredentialSecret',
      target: {
        contribution: voiceContribution,
        credentialSlotId: 'api_key',
        machineId: null,
      },
      expectedSecretId: 'stale-secret',
      expectedSecretUpdatedAt: 1,
    })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_conflict',
    }));
  });

  it('does not treat unrelated equal strings or literal refs as SavedSecret references', () => {
    const settings = {
      secrets: [secret],
      label: secret.id,
      mcpServersSettingsV1: {
        servers: [{
          env: {
            LITERAL: { t: 'literal', v: secret.id },
          },
        }],
      },
    };
    expect(listAccountSettingsSavedSecretReferences(settings, secret.id)).toEqual([]);
  });

  it('fails deletion closed for every malformed-present canonical reference root', () => {
    const malformedSettings = [
      { secretBindingsByProfileId: [] },
      { providerSettingsV1: { secretBindingsByConnectionId: [] } },
      { voice: { credentialBindings: {} } },
      { voiceSettingsV1: { credentialBindings: {} } },
      { mcpServersSettingsV1: { servers: {}, bindings: [] } },
      { acpCatalogSettingsV1: { backends: {} } },
    ];
    for (const malformed of malformedSettings) {
      expect(() => applyAccountSettingsSavedSecretMutation({
        secrets: [secret],
        unknownFutureRoot: { value: secret.id },
        ...malformed,
      }, {
        kind: 'delete',
        secretId: secret.id,
        expectedUpdatedAt: 1,
      })).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
        code: 'saved_secret_reference_invalid',
      }));
    }
  });

  it.each([
    ['wrong custody', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'machine',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    }],
    ['extra entry field', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
        future: true,
      },
    }],
    ['noncanonical qualified key', {
      'acme.notifications/account/webhook-token': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: secret.id,
        createdForBinding: false,
      },
    }],
    ['more than 256 bindings', Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => {
        const localId = `field-${index}`;
        return [
          JSON.stringify(['acme.notifications', 'account', localId]),
          {
            pluginId: 'acme.notifications',
            custody: 'account',
            localId,
            savedSecretId: secret.id,
            createdForBinding: false,
          },
        ];
      }),
    )],
    ['more than 64 KiB', {
      '["acme.notifications","account","webhook-token"]': {
        pluginId: 'acme.notifications',
        custody: 'account',
        localId: 'webhook-token',
        savedSecretId: 'x'.repeat((64 * 1024) + 1),
        createdForBinding: false,
      },
    }],
  ])('fails every plugin binding consumer closed for malformed present bindings: %s', (_label, bindings) => {
    const settings = {
      secrets: [secret],
      pluginSecretBindingsV1: bindings,
      untouchedFutureRoot: { preserve: true },
    };
    const before = structuredClone(settings);
    const expectedError = expect.objectContaining({
      code: 'saved_secret_reference_invalid',
    });

    expect(() => listAccountSettingsSavedSecretReferences(settings, secret.id))
      .toThrowError(expectedError);
    expect(() => resolveAccountSettingsPluginSecret(settings, {
      pluginId: 'acme.notifications',
      localId: 'webhook-token',
    })).toThrowError(expectedError);
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete',
      secretId: secret.id,
      expectedUpdatedAt: 1,
    })).toThrowError(expectedError);
    expect(settings).toEqual(before);
  });

  it.each([
    ['extra root key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
      future: true,
    }],
    ['extra entry key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
        future: true,
      }],
    }],
    ['more than 256 entries', {
      v: 1,
      entries: Array.from({ length: 257 }, (_, index) => ({
        service: { pluginId: 'plugin.example', localId: `service-${index}` },
        modeId: 'token',
        revision: `configuration-${index}`,
        values: {},
        secretRefs: { api_key: secret.id },
      })),
    }],
    ['duplicate service and mode target', {
      v: 1,
      entries: [1, 2].map((revision) => ({
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: `configuration-${revision}`,
        values: {},
        secretRefs: { api_key: secret.id },
      })),
    }],
    ['malformed service identity', {
      v: 1,
      entries: [{
        service: { pluginId: '', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['malformed mode identity', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'x'.repeat(257),
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['extra service identity key', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a', future: true },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['malformed revision', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: '',
        values: {},
        secretRefs: { api_key: secret.id },
      }],
    }],
    ['non-string SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: 7 },
      }],
    }],
    ['empty SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: '' },
      }],
    }],
    ['oversized SavedSecret reference', {
      v: 1,
      entries: [{
        service: { pluginId: 'plugin.example', localId: 'service-a' },
        modeId: 'token',
        revision: 'configuration-1',
        values: {},
        secretRefs: { api_key: 'x'.repeat(513) },
      }],
    }],
  ])('rejects malformed Connected Account reference roots through the persisted owner: %s', (_label, root) => {
    expect(() => listAccountSettingsSavedSecretReferences({
      connectedAccountServiceConfigurationsV1: root,
    }, secret.id)).toThrowError(expect.objectContaining<AccountSettingsSavedSecretMutationError>({
      code: 'saved_secret_reference_invalid',
    }));
  });

  it('enumerates Connected Account references above the former private member ceiling', () => {
    const secretRefs = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field${index}`,
        index === 64 ? secret.id : `secret-${index}`,
      ]),
    );

    expect(listAccountSettingsSavedSecretReferences({
      connectedAccountServiceConfigurationsV1: {
        v: 1,
        entries: [{
          service: { pluginId: 'plugin.example', localId: 'service-a' },
          modeId: 'token',
          revision: 'configuration-1',
          values: {},
          secretRefs,
        }],
      },
    }, secret.id)).toEqual([{
      owner: 'connectedAccountConfiguration',
      path: 'connectedAccountServiceConfigurationsV1.entries[0].secretRefs.field64',
    }]);
  });

  it.each([
    'api key',
    '__proto__',
    'A'.repeat(129),
  ])('rejects invalid qualified Voice credential slot key %s through the canonical schema', (credentialSlotId) => {
    const settings = {
      secrets: [secret],
      voiceSettingsV1: { credentialBindings: [] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
    };
    const before = structuredClone(settings);

    expect(() => applyVoiceCredentialSourceMutation(settings, {
      contribution: voiceContribution,
      credentialSlotId,
      selection: { kind: 'savedSecret' },
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_invalid' }));
    expect(settings).toEqual(before);
  });

});

describe('SavedSecret complete reference census', () => {
  const secret = {
    id: 'secret-inline', name: 'Inline', kind: 'token' as const,
    encryptedValue: { _isSecretValue: true as const, value: 'private-value' },
    createdAt: 1, updatedAt: 2,
  };

  it('keeps historical built-in bindings in the promotion transaction', () => {
    const settings = {
      secrets: [secret],
      secretBindingsByProfileId: { openai: { API_KEY: secret.id } },
    };
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete', secretId: secret.id, expectedUpdatedAt: 2,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_in_use' }));
    expect(listAccountSettingsSavedSecretReferences(settings, secret.id)).toEqual([
      { owner: 'profile', path: 'secretBindingsByProfileId.openai.API_KEY' },
    ]);
    const target = formatSharedSavedSecretRefV1('resource-inline');
    const result = promotePersonalSavedSecretReference(settings, {
      secretId: secret.id, expectedUpdatedAt: 2, sharedSecretRef: target,
    });
    expect(result.settings).toEqual({
      secrets: [],
      secretBindingsByProfileId: { openai: { API_KEY: target } },
    });
  });

  it('censuses the complete opened Profile row inventory through the same reference owner', () => {
    const record = ProfileRecordV1Schema.parse({
      v: 1, id: 'profile-private', definition: { kind: 'artifact', artifactId: 'artifact-profile' },
      enabled: true, promptStack: [], secretBindings: { TOKEN: secret.id },
    });
    const artifactsById = new Map([['artifact-profile', { artifactId: 'artifact-profile', access: 'owner' as const,
      revision: { headerVersion: 1, bodyVersion: 1 }, header: { kind: 'launch-profile.v1', profileId: 'profile-private', name: 'Private' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: { id: 'profile-private', name: 'Private', environmentVariables: [],
        createdAt: 1, updatedAt: 1 }, secretBindings: {} }),
    }]]);
    expect(listAccountSettingsSavedSecretReferences({ secrets: [secret] }, secret.id, {
      profileRecords: [record], artifactsById,
    })).toEqual([{ owner: 'profile', path: 'profileRows["profile-private"].secretBindings.TOKEN' }]);
    const other = ProfileRecordV1Schema.parse({ ...record, id: 'other-profile', secretBindings: {},
      definition: { kind: 'legacy', profile: { id: 'other-profile', name: 'Other', environmentVariables: [], createdAt: 1, updatedAt: 1 } } });
    const promoted = promotePersonalSavedSecretReference({
      secrets: [secret], secretBindingsByProfileId: { 'openai': { API_KEY: secret.id } },
    }, { secretId: secret.id, expectedUpdatedAt: 2, sharedSecretRef: formatSharedSavedSecretRefV1('resource') }, {
      profileRecords: [record, other], artifactsById,
    });
    expect(promoted.profileRecords?.[0]?.secretBindings.TOKEN).toBe(formatSharedSavedSecretRefV1('resource'));
    expect(promoted.profileRecords?.[1]).toBe(other);
    expect(listAccountSettingsSavedSecretReferences(promoted.settings, secret.id, {
      profileRecords: promoted.profileRecords ?? [], artifactsById,
    })).toEqual([]);
    expect(record.secretBindings.TOKEN).toBe(secret.id);
  });

  it.each([
    { futureCatalog: { value: { t: 'savedSecret', secretId: secret.id } } },
    { futureCatalog: { secretRefs: { credential: secret.id } } },
    { providerSettingsV1: { futureCredential: { savedSecretId: secret.id } } },
    { profiles: [{ id: 'future-profile', secretBindings: { TOKEN: secret.id } }] },
  ])('refuses deleting or promoting material with an unknown reference owner', (carrier) => {
    const settings = {
      secrets: [secret], secretBindingsByProfileId: { openai: { TOKEN: secret.id } }, ...carrier,
    };
    expect(() => applyAccountSettingsSavedSecretMutation(settings, {
      kind: 'delete', secretId: secret.id, expectedUpdatedAt: 2,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_in_use' }));
    expect(() => promotePersonalSavedSecretReference(settings, {
      secretId: secret.id, expectedUpdatedAt: 2, sharedSecretRef: formatSharedSavedSecretRefV1('resource'),
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_reference_invalid' }));
    expect(settings.secrets).toEqual([secret]);
  });
});

describe('SavedSecret collection capacity', () => {
  function savedSecretAt(index: number) {
    return {
      id: `secret-${index}`,
      name: `Secret ${index}`,
      kind: 'apiKey' as const,
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: `ciphertext-${index}` },
      },
      createdAt: 1,
      updatedAt: 1,
    };
  }

  const fullCollection = Array.from(
    { length: SAVED_SECRET_COLLECTION_MAX_ENTRIES },
    (_unused, index) => savedSecretAt(index),
  );

  it('refuses an add that would push the collection past what canonical parsing exposes', () => {
    // Accepting the 257th entry persists a record the canonical reader
    // truncates away, so a previously valid Provider secret silently stops
    // resolving at spawn. Refuse the write instead.
    expect(() => applyAccountSettingsSavedSecretMutation(
      { secrets: fullCollection },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    )).toThrowError(expect.objectContaining({
      code: 'saved_secret_collection_full',
    }));
    // Stored reads preserve predecessor collections beyond today's new-write
    // budget. Refusing growth must not hide the already-stored entries.
    const oversized = [...fullCollection, savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES)];
    expect(accountSettingsParse({ secrets: oversized }).secrets.length)
      .toBe(oversized.length);
  });

  it('accepts an add that exactly reaches the collection maximum', () => {
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: fullCollection.slice(0, SAVED_SECRET_COLLECTION_MAX_ENTRIES - 1) },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
    // Every entry this owner accepts must survive the canonical Account
    // Settings parse. Comparing the two ends of the contract catches a ceiling
    // that drifts apart from the reader's; comparing either one to the shared
    // constant it is built from cannot.
    expect(accountSettingsParse(result.settings).secrets.length).toBe(written.length);
  });

  it('still allows a delete to recover an already oversized collection', () => {
    const oversized = [...fullCollection, savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES)];
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: oversized },
      { kind: 'delete', secretId: 'secret-0', expectedUpdatedAt: 1 },
    );
    expect((result.settings.secrets as readonly unknown[]).length)
      .toBe(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
  });

  function largeSavedSecretAt(index: number) {
    return {
      ...savedSecretAt(index),
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: `${index}-${'c'.repeat(3000)}` },
      },
    };
  }

  function secretsRootBytes(secrets: readonly unknown[]): number {
    return new TextEncoder().encode(JSON.stringify(secrets)).byteLength;
  }

  /**
   * The largest collection whose serialized root still fits the Account
   * ceiling, plus the entry that would push it past. Derived by measuring the
   * real serialization rather than by assuming an entry size.
   */
  const nearByteCeiling = (() => {
    const kept: ReturnType<typeof largeSavedSecretAt>[] = [];
    for (let index = 0; index < SAVED_SECRET_COLLECTION_MAX_ENTRIES; index += 1) {
      const candidate = largeSavedSecretAt(index);
      if (secretsRootBytes([...kept, candidate]) > ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES) {
        return { kept, crossing: candidate };
      }
      kept.push(candidate);
    }
    throw new Error('Fixture never reached the SavedSecret byte ceiling');
  })();

  it('refuses an add past the new-write byte ceiling while preserving oversized stored collections', () => {
    // Preconditions: the starting collection is well inside the cardinality
    // limit and fully visible, so a refusal here cannot be the entry-count
    // guard firing instead.
    expect(nearByteCeiling.kept.length).toBeLessThan(SAVED_SECRET_COLLECTION_MAX_ENTRIES);
    expect(accountSettingsParse({ secrets: nearByteCeiling.kept }).secrets.length)
      .toBe(nearByteCeiling.kept.length);

    expect(() => applyAccountSettingsSavedSecretMutation(
      { secrets: nearByteCeiling.kept },
      { kind: 'add', secret: nearByteCeiling.crossing },
    )).toThrowError(expect.objectContaining({
      code: 'saved_secret_collection_full',
    }));

    // A read budget must never turn a valid predecessor collection into empty
    // data. The same oversized value is still readable after write admission
    // refuses increasing a smaller collection past the current budget.
    const oversized = [...nearByteCeiling.kept, nearByteCeiling.crossing];
    expect(secretsRootBytes(oversized)).toBeGreaterThan(ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES);
    expect(accountSettingsParse({ secrets: oversized }).secrets.length).toBe(oversized.length);
  });

  it('accepts an add that keeps the collection inside the byte ceiling', () => {
    const base = nearByteCeiling.kept.slice(0, nearByteCeiling.kept.length - 1);
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: base },
      { kind: 'add', secret: savedSecretAt(SAVED_SECRET_COLLECTION_MAX_ENTRIES) },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(base.length + 1);
    expect(accountSettingsParse(result.settings).secrets.length).toBe(written.length);
  });

  it('still allows a delete to recover a collection that is already past the byte ceiling', () => {
    const oversized = [...nearByteCeiling.kept, nearByteCeiling.crossing];
    const result = applyAccountSettingsSavedSecretMutation(
      { secrets: oversized },
      { kind: 'delete', secretId: 'secret-0', expectedUpdatedAt: 1 },
    );
    const written = result.settings.secrets as readonly unknown[];
    expect(written.length).toBe(oversized.length - 1);
    expect(secretsRootBytes(written)).toBeLessThan(secretsRootBytes(oversized));
  });
});
