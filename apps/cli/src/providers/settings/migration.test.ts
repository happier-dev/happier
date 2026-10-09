import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import * as persistenceBoundary from '@/persistence';
import { getHistoricalBuiltInAiLaunchProfileV1 } from '@happier-dev/protocol/profiles/historicalCompatibilityV1';
import { buildLegacyProfileMigrationContext } from '../migrations/buildContext';
import { readLegacyProfileMigrationContributionMap } from '../migrations/coordinator';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileRecordV1Schema, ProfileProviderConversionMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { LegacyProfileReviewedMappingV1Schema } from '@happier-dev/protocol/providers/migrations/legacyProfilesV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
  ProviderConnectionsCatalogV1Schema, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AuthoringMemoryMutationRequestV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRecordV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createLegacyProfileMigrationSourceFingerprintV1,
  type ProviderAccountSettingsMigrationContextV1,
  ProviderConnectionIdSchema,
  ProviderContributionV1Schema,
} from '@happier-dev/protocol';

import {
  confirmLegacyProfileMigration,
  migrateProviderSettings,
  previewLegacyProfileMigration,
  prepareLegacyProfileMigrationSource,
} from './migration';

function migrationParams(connectionId: string) {
  return {
    deriveContext: () => context(connectionId),
    acquireRegistryLease: async () => ({ registry: { generation: 'test' }, release: async () => undefined }),
  } as const;
}

function credentials(): StoredCredentials {
  return { token: `header.${Buffer.from(JSON.stringify({ sub: 'migration-account' })).toString('base64url')}.signature`, encryption: null };
}
const sharedSecretRef = formatSharedSavedSecretRefV1('secret-a');
const retainedPrivateSecretRef = formatSharedSavedSecretRefV1('secret-private');
const cacheBoundary = { resolveCachePath: () => '/unused/provider-migration-cache', writeCache: async () => undefined };

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function context(connectionId: string): ProviderAccountSettingsMigrationContextV1 {
  return {
    migratedAt: 20,
    pendingCustomProfileIds: [],
    candidates: [{
      kind: 'connection',
      sourceProfileId: 'deepseek',
      connection: {
        v: 1,
        id: ProviderConnectionIdSchema.parse(connectionId),
        source: { kind: 'contribution', contributionKey: 'happier.deepseek/deepseek' },
        role: 'default',
        displayName: 'DeepSeek',
        displayNameMode: 'automatic',
        deployment: { kind: 'external' },
        revision: 0,
        createdAt: 20,
        updatedAt: 20,
      },
    }],
  };
}

function guidedReviewedMapping() {
  return {
    connection: {
      v: 1 as const, id: ProviderConnectionIdSchema.parse('pc-company'),
      source: { kind: 'custom' as const, template: {
        v: 1 as const, name: 'Company', endpointTemplates: [{
          id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://company.example/v1',
          capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const, statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const },
        }], catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
      } },
      role: 'named' as const, displayName: 'Company', displayNameMode: 'custom' as const,
      deployment: { kind: 'external' as const },
      revision: 0, createdAt: 1, updatedAt: 1,
    },
    credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [],
  };
}

function guidedRawProfile() {
  return {
    profiles: [{ id: 'company', name: 'Company', environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://company.example/v1' }], createdAt: 1, updatedAt: 1 }],
  };
}

function credentialSourceContribution() {
  return ProviderContributionV1Schema.parse({ v: 1, id: 'deepseek', name: 'DeepSeek', kind: 'frontier',
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://provider.test',
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['openai-chat'], uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
    catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [{ id: 'model', name: 'Model' }] }, legacyProfileMigrations: [{ sourceProfileId: 'deepseek',
      credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
      migratedEnvironmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }], retainedEnvironmentVariables: [] }] });
}

type Conversion = ReturnType<typeof ProfileProviderConversionMutationV1Schema.parse>;
type ProfileRecord = ReturnType<typeof ProfileRecordV1Schema.parse>;

