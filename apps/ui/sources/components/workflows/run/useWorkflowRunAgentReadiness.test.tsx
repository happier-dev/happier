import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')
).createSessionOpsSocketIoClientBoundary(importOriginal));
const network = await installSessionOpsNetworkBoundary();
const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
const { storage } = await import('@/sync/domains/state/storageStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { useWorkflowRunAgentReadiness } = await import('./useWorkflowRunAgentReadiness');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');

afterEach(async () => {
    await standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    storage.setState(storage.getInitialState(), true);
});
afterAll(() => network.dispose());

describe('Workflow model source readiness', () => {
    it.each(['native', 'account_provider_connection', 'team_resource'] as const)(
        'uses existing credential readiness for a %s selection without probing', async source => {
            const server = await network.addHome(`https://${source}-workflow-readiness.test`, 'account');
            await setActiveServer({ serverId: server.id });
            primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {} }) } });
            const scope = { serverId: server.id, accountId: 'account' };
            const machine = createMachineFixture({ id: source, activeAt: Date.now() });
            storage.setState({ profileScope: scope });
            storage.getState().applyMachines([machine], true, { sourceServerId: server.id, sourceAccountId: scope.accountId });
            const item: MachineAgentInventoryItem = {
                agentId: 'codex', title: 'Codex', installed: true, version: null, latestVersion: null,
                update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'status_only' },
                platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
            };
            machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
                status: 'ready', lastCheckedAt: Date.now(), items: [item],
            });
            const modelSelection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1, ref: {
                source, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a',
                ...(source === 'account_provider_connection' ? { providerConnectionId: 'pc_work' } : {}),
                ...(source === 'team_resource' ? { teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 1, deliveryMode: 'brokered' } : {}),
            } });
            const definition = createWorkflowDefinitionFixture({ defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, modelSelection,
            } });
            network.resetRequests();
            const hook = await renderHook((reviewedDefinition: typeof definition) => useWorkflowRunAgentReadiness({
                enabled: true, machineId: machine.id, definition: reviewedDefinition,
            }), { initialProps: definition });
            if (source === 'native') expect(hook.getCurrent()).toBeTruthy();
            else expect(hook.getCurrent()).toBeNull();
            if (source === 'team_resource') {
                // Run now's editor writes the picker's Team binding and clears the imported V2 model.
                const defaults = withWorkflowAuthoringEngineFields(definition.defaults, {
                    agentTarget: definition.defaults.agentTarget!,
                    modelSelection: null,
                    teamCredentialBindings: [sessionModelSelectionV2TeamBindingIntent(modelSelection, {
                        executionMachineId: machine.id,
                        application: { agentTargetKey: modelSelection.ref.agentTargetKey,
                            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                            endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
                    })],
                    sessionConfigOptionOverrides: { v: 1, updatedAt: 2, overrides: {
                        reasoning_effort: { value: 'minimal', updatedAt: 2 },
                    } },
                });
                await hook.rerender(createWorkflowDefinitionFixture({ defaults }));
                expect(hook.getCurrent()).toBeNull();
            }
            expect(network.requests.filter(request => request.method === 'capabilities.detect')).toEqual([]);
        },
    );
});
