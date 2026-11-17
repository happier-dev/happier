import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAccountAgentProviderRequirements, readAccountProviderDeclarations, resolveAccountAgentTeamCredentialDemand } from '@/providers/catalog/accountProviderDeclarations';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    createProviderModelProjectionFixture,
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { resetDynamicModelProbeCacheForTests, writeDynamicModelProbeCacheSuccess } from '@/sync/domains/models/dynamicModelProbeCache';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { rememberLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';

// Static catalog imports reach the Socket owner before the runtime installer.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const account = createProviderSettingsAccountHarness();
const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const { listAgentBackendsForVoiceTool, listAgentModelsForVoiceTool } = await import('./agentCatalogList');
const targetKey = 'agent:happier.agent.claude/claude';
const machineId = 'voice-model-machine';

beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    await account.reset();
    daemon.reset();
    resetDynamicModelProbeCacheForTests();
    standardCleanup();
});

async function restoreVoiceModelHome(teamsEnabled = false, providersEnabled = true) {
    const scope = await account.restore({
        accountId: 'voice-model-account',
        settings: {},
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: providersEnabled }, teams: {
            enabled: teamsEnabled, credentialResources: { enabled: teamsEnabled, externalApi: { enabled: false } },
        } } }),
        machines: [createMachineFixture({ id: machineId, activeAt: Date.now() })],
        catalog: ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            modelVisibilityByRef: {
                [serializeModelVisibilityRefV1({ scope: 'agent', agentTargetKey: targetKey, providerConnectionId: null, modelId: 'native-hidden' })]: 'hidden',
            },
        }),
    });
    // A genuine previous Machine observation belongs to the incumbent cache;
    // this test does not replace model discovery, policy or the catalog owner.
    const key = buildDynamicModelProbeCacheKey({ machineId, targetKey, providerConnectionId: null, serverId: scope.serverId, cwd: null });
    if (!key) throw new Error('Expected a canonical native model cache key');
    writeDynamicModelProbeCacheSuccess(key, {
        availableModels: [{ id: 'native-hidden', name: 'Hidden native model' }, { id: 'native-visible', name: 'Visible native model' }],
        supportsFreeform: false,
    });
    daemon.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, createProviderModelProjectionFixture({ agentTargetKey: targetKey, groups: [] }));
    return scope;
}

