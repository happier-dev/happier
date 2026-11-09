import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';

installDisconnectedServerSocketBoundary();
installAgentInputCommonModuleMocks();
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_request: unknown) => ({
    ok: true, result: { availableModels: [{ id: 'terra', name: 'Terra' }], supportsFreeform: false,
        runtimeDescriptorV1Accepted: true },
})) }));
// Machine RPC is the external boundary; picker, catalog and probe context stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: { method: string; payload: unknown }) =>
        request.method === 'capabilities.invoke' ? invoke(request.payload) : {},
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));

const { useSessionAuthoringEnginePicker } = await import('./useSessionAuthoringEnginePicker');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const account = createProviderSettingsAccountHarness();
afterEach(async () => { await standardCleanup(); await account.reset(); });

it('offers models probed with the authored service, profile and runtime instead of Account defaults', async () => {
    const { serverId } = await account.restore();
    resetDynamicModelProbeCacheForTests();
    invoke.mockClear();
    const values = WorkflowSessionAuthoringSelectionSchema.parse({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        profileId: 'workflow-profile',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
        connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'served-pool' },
        } },
    });
    const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
    const hook = await renderHook(() => useSessionAuthoringEnginePicker({ values, facts: {
        agentPickerContext: { machineId: 'authored-machine', serverId, directory: '/repo' },
        agentTargets: [{ id: entry.backendTargetKey, label: 'Codex', target: values.agentTarget!, agentId: 'codex', pickerEntry: entry }],
    } }));
    expect(invoke.mock.calls).toEqual([]);
    const detail = hook.getCurrent().options[0]?.renderDetailContent?.({ onRequestClose: () => {} });
    if (!React.isValidElement(detail)) throw new Error('missing_picker_detail');
    const screen = await renderScreen(detail);
    await vi.waitFor(() => {
        const probe = invoke.mock.calls.map(([request]) => request as { method?: string; params?: unknown })
            .find(request => request.method === 'probeModels');
        expect(probe?.params).toMatchObject({ connectedServices: values.connectedServices,
            profileId: values.profileId, runtimeDescriptorV1: values.runtimeDescriptorV1 });
    });
    await vi.waitFor(() => expect(screen.findByTestId('model-picker-overlay-option:["agent:happier.agent.codex/codex",null,"terra"]')).not.toBeNull());
});