/** The incumbent HTTP transport is the boundary; catalog readers, capture and CAS stay real. */
function installMigrationAccount(input: Readonly<{
  raw: Record<string, unknown>; version?: number; selected?: string | null;
  rows?: readonly ProfileRecord[]; transferActive?: boolean;
}>) {
  const state = {
    raw: input.raw, version: input.version ?? 7, selected: input.selected ?? null, memoryRevision: 1,
    catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 as ProviderConnectionsCatalogV1, providerRevision: 1,
    rows: (input.rows ?? []).map(row => ({ id: row.id, revision: 2, content: { t: 'plain' as const, v: row } })),
    writes: [] as Conversion[], events: [] as string[], interruptClear: false,
    conversion: undefined as ((mutation: Conversion) => Promise<unknown>) | undefined,
  };
  const control = input.transferActive ? { status: 'present' as const, revision: 4, content: { t: 'plain' as const, v: {
    v: 1, phase: 'active', sourceSettingsVersion: 5, migratedLogicalRevision: 1,
    inventory: state.rows.map(row => ({ kind: 'account_row', id: row.id, revision: row.revision })),
  } } } : { status: 'absent' as const };
  const guard = state.rows.length > 0 ? 9 : 'absent';
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(state.raw), rawSettings: state.raw,
    settingsVersion: state.version, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials()) });
  vi.mocked(axios.get).mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: { mode: 'plain', version: 1, settingsVersion: state.version, signingKeyFingerprint: null, contentKeyFingerprint: null,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' }, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: state.version, content: { t: 'plain', v: state.raw } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200,
      data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [] }) };
    if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200,
      data: { status: 'present', revision: state.providerRevision, content: { t: 'plain', v: state.catalog } } };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`
      || path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`
      || path === ACP_CATALOG_ROWS_ROUTE_V1 || path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
      || path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 || path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1
      || path === NOTIFICATION_CHANNELS_ROUTE_V1 || path === REMOTE_HOST_ROWS_ROUTE_V1) {
      return { status: 200, data: { status: 'absent' } };
    }
    if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: guard } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: control };
    if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: {
      status: 'listed', rows: state.rows, complete: true, nextCursor: null, diagnostics: [], referenceGuardRevision: guard, transferControl: control,
    } };
    if (path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: {
      status: 'present', revision: state.memoryRevision, content: { t: 'plain', v: state.selected },
    } };
    if (path.endsWith('/saved-secrets/resources/materials')) return { status: 200, data: { resources: ['secret-a', 'secret-private'].map(resourceId => ({
      resourceId, encryptionMode: 'plain', recipientEnvelope: null,
      storedContent: { t: 'plain', v: { v: 1, name: 'Private credential', kind: 'apiKey', value: 'fixture-only-value' } },
      entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner', name: 'Private credential',
        ownerAccountId: 'migration-account', kind: 'apiKey', encryptionMode: 'plain', revision: resourceId === 'secret-a' ? 3 : 6, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
    })) } };
    throw new Error(`Unexpected migration Account read: ${path}`);
  });
  const commit = (mutation: Conversion) => {
    if (mutation.expectedSettingsVersion !== state.version) return { status: 'settings-conflict', revision: state.version };
    if (mutation.providerMutation.expectedRevision !== state.providerRevision) return { status: 'provider-conflict', revision: state.providerRevision };
    if (mutation.nextSettings?.t !== 'plain' || mutation.providerMutation.content?.t !== 'plain') throw new Error('plain Account fixture requires explicit plain envelopes');
    state.raw = mutation.nextSettings.v;
    state.catalog = ProviderConnectionsCatalogV1Schema.parse(mutation.providerMutation.content.v);
    state.version += 1; state.providerRevision += 1;
    const rows = mutation.mutations.map(row => ({ id: row.id, revision: Number(row.expectedRevision) + 1, content: row.content }));
    for (const row of rows) {
      const index = state.rows.findIndex(candidate => candidate.id === row.id);
      if (index >= 0 && row.content?.t === 'plain') state.rows[index] = { ...row, content: { t: 'plain', v: ProfileRecordV1Schema.parse(row.content.v) } };
    }
    return { status: 'updated', settingsVersion: state.version, providerRevision: state.providerRevision, rows, referenceGuardRevision: guard };
  };
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === PROFILE_PROVIDER_CONVERSION_ROUTE_V1) {
      const mutation = ProfileProviderConversionMutationV1Schema.parse(body);
      state.writes.push(mutation); state.events.push('conversion');
      return { status: 200, data: state.conversion ? await state.conversion(mutation) : commit(mutation) };
    }
    if (path.endsWith('/authoring-memory/lastUsedProfile')) {
      const mutation = AuthoringMemoryMutationRequestV1Schema.parse(body);
      state.events.push('memory');
      if (state.interruptClear) { state.interruptClear = false; throw new Error('Interrupted after catalog committed'); }
      if (mutation.expectedRevision !== state.memoryRevision) return { status: 200, data: { status: 'conflict', revision: state.memoryRevision } };
      if (mutation.content?.t !== 'plain' || (mutation.content.v !== null && typeof mutation.content.v !== 'string')) throw new Error('invalid lastUsedProfile fixture');
      state.selected = mutation.content.v; state.memoryRevision += 1;
      return { status: 200, data: { status: 'updated', revision: state.memoryRevision, cursor: state.memoryRevision } };
    }
    throw new Error(`Unexpected migration Account write: ${path}`);
  });
  return { state, commit };
}

