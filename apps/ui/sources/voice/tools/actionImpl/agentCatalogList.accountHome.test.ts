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

// Static catalog imports reach the Socket owner before the runtime installer.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const account = createProviderSettingsAccountHarness();
const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const { listAgentModelsForVoiceTool } = await import('./agentCatalogList');
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
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: 'Shared models',
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
