import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import * as persistenceBoundary from '@/persistence';
import { configuration } from '@/configuration';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileProviderConversionMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsCatalogV1Schema,
  splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { buildLegacyProfileMigrationContext } from './buildContext';
import { authorizeLegacyProfileMigrationContext } from './authorizeContext';
import { createProviderOperationLifetime } from '../operationLifetime';
import { confirmLegacyProfileMigrationConflict, triggerLegacyProfileMigration } from './runtime';

const dnsLookup = vi.hoisted(() => vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]));

// OS lookup is the real network-admission boundary; preserve all other DNS APIs.
vi.mock('node:dns/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: dnsLookup,
}));

describe('public legacy Profile conflict confirmation', () => {
  afterAll(async () => { await pluginReloadController.shutdown(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it.each([
    { label: 'public DNS grants the reviewed Account intent', address: '8.8.8.8', staleReview: false, changedWinnerEndpoint: false },
    { label: 'private DNS keeps reviewed intent without an automatic Account grant', address: '192.168.1.10', staleReview: false, changedWinnerEndpoint: false },
    { label: 'changed source credential refuses an old review without effects', address: '8.8.8.8', staleReview: true, changedWinnerEndpoint: false },
    { label: 'changed winner endpoint refuses the captured review without effects', address: '8.8.8.8', staleReview: false, changedWinnerEndpoint: true },
  ])('$label', async ({ address, staleReview, changedWinnerEndpoint }) => {
    dnsLookup.mockResolvedValue([{ address, family: 4 }]);
    // Use actual bundled manifest declarations and the real runtime producer.
    // The CLI runner owns this process's isolated temporary Home and cleanup.
    const provider = resolveBuiltInContributions().providers.find(entry =>
      entry.definition.legacyProfileMigrations?.some(descriptor => descriptor.sourceProfileId === 'deepseek'));
    if (!provider) throw new Error('Expected the bundled DeepSeek migration declaration');
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: configuration.happyHomeDir,
      contributes: createResolvedContributionRegistry({ providers: [provider] }),
    });
    await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: [provider.pluginId],
      runningSessionDisposition: 'retainRunningSessions',
    });
    const descriptor = provider.definition.legacyProfileMigrations?.find(entry => entry.sourceProfileId === 'deepseek');
    if (!descriptor?.credentialBinding || !descriptor.primaryModel) throw new Error('Expected credential and model migration declarations');
    if (descriptor.primaryModel.legacyProcessEnvAlias) vi.stubEnv(descriptor.primaryModel.legacyProcessEnvAlias, '');
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'conflict-review-account' })).toString('base64url')}.signature`, encryption: null };
    const sourceReference = formatSharedSavedSecretRefV1('review-source-key');
    const winnerReference = formatSharedSavedSecretRefV1('review-winner-key');
    let raw: Record<string, unknown> = {
      profiles: [AIBackendProfileSchema.parse({ id: 'deepseek', name: 'Reviewed DeepSeek',
        environmentVariables: [...descriptor.migratedEnvironmentVariables, ...descriptor.retainedEnvironmentVariables],
        createdAt: 1, updatedAt: 1 })],
      profileEnabledById: { deepseek: true },
      secretBindingsByProfileId: { deepseek: { [descriptor.credentialBinding.legacyEnvVarName]: sourceReference } },
      unrelatedPreference: { keep: true },
    };
    const providersByContributionKey = registry.contributes.providersByContributionKey;
    if (!providersByContributionKey) throw new Error('Expected the canonical typed Provider contribution map');
    const baseContext = buildLegacyProfileMigrationContext({ rawSettings: raw,
      providerSettings: DEFAULT_PROVIDER_SETTINGS_V1, authoringMemory: { lastUsedProfile: null },
      providersByContributionKey, allocatedConnectionIdsBySourceProfileId: { deepseek: 'pc-review-candidate' },
      migratedAt: 20, processEnv: process.env });
    const candidate = baseContext.candidates.find(entry => entry.kind === 'connection' && entry.sourceProfileId === 'deepseek');
    if (!candidate || candidate.kind !== 'connection' || !candidate.selectedModel) throw new Error('Expected a model-bearing migration candidate');
    const winnerId = 'pc-review-winner';
    const initialSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{ ...candidate.connection, id: winnerId, revision: 1 }],
      secretBindingsByConnectionId: { [winnerId]: { account: { [descriptor.credentialBinding.credentialSlotId]: winnerReference } } },
    });
    const authorizationInput = { rawSettings: raw, context: baseContext, providersByContributionKey, machineId: 'machine-review' };
    const conflict = (await authorizeLegacyProfileMigrationContext({ ...authorizationInput,
      providerSettings: initialSettings,
      lifetime: createProviderOperationLifetime({ wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }),
    })).pendingConflicts?.[0];
    if (!conflict) throw new Error('Expected a credential conflict requiring review');
    expect(conflict.kinds).toContain('credential_binding');
    const settings = ProviderSettingsV1Schema.parse({ ...initialSettings,
      migration: { v: 1, completedSources: [], pendingCustomProfileIds: [], pendingConflicts: [conflict] },
    });
    const currentConflict = (await authorizeLegacyProfileMigrationContext({ ...authorizationInput,
      providerSettings: settings,
      lifetime: createProviderOperationLifetime({ wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs }),
    })).pendingConflicts?.[0];
    if (!currentConflict) throw new Error('Expected exact current pending review facts');
    let catalog = splitProviderSettingsV1(settings).catalog;
    if (staleReview) {
      // Ordinary credential conflict kinds now disappear, but unresolved review
      // intent remains. The public owner must freshly capture these source facts.
      raw = { ...raw, secretBindingsByProfileId: {
        deepseek: { [descriptor.credentialBinding.legacyEnvVarName]: winnerReference },
      } };
    }
    if (changedWinnerEndpoint) {
      const endpoint = provider.definition.endpointTemplates.find(template => template.baseUrl);
      if (!endpoint) throw new Error('Expected a declared bundled endpoint for the persisted winner override');
      // A different public endpoint is a new reviewed destination even though
      // all credential, model and default-selection conflict facts are unchanged.
      catalog = splitProviderSettingsV1(ProviderSettingsV1Schema.parse({ ...settings,
        connections: settings.connections.map(connection => connection.id === winnerId ? {
          ...connection, revision: connection.revision + 1, updatedAt: 21,
          endpointOverrides: [{ endpointTemplateId: endpoint.id, baseUrl: 'https://changed-winner.example/v1' }],
        } : connection),
      })).catalog;
    }
    const untouchedRaw = structuredClone(raw);
    const untouchedCatalog = structuredClone(catalog);
    let version = 7;
    const initialProviderRevision = changedWinnerEndpoint ? 4 : 3;
    let providerRevision = initialProviderRevision;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
      settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    // Only genuine persistence, feature HTTP, Account HTTP and OS DNS boundaries
    // are controlled; lease acquisition, authorizers, reducers and stores execute.
    vi.spyOn(persistenceBoundary, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {},
    }), { status: 200 }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: version, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version, content: { t: 'plain', v: raw } } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return { status: 200,
        data: { status: 'present', revision: providerRevision, content: { t: 'plain', v: catalog } } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200,
        data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [] }) };
      if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`
        || path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`
        || path === ACP_CATALOG_ROWS_ROUTE_V1 || path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
        || path === REMOTE_HOST_ROWS_ROUTE_V1 || path === NOTIFICATION_CHANNELS_ROUTE_V1
        || path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 || path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1
        || path.endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: { status: 'absent' } };
      if (path.endsWith('/reference-guard')) return { status: 200, data: { status: 'ready', revision: 'absent' } };
      if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v1/account/entity-rows/profiles') return { status: 200, data: { status: 'listed', rows: [], complete: true,
        nextCursor: null, diagnostics: [], referenceGuardRevision: 'absent', transferControl: { status: 'absent' } } };
      if (path.endsWith('/saved-secrets/resources/materials')) return { status: 200, data: { resources:
        ['review-source-key', 'review-winner-key'].map(resourceId => ({ resourceId, encryptionMode: 'plain', recipientEnvelope: null,
          storedContent: { t: 'plain', v: { v: 1, name: 'Review credential', kind: 'apiKey', value: 'fixture-private-value' } },
          entry: { ref: formatSharedSavedSecretRefV1(resourceId), source: 'shared_resource', relationship: 'owner',
            ownerAccountId: 'conflict-review-account', name: 'Review credential', kind: 'apiKey', encryptionMode: 'plain',
            revision: 2, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        })) } };
      throw new Error(`Unexpected public conflict confirmation Account read: ${path}`);
    });
    const commits: ReturnType<typeof ProfileProviderConversionMutationV1Schema.parse>[] = [];
    let boundaryFailure: unknown;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      try {
        const path = new URL(String(url)).pathname;
        if (path !== PROFILE_PROVIDER_CONVERSION_ROUTE_V1) throw new Error(`Unexpected public conflict confirmation write: ${path}`);
        const mutation = ProfileProviderConversionMutationV1Schema.parse(body);
        expect(mutation.expectedSettingsVersion).toBe(version);
        expect(mutation.providerMutation.expectedRevision).toBe(providerRevision);
        if (mutation.nextSettings?.t !== 'plain' || mutation.providerMutation.content?.t !== 'plain') throw new Error('Expected plain Account envelopes');
        raw = mutation.nextSettings.v;
        catalog = ProviderConnectionsCatalogV1Schema.parse(mutation.providerMutation.content.v);
        version += 1;
        providerRevision += 1;
        commits.push(mutation);
        return { status: 200, data: { status: 'updated', settingsVersion: version, providerRevision,
          rows: mutation.mutations.map(row => ({ id: row.id, revision: Number(row.expectedRevision) + 1, content: row.content })),
          referenceGuardRevision: 'absent' } };
      } catch (error) {
        // Preserve transport-fixture errors rather than mislabeling their mapped
        // migration_outcome_unknown result as a behavioral RED.
        boundaryFailure = error;
        throw error;
      }
    });

    const confirmReview = (expectedCandidateFingerprint: string) => confirmLegacyProfileMigrationConflict({ credentials,
      machineId: 'machine-review', migratedAt: 20,
      resolution: { sourceProfileId: 'deepseek', expectedCandidateFingerprint,
        decision: { kind: 'keep_existing', existingConnectionId: winnerId } } }).catch(error => {
          if (boundaryFailure) throw boundaryFailure;
          throw error;
        });
    let confirmation = confirmReview(currentConflict.candidateFingerprint);

    if (staleReview || changedWinnerEndpoint) {
      await expect(confirmation).rejects.toMatchObject({ name: 'ProviderSettingsMigrationError', reason: 'migration_conflict_changed' });
      expect(commits).toEqual([]);
      expect(raw).toEqual(untouchedRaw);
      expect(catalog).toEqual(untouchedCatalog);
      expect(catalog.accountGrants).toEqual([]);
      expect(version).toBe(7);
      expect(providerRevision).toBe(initialProviderRevision);
      if (staleReview) return;

      // Reopening the ordinary migration producer must publish the review that
      // a caller can actually select; deriving a test-only fresh hash is insufficient.
      expect(await triggerLegacyProfileMigration({ credentials, providersEnabled: true, machineId: 'machine-review' }))
        .toMatchObject({ status: 'complete', version: 8 });
      const refreshedConflict = catalog.migration?.pendingConflicts.find(entry => entry.sourceProfileId === 'deepseek');
      if (!refreshedConflict) throw new Error('Expected a freshly authorized destination review');
      expect(refreshedConflict.kinds).toEqual(expect.arrayContaining(['credential_binding', 'edited_default_connection']));
      expect(refreshedConflict.candidateFingerprint).not.toBe(currentConflict.candidateFingerprint);
      expect(catalog.connections).toEqual(untouchedCatalog.connections);
      expect(catalog.accountGrants).toEqual([]);
      confirmation = confirmReview(refreshedConflict.candidateFingerprint);
    }
    const result = await confirmation;
    expect(result.outcomes).toContainEqual(expect.objectContaining({ sourceProfileId: 'deepseek', kind: 'connection', connectionId: winnerId,
      modelSelection: { ...candidate.selectedModel, providerConnectionId: winnerId } }));
    expect(commits).toHaveLength(changedWinnerEndpoint ? 2 : 1);
    expect(catalog.connections.map(connection => connection.id)).toEqual([winnerId]);
    if (changedWinnerEndpoint) {
      expect(catalog.connections[0]).toMatchObject({ endpointOverrides: untouchedCatalog.connections[0]!.endpointOverrides });
      expect(version).toBe(9);
      expect(providerRevision).toBe(6);
    }
    expect(catalog.secretBindingsByConnectionId).toEqual({ [winnerId]: { account: { [descriptor.credentialBinding.credentialSlotId]: winnerReference } } });
    expect(catalog.manualModelsByConnectionId[winnerId]).toContainEqual(expect.objectContaining({ id: candidate.selectedModel.modelId }));
    expect(catalog.migration?.pendingConflicts ?? []).toEqual([]);
    expect(catalog.accountGrants).toEqual(address === '8.8.8.8' ? [{
      v: 1, connectionId: winnerId, confirmedAt: 20,
      connectionSecurityFingerprint: expect.stringMatching(/^connection-security:v1:/),
    }] : []);
    // Enabling this Profile is not an intent to select a global default model.
    expect(raw.providerDefaultModelSelectionsByAgentTargetKeyV1).toEqual({});
    expect(raw).toMatchObject({ unrelatedPreference: { keep: true } });
    expect(raw.secretBindingsByProfileId).not.toHaveProperty('deepseek');
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
  });
});