describe('migrateProviderSettings', () => {
  beforeEach(() => {
    vi.spyOn(axios, 'get');
    vi.spyOn(persistenceBoundary, 'readStoredCredentials').mockResolvedValue(credentials());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }), { status: 200 }));
    installMigrationAccount({ raw: { profiles: [] }, version: 1 });
  });
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
  it('prepares only the exact captured legacy source with accepted credential descriptors and retains private attachments', async () => {
    const raw = { ...guidedRawProfile(), profiles: [{ ...guidedRawProfile().profiles[0],
      environmentVariables: [{ name: 'TEAM_FLAG', value: 'public' }, { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }] }],
      secretBindingsByProfileId: { company: { DEEPSEEK_AUTH_TOKEN: sharedSecretRef } },
      profileEnabledById: { company: false },
      promptStacksV1: { v: 1, surfaces: { profilesById: { company: [{ id: 'private-stack',
        ref: { kind: 'doc', artifactId: 'private-document' }, enabled: true, placement: 'system_append' }] } } },
    };
    const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => String(url).endsWith('/v2/account/settings')
      ? { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } }
      : baselineGet(url, options));
    const definition = credentialSourceContribution();
    let released = 0;
    const acquireRegistryLease = async () => ({ registry: { contributes: {
      providersByContributionKey: new Map([['happier.provider.deepseek/deepseek', { definition }]]) } },
      release: async () => { released += 1; } });
    const result = await prepareLegacyProfileMigrationSource({ credentials: credentials(), expectedSettingsVersion: 7, acquireRegistryLease });
    expect(result).toMatchObject({ status: 'ready', settingsVersion: 7, records: [{ id: 'company', enabled: false,
      promptStack: raw.promptStacksV1.surfaces.profilesById.company, secretBindings: { DEEPSEEK_AUTH_TOKEN: sharedSecretRef },
      definition: { kind: 'legacy', profile: { environmentVariables: raw.profiles[0]?.environmentVariables } } }] });
    expect(result).not.toHaveProperty('raw');
    await expect(prepareLegacyProfileMigrationSource({ credentials: credentials(), expectedSettingsVersion: 6, acquireRegistryLease }))
      .rejects.toMatchObject({ reason: 'legacy_profile_source_changed' });
    expect(released).toBe(2);
  });
  it('promotes a descriptor-classified literal before preparing transferable records', async () => {
    const capturedCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature` };
    const remoteHostCatalog = RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{ id: 'host', name: 'Private host',
      createdAt: 1, updatedAt: 1, lastUsedAt: null,
      ssh: { target: 'user@host.example', authMode: 'password', passwordSecretRef: sharedSecretRef } }] });
    const notificationCatalog = NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, id: 'webhook',
      kind: 'webhook', url: 'https://notification.example/hook', signingSecretRef: retainedPrivateSecretRef, topics: {} }] });
    let raw: Record<string, unknown> = { profiles: [{ id: 'company', name: 'Company', environmentVariables: [
      { name: 'DEEPSEEK_AUTH_TOKEN', value: 'private-literal' }, { name: 'TEAM_FLAG', value: 'public' }], createdAt: 1, updatedAt: 1 }], unknown: { keep: true } };
    let version = 7;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), settingsVersion: version,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(capturedCredentials) });
    // Credential persistence and HTTP are genuine boundaries; admission, crypto and migration stay real.
    vi.spyOn(persistenceBoundary, 'readStoredCredentials').mockResolvedValue(capturedCredentials);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }), { status: 200 }));
    const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === REMOTE_HOST_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 8,
        content: { t: 'plain', v: remoteHostCatalog } } };
      if (path === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 9,
        content: { t: 'plain', v: notificationCatalog } } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { version, content: { t: 'plain', v: raw } } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: version, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (String(url).endsWith('/saved-secrets/resources/materials')) return { status: 200, data: { resources: ['secret-a', 'secret-private'].map(resourceId => ({
        resourceId, encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: { t: 'plain', v: { v: 1, name: 'Retained credential', kind: 'apiKey', value: 'retained-private' } },
        entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
          ownerAccountId: 'account-a', name: 'Retained credential', kind: 'apiKey', encryptionMode: 'plain',
          revision: resourceId === 'secret-a' ? 3 : 6, materialStatus: 'ready',
          capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      })) } };
      return baselineGet(url, options);
    });
    const mutations: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
      mutations.push(mutation);
      if (mutation.nextSettings?.t !== 'plain') throw new Error('plain Account requires plain Settings');
      raw = mutation.nextSettings.v;
      version += 1;
      return { status: 200, data: { resourceId: mutation.resourceId, settingsVersion: version } };
    });
    const result = await prepareLegacyProfileMigrationSource({ credentials: capturedCredentials, expectedSettingsVersion: 7,
      acquireRegistryLease: async () => ({ registry: { contributes: { providersByContributionKey: new Map([
        ['happier.provider.deepseek/deepseek', { definition: credentialSourceContribution() }]]) } }, release: async () => undefined }) });
    expect(result).toMatchObject({ status: 'ready', settingsVersion: 8, records: [{ id: 'company', definition: { kind: 'legacy',
      profile: { environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, { name: 'TEAM_FLAG', value: 'public' }] } } }] });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ expectedSettingsVersion: 7, encryptionMode: 'plain', storedContent: { t: 'plain', v: { value: 'private-literal' } },
      referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
        catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 1, connectedConfigurations: 'absent', connectedPurposes: 'absent' },
        remoteHosts: { revision: 8, resourceRefs: [sharedSecretRef] },
        notificationChannels: { revision: 9, resourceRefs: [retainedPrivateSecretRef] } },
      profileMutations: [] });
    expect(JSON.stringify(result)).not.toContain('private-literal');
    expect(raw.unknown).toEqual({ keep: true });
  });
  it('preserves disabled ordinary builtin preferences while converting a different private Provider profile', async () => {
    const providerRow = ProfileRecordV1Schema.parse({ v: 1, id: 'deepseek', enabled: true,
      definition: { kind: 'legacy', profile: { id: 'deepseek', name: 'My Provider profile', environmentVariables: [
        { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, { name: 'API_TIMEOUT_MS', value: '600000' }], createdAt: 1, updatedAt: 1 } },
      promptStack: [], secretBindings: { DEEPSEEK_AUTH_TOKEN: sharedSecretRef } });
    const control = { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, phase: 'active',
      sourceSettingsVersion: 5, migratedLogicalRevision: 1, inventory: [
        { kind: 'account_row', id: 'deepseek', revision: 3 }] } } };
    const raw = { profileEnabledById: { anthropic: false }, unknown: { keep: true } };
    const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 9 } };
      if (path.endsWith('/profiles/transfer')) return { status: 200, data: control };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', complete: true,
        nextCursor: null, diagnostics: [], referenceGuardRevision: 9, transferControl: control,
        rows: [{ id: 'deepseek', revision: 3, content: { t: 'plain', v: providerRow } }] } };
      if (path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: null } } };
      return baselineGet(url, options);
    });
    const writes: ReturnType<typeof ProfileProviderConversionMutationV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const mutation = ProfileProviderConversionMutationV1Schema.parse(body);
      writes.push(mutation);
      return { status: 200, data: { status: 'updated', settingsVersion: 8, providerRevision: 2, referenceGuardRevision: 10,
        rows: mutation.mutations.map(row => ({ id: row.id, revision: Number(row.expectedRevision) + 1, content: row.content })) } };
    });
    const baseDefinition = credentialSourceContribution();
    const definition = ProviderContributionV1Schema.parse({ ...baseDefinition, legacyProfileMigrations: [{
      ...baseDefinition.legacyProfileMigrations?.[0], retainedEnvironmentVariables: [{ name: 'API_TIMEOUT_MS', value: '600000' }],
    }] });
    const result = await migrateProviderSettings({ credentials: credentials(),
      acquireRegistryLease: async () => ({ registry: { contributes: { providersByContributionKey: new Map([
        ['happier.provider.deepseek/deepseek', { definition }]]) } }, release: async () => undefined }),
      deriveContext: (latestRawSettings, acceptedRegistry, providerSettings) => buildLegacyProfileMigrationContext({ rawSettings: latestRawSettings, providerSettings,
        authoringMemory: { lastUsedProfile: null }, providersByContributionKey: readLegacyProfileMigrationContributionMap(acceptedRegistry),
        allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-deepseek' }, migratedAt: 20, processEnv: {} }),
      deps: { resolveCachePath: () => '/unused/builtin-preference-migration-cache', writeCache: async () => undefined } });
    expect(result.outcomes).toEqual([{ sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc-deepseek' }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.nextSettings).toMatchObject({ t: 'plain', v: { profileEnabledById: { anthropic: false }, unknown: { keep: true } } });
    expect(writes[0]?.mutations).toMatchObject([{ id: 'deepseek', content: { t: 'plain', v: { enabled: true,
      definition: { kind: 'inline', profile: { extraEnvironmentVariables: [{ name: 'API_TIMEOUT_MS', value: '600000' }] } } } } }]);
  });
  it('preserves disabled entity enablement over a conflicting builtin preference after active guided preview and confirmation', async () => {
    const builtin = getHistoricalBuiltInAiLaunchProfileV1('deepseek');
    if (!builtin) throw new Error('expected retained DeepSeek predecessor builtin');
    const profile = ProfileRecordV1Schema.parse({ v: 1, id: builtin.id, enabled: false,
      definition: { kind: 'legacy', profile: builtin }, promptStack: [],
      secretBindings: { DEEPSEEK_AUTH_TOKEN: sharedSecretRef, OTHER_TOKEN: retainedPrivateSecretRef } });
    const raw = { profileEnabledById: { deepseek: true, anthropic: false }, unrelated: { keep: true } };
    const control = { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, phase: 'active',
      sourceSettingsVersion: 5, migratedLogicalRevision: 1, inventory: [{ kind: 'account_row', id: profile.id, revision: 2 }] } } };
    const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 9 } };
      if (path.endsWith('/profiles/transfer')) return { status: 200, data: control };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', complete: true,
        nextCursor: null, diagnostics: [], referenceGuardRevision: 9, transferControl: control,
        rows: [{ id: profile.id, revision: 2, content: { t: 'plain', v: profile } }] } };
      if (path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: null } } };
      return baselineGet(url, options);
    });
    const writes: ReturnType<typeof ProfileProviderConversionMutationV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/profiles/provider-conversion');
      const mutation = ProfileProviderConversionMutationV1Schema.parse(body);
      writes.push(mutation);
      return { status: 200, data: { status: 'updated', settingsVersion: 8, providerRevision: 2, referenceGuardRevision: 10,
        rows: mutation.mutations.map(row => ({ id: row.id, revision: Number(row.expectedRevision) + 1, content: row.content })) } };
    });
    const baseMapping = guidedReviewedMapping();
    const reviewedMapping = LegacyProfileReviewedMappingV1Schema.parse({ ...baseMapping,
      connection: { ...baseMapping.connection, source: { kind: 'custom', template: { ...baseMapping.connection.source.template,
        credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [{ id: 'key', protocols: ['openai-chat'],
          uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] } } } },
      credentialMoves: [{ legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey', credentialStyle: 'bearer' }],
      routingEnvironmentVariableNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'],
    });
    const deps = { resolveCachePath: () => '/unused/guided-builtin-enablement-cache', writeCache: async () => undefined };
    const preview = await previewLegacyProfileMigration({ credentials: credentials(), sourceProfileId: profile.id, reviewedMapping, deps });
    expect(preview.version).toBe(7);
    expect(writes).toHaveLength(0);
    const confirmed = await confirmLegacyProfileMigration({ credentials: credentials(), sourceProfileId: profile.id, reviewedMapping,
      expectedSourceFingerprint: preview.sourceFingerprint, migratedAt: 20, deps });
    expect(confirmed.version).toBe(8);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ expectedSettingsVersion: 7, expectedProfileTransferRevision: 4,
      expectedReferenceGuardRevision: 9, profileCensus: [{ id: profile.id, revision: 2 }],
      mutations: [{ id: profile.id, operation: 'update', expectedRevision: 2, content: { t: 'plain', v: {
        id: profile.id, enabled: false, promptStack: profile.promptStack, secretBindings: { OTHER_TOKEN: retainedPrivateSecretRef },
        definition: { kind: 'inline', profile: { v: 2, id: profile.id } },
      } }, referencedSavedSecretIds: [retainedPrivateSecretRef], savedSecretRevisions: [{ resourceId: 'secret-private', expectedRevision: 6 }] }],
      providerMutation: { expectedRevision: 1, referencedSavedSecretIds: [sharedSecretRef],
        savedSecretRevisions: [{ resourceId: 'secret-a', expectedRevision: 3 }],
        content: { t: 'plain', v: { secretBindingsByConnectionId: { 'pc-company': { account: { apiKey: sharedSecretRef } } } } } },
      nextSettings: { t: 'plain', v: { profileEnabledById: raw.profileEnabledById, unrelated: raw.unrelated } } });
  });
  it.each([
    { completeAcknowledgement: true, transferActive: true },
    { completeAcknowledgement: false, transferActive: true },
    { completeAcknowledgement: true, transferActive: false },
  ])('converts active Profile definitions and Provider output in one captured transaction without writing a Settings mirror (ack: $completeAcknowledgement, transfer: $transferActive)', async ({ completeAcknowledgement, transferActive }) => {
    const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'deepseek', enabled: true,
      definition: { kind: 'legacy', profile: { id: 'deepseek', name: 'Personal routing', isBuiltIn: true,
        environmentVariables: [{ name: 'DEEPSEEK_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }], createdAt: 1, updatedAt: 1 } },
      promptStack: [{ id: 'private-stack', ref: { kind: 'doc', artifactId: 'private-document' }, enabled: true, placement: 'system_append' }],
      secretBindings: { DEEPSEEK_AUTH_TOKEN: sharedSecretRef, OTHER_TOKEN: retainedPrivateSecretRef } });
    const control = transferActive ? { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, phase: 'active',
      sourceSettingsVersion: 5, migratedLogicalRevision: 1, inventory: [{ kind: 'account_row', id: 'deepseek', revision: 2 }] } } }
      : { status: 'absent' };
    const source = { unknown: { keep: true }, favoriteProfiles: ['deepseek'] };
    const baselineGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: { mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: source } } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 9 } };
      if (path.endsWith('/transfer')) return { status: 200, data: control };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', complete: true,
        nextCursor: null, diagnostics: [], referenceGuardRevision: 9, transferControl: control,
        rows: [{ id: profile.id, revision: 2, content: { t: 'plain', v: profile } }] } };
      if (path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: 'deepseek' } } };
      return baselineGet(input, options);
    });
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      writes.push({ path, body });
      const rows = path.endsWith('/provider-conversion') ? ProfileProviderConversionMutationV1Schema.parse(body).mutations.map((mutation) => ({
        id: mutation.id, revision: Number(mutation.expectedRevision) + 1, content: completeAcknowledgement ? mutation.content : null,
      })) : [];
      return { status: 200, data: path.endsWith('/provider-conversion')
        ? { status: 'updated', settingsVersion: 8, providerRevision: 2, rows, referenceGuardRevision: 10 }
        : { success: true, version: 8 } };
    });
    let evaluations = 0;
    const candidate = context('pc-deepseek').candidates[0]!;
    const pendingResult = migrateProviderSettings({ credentials: credentials(),
      deps: cacheBoundary,
      acquireRegistryLease: async () => ({ registry: {}, release: async () => undefined }),
      deriveContext: (raw) => {
        evaluations += 1;
        expect(raw.profiles).toEqual([profile.definition.kind === 'legacy' ? profile.definition.profile : null]);
        return { migratedAt: 20, pendingCustomProfileIds: [], candidates: [{ ...candidate,
          kind: 'connection', movedSecretBindingEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'],
          removedEnvironmentVariableNames: ['DEEPSEEK_AUTH_TOKEN'], secretBindings: { account: { apiKey: sharedSecretRef } } }] };
      } });
    if (!completeAcknowledgement) {
      await expect(pendingResult).rejects.toMatchObject({ reason: 'migration_outcome_unknown' });
      expect(writes).toHaveLength(1);
      return;
    }
    const result = await pendingResult;
    expect(evaluations).toBe(1);
    expect(result.version).toBe(8);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/v1/account/entity-rows/profiles/provider-conversion');
    expect(writes[0]?.body).toMatchObject({ operation: 'provider-conversion', expectedAccountMode: 'plain', expectedSettingsVersion: 7,
      expectedReferenceGuardRevision: 9, expectedProfileTransferRevision: transferActive ? 4 : 'absent', profileCensus: [{ id: 'deepseek', revision: 2 }],
      mutations: [{ id: 'deepseek', operation: 'update', expectedRevision: 2, content: { t: 'plain', v: {
        id: 'deepseek', enabled: true, promptStack: profile.promptStack, secretBindings: { OTHER_TOKEN: retainedPrivateSecretRef },
        definition: { kind: 'inline', profile: { v: 2, id: 'deepseek', name: 'Personal routing', extraEnvironmentVariables: [] } },
      } }, referencedSavedSecretIds: [retainedPrivateSecretRef], savedSecretRevisions: [{ resourceId: 'secret-private', expectedRevision: 6 }] }],
      providerMutation: { expectedRevision: 1, content: { t: 'plain', v: { connections: [{ id: 'pc-deepseek' }] } },
        referencedSavedSecretIds: [sharedSecretRef], savedSecretRevisions: [{ resourceId: 'secret-a', expectedRevision: 3 }] },
      nextSettings: { t: 'plain', v: { unknown: { keep: true }, favoriteProfiles: ['deepseek'] } } });
    const next = record(record(writes[0]?.body)?.nextSettings)?.v;
    expect(next).not.toHaveProperty('providerSettingsV1');
    expect(next).not.toHaveProperty('profiles');
    expect(next).not.toHaveProperty('secretBindingsByProfileId');
  });
  it.each([false, true])('clears only the converted Profile after catalog commit, repairs an interrupted clear (%s), and preserves a newer choice', async interruptClear => {
    const { state } = installMigrationAccount({ raw: {
      profiles: [{ id: 'deepseek', name: 'DeepSeek', environmentVariables: [], createdAt: 1, updatedAt: 1 }],
    }, version: 1, selected: 'deepseek' });
    state.interruptClear = interruptClear;
    if (interruptClear) {
      await expect(migrateProviderSettings({ credentials: credentials(), ...migrationParams('pc-deepseek'), deps: cacheBoundary }))
        .rejects.toThrow('Interrupted after catalog committed');
      expect(state.selected).toBe('deepseek');
      expect(state.catalog.connections).toMatchObject([{ id: 'pc-deepseek' }]);
      expect(state.raw).not.toHaveProperty('lastUsedProfile');
    }
    await migrateProviderSettings({ credentials: credentials(), ...migrationParams('pc-deepseek'), deps: cacheBoundary });
    expect(state.events.slice(0, 2)).toEqual(['conversion', 'memory']);
    expect(state.selected).toBeNull();
    expect(state.raw).not.toHaveProperty('lastUsedProfile');
    expect(state.raw).not.toHaveProperty('providerSettingsV1');
    state.selected = 'newer-profile';
    state.memoryRevision += 1;
    await migrateProviderSettings({ credentials: credentials(), ...migrationParams('pc-deepseek'), deps: cacheBoundary });
    expect(state.selected).toBe('newer-profile');
  });

  it('previews the latest captured HTTP source without writing or returning private settings', async () => {
    const reviewedMapping = guidedReviewedMapping();
    const raw = guidedRawProfile();
    const { state } = installMigrationAccount({ raw });
    const result = await previewLegacyProfileMigration({
      credentials: credentials(), sourceProfileId: 'company', reviewedMapping, deps: cacheBoundary,
    });
    expect(result).toEqual({ version: 7,
      sourceFingerprint: createLegacyProfileMigrationSourceFingerprintV1({ authoringMemory: { lastUsedProfile: null },
        rawSettings: raw, sourceProfileId: 'company', reviewedMapping }),
    });
    expect(state.writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('OPENAI_BASE_URL');
  });

  it('refuses a changed guided source before submitting a transaction', async () => {
    const reviewedMapping = guidedReviewedMapping();
    const displayedRaw = guidedRawProfile();
    const fingerprint = createLegacyProfileMigrationSourceFingerprintV1({ authoringMemory: { lastUsedProfile: 'company' },
      rawSettings: displayedRaw, sourceProfileId: 'company', reviewedMapping });
    const { state } = installMigrationAccount({ raw: displayedRaw, selected: null });
    await expect(confirmLegacyProfileMigration({ credentials: credentials(), sourceProfileId: 'company',
      expectedSourceFingerprint: fingerprint, reviewedMapping, migratedAt: 20, deps: cacheBoundary }))
      .rejects.toMatchObject({ name: 'ProviderSettingsMigrationError', reason: 'legacy_profile_source_changed' });
    expect(state.writes).toEqual([]);
  });

  it.each(['settings-conflict', 'provider-conflict'] as const)('returns a typed %s without replaying evaluation against its winner', async status => {
    const { state } = installMigrationAccount({ raw: { profiles: [], schemaVersion: 7, unrelated: 'initial' }, version: 1 });
    let acquired = 0; let released = 0;
    const derivations: unknown[] = [];
    state.conversion = async () => {
      state.raw = { profiles: [], schemaVersion: 7, unrelated: 'concurrent-winner' };
      state.version = 2;
      return { status, revision: 2 };
    };
    await expect(migrateProviderSettings({
      credentials: credentials(), deps: cacheBoundary,
      acquireRegistryLease: async () => {
        acquired += 1;
        return { registry: { generation: 'accepted-generation' }, release: async () => { released += 1; } };
      },
      deriveContext: (raw, registry, providerSettings) => {
        derivations.push({ unrelated: raw.unrelated, registry, existingConnections: providerSettings.connections });
        return context(raw.unrelated === 'initial' ? 'pc_initial' : 'pc_from_winner');
      },
    })).rejects.toMatchObject({ reason: 'legacy_profile_source_changed' });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ expectedSettingsVersion: 1,
      providerMutation: { expectedRevision: 1, content: { t: 'plain', v: { connections: [{ id: 'pc_initial' }] } } },
      nextSettings: { t: 'plain', v: { unrelated: 'initial', schemaVersion: 7 } },
    });
    expect(state.writes[0]?.nextSettings?.t === 'plain' ? state.writes[0].nextSettings.v : null).not.toHaveProperty('providerSettingsV1');
    expect(derivations).toEqual([{ unrelated: 'initial', registry: { generation: 'accepted-generation' }, existingConnections: [] }]);
    expect(acquired).toBe(1); expect(released).toBe(1);
    expect(state.raw.unrelated).toBe('concurrent-winner');
    expect(state.catalog.connections).toEqual([]);
  });

  it('returns a concurrent guided-confirmation conflict after one captured transaction', async () => {
    const reviewedMapping = guidedReviewedMapping();
    const raw = guidedRawProfile();
    const { state } = installMigrationAccount({ raw, version: 1 });
    const preview = await previewLegacyProfileMigration({ credentials: credentials(), sourceProfileId: 'company', reviewedMapping, deps: cacheBoundary });
    state.conversion = async () => ({ status: 'settings-conflict', revision: 2 });
    await expect(confirmLegacyProfileMigration({ credentials: credentials(), sourceProfileId: 'company', reviewedMapping,
      expectedSourceFingerprint: preview.sourceFingerprint, migratedAt: 20, deps: cacheBoundary }))
      .rejects.toMatchObject({ reason: 'legacy_profile_source_changed' });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.expectedSettingsVersion).toBe(1);
    expect(state.catalog.connections).toEqual([]);
  });

  it('lets one concurrent composite writer win without replaying the losing evaluation', async () => {
    const { state, commit } = installMigrationAccount({ raw: { profiles: [], schemaVersion: 7, unrelated: 'keep' }, version: 1 });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    state.conversion = async mutation => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return commit(mutation);
    };
    const evaluations: string[] = [];
    const invoke = (connectionId: string) => migrateProviderSettings({
      credentials: credentials(), ...migrationParams(connectionId), deps: cacheBoundary,
      deriveContext: () => { evaluations.push(connectionId); return context(connectionId); },
    });
    const results = await Promise.allSettled([invoke('pc_left'), invoke('pc_right')]);
    const fulfilled = results.find(result => result.status === 'fulfilled');
    const rejected = results.find(result => result.status === 'rejected');
    expect(fulfilled?.status).toBe('fulfilled');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ reason: 'legacy_profile_source_changed' });
    const winner = fulfilled?.status === 'fulfilled' && fulfilled.value.outcomes[0]?.kind === 'connection'
      ? fulfilled.value.outcomes[0].connectionId : null;
    expect(winner).toMatch(/^pc_(left|right)$/);
    expect(evaluations.sort()).toEqual(['pc_left', 'pc_right']);
    expect(state.writes).toHaveLength(2);
    expect(state.writes.map(write => write.providerMutation.expectedRevision)).toEqual([1, 1]);
    expect(state.catalog.connections).toMatchObject([{ id: winner }]);
    expect(state.raw).toMatchObject({ unrelated: 'keep' });
    expect(state.raw).not.toHaveProperty('providerSettingsV1');
    expect(state.version).toBe(2);
    expect(state.providerRevision).toBe(2);
  });

  it('reports a disconnected transaction as unknown and releases its registry lease without replay', async () => {
    const { state, commit } = installMigrationAccount({ raw: { profiles: [], schemaVersion: 7, unrelated: 'initial' }, version: 1 });
    let released = 0;
    state.conversion = async mutation => { commit(mutation); throw new Error('connection reset after commit'); };
    await expect(migrateProviderSettings({
      credentials: credentials(), deriveContext: () => context('pc_outcome_unknown'), deps: cacheBoundary,
      acquireRegistryLease: async () => ({ registry: { generation: 'test' }, release: async () => { released += 1; } }),
    })).rejects.toMatchObject({ reason: 'migration_outcome_unknown' });
    expect(state.writes).toHaveLength(1);
    expect(state.catalog.connections).toMatchObject([{ id: 'pc_outcome_unknown' }]);
    expect(state.events).toEqual(['conversion']);
    expect(released).toBe(1);
  });
});
