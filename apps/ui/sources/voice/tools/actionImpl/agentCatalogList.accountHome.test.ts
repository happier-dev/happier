import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionsCatalogV1Schema, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    createProviderModelProjectionFixture,
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    type ProviderRpcRequest,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { resetDynamicModelProbeCacheForTests, writeDynamicModelProbeCacheSuccess } from '@/sync/domains/models/dynamicModelProbeCache';

const account = createProviderSettingsAccountHarness();
const daemon = createProviderSettingsHarness();
// Hoist the genuine Machine transport boundary before the shared Sync graph
// imports Actions; the canonical daemon fixture still owns all response shapes.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: ProviderRpcRequest) => daemon.machineRpc(input),
}));
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

async function restoreVoiceModelHome() {
    const scope = await account.restore({
        accountId: 'voice-model-account',
        settings: {},
        machines: [createMachineFixture({ id: machineId, activeAt: Date.now() })],
        catalog: ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            modelVisibilityByRef: {
                [serializeModelVisibilityRefV1({ scope: 'agent', agentTargetKey: targetKey, providerConnectionId: null, modelId: 'native-hidden' })]: 'hidden',
            },
        }),
    });
    await refreshProviderCatalog(scope);
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
    it('honors rootless Provider catalog visibility through the actual model-list owner', async () => {
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