describe('Voice Agent model catalog at its admitted Account Home', () => {
    it('reads native Agent preference from the captured background Home instead of global active scope', async () => {
        const active = await account.restore({ accountId: 'active-native-account', settings: {}, machines: [],
            catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
        const activeTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
        const backgroundTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        rememberLastUsedBackendSelection(active, { lastUsedBackendTarget: activeTarget, lastUsedAgent: 'claude' });
        const backgroundId = await account.addHome({ name: 'Background native Account', serverUrl: 'https://background-native.test',
            accountId: 'background-native-account', currentAccount: true, active: false });
        account.home.answer(backgroundId, ACP_CATALOG_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { readAcpCatalogInContext } = await import('@/sync/api/account/apiAcpCatalog');
        const captured = await captureLazyActionAccountContext(backgroundId);
        try {
            rememberLastUsedBackendSelection(captured.accountLifetime.scope, { lastUsedBackendTarget: backgroundTarget, lastUsedAgent: 'codex' });
            const { catalog } = await readAcpCatalogInContext(captured);
            const input = { serverId: backgroundId, accountLifetime: captured.accountLifetime, acpCatalogSnapshot: catalog };
            const result = await listAgentBackendsForVoiceTool(input);
            expect(result.items.find(item => item.targetKey === result.defaultTargetKey)?.agentTarget).toEqual(backgroundTarget);
        } finally { captured.dispose(); }
    });
    it.each([false, true])('retains native Agent preference without querying a controller (configured=%s)', async configured => {
        const scope = await account.restore({ accountId: 'native-preference-account', settings: {}, machines: [],
            catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
        const target = configured ? { kind: 'agent' as const,
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'native-configured' }
            : { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const definition = AcpBackendDefinitionV1Schema.parse({ id: 'native-configured', name: 'native-configured', title: 'Configured Agent',
            launch: { kind: 'command', command: 'agent', args: [] }, createdAt: 1, updatedAt: 1 });
        account.home.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [definition] } },
        } });
        await refreshAcpCatalog(scope);
        rememberLastUsedBackendSelection(scope, { lastUsedBackendTarget: target, lastUsedAgent: 'codex' });
        const before = daemon.state.requests.length;
        const result = await listAgentBackendsForVoiceTool({ serverId: scope.serverId });
        expect(result.defaultTargetKey).toBe(buildBackendTargetKeyV2(target));
        expect(result.items.find(item => item.targetKey === result.defaultTargetKey)?.agentTarget).toEqual(target);
        expect(result).not.toHaveProperty('executionTarget');
        expect(daemon.state.requests.slice(before)).toEqual([]);
    });
    it.each([true, false])('discovers and preserves the exact Team model selection with personal Providers enabled=%s', async providersEnabled => {
        const scope = await restoreVoiceModelHome(true, providersEnabled);
        const demand = resolveAccountAgentTeamCredentialDemand(targetKey, { kind: 'account' });
        const application = demand.applications[0]!;
        const declarations = readAccountProviderDeclarations({ kind: 'account' });
        daemon.setResponse(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1,
                agentsById: { claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    providerRequirements: readAccountAgentProviderRequirements(targetKey, { kind: 'account' }), connectedAccounts: [] } },
                familiesById: { providers: { family: 'providers', entriesById: Object.fromEntries(declarations.map(declaration =>
                    [declaration.contributionKey, { id: declaration.contributionKey, pluginId: parseProviderContributionIdentityV1(declaration.contributionKey)!.identity.pluginId,
                        provenance: declaration.provenance, sourceKind: 'path', definition: declaration.definition }])) } },
            }) });
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: { content: { t: 'plain', v: 'Shared models' }, recipientEnvelope: null, legacyPlaintext: true },
            resourceRevision: 3, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
            sourcePresentation: { kind: 'provider', provider: { identity: application.implementationIdentity, definitionRevision: 1 } },
            providerModels: [{ descriptor: { id: 'shared-model', name: 'Shared model' }, sourceRevision: 'source-1', availability: 'available',
                selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team', expectedResourceRevision: 3,
                    deliveryMode: 'brokered', agentTargetKey: targetKey, modelId: 'shared-model' },
                application }] });
        account.home.answer(scope.serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({ id: 'team' })], nextCursor: null } });
        account.home.answer(scope.serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources: [resource], failures: [], nextCursor: null } });
        daemon.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, {
            ...createProviderModelProjectionFixture({ agentTargetKey: targetKey, groups: [] }), teamCredentialResources: [resource],
        });
        const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId, serverId: scope.serverId });
        expect(result).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ modelId: 'shared-model',
            teamCredentialModel: resource.providerModels[0]!.selection })]) });
        const request = daemon.state.requests.find(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION);
        expect(request?.payload).toMatchObject({ teamCredentialResources: [resource] });
    });
    it('loads rootless Provider catalog visibility on first demand through the actual model-list owner', async () => {
        const scope = await restoreVoiceModelHome();
        const result = await listAgentModelsForVoiceTool({ agentId: 'claude', machineId, serverId: scope.serverId });
        expect(result).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ modelId: 'native-visible' })]) });
        expect(result).not.toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ modelId: 'native-hidden' })]) });
    });

    it('does not present a native-only fallback when the enabled Provider catalog becomes unavailable', async () => {
        const scope = await restoreVoiceModelHome();
        account.home.answer(scope.serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { status: 503, body: {} });
        await refreshProviderCatalog(scope);
        await expect(listAgentModelsForVoiceTool({ agentId: 'claude', machineId, serverId: scope.serverId }))
            .rejects.toMatchObject({ code: 'provider_catalog_unavailable' });
    });
});
