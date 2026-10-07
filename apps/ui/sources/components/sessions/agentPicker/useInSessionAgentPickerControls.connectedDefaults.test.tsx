import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInput/agentInputTestHelpers';

installAgentInputCommonModuleMocks({ text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
} });

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_machineId: string, _request: unknown) => ({
    supported: true,
    response: { ok: true, result: { availableModels: [{ id: 'probed-model', name: 'Probed model' }], supportsFreeform: false } },
})) }));

// Only machine capability and continuation-inspection transports are replaced.
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: invoke }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { payload: { selections: readonly unknown[] } }) => ({
        v: 1, inspections: params.payload.selections.map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })),
    }),
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: () => {} }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: () => null }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));

const [{ useInSessionAgentPickerControls }, { getResolvedBackendCatalogEntries }, { settingsDefaults }] = await Promise.all([
    import('./useInSessionAgentPickerControls'),
    import('@/agents/backendCatalog/getResolvedBackendCatalogEntries'),
    import('@/sync/domains/settings/settings'),
]);
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');

describe('continuation target account discovery', () => {
    it.each(['work', 'missing-profile'])('probes the configured qualified target purpose account (%s)', async (profileId) => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const settings = {
            ...settingsDefaults,
            connectedAccountPurposeBindingsV1: {
                v: 1 as const, bindings: [{
                    purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
                    target: { kind: 'account' as const, account: {
                        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: profileId,
                    } },
                }],
            },
        };
        const hook = await renderHook(() => useInSessionAgentPickerControls({
            sessionId: 'qualified-account-discovery', accountScope: null,
            currentAgentId: 'claude', currentAgentLabel: 'Claude', projectionCurrent: true,
            entries: getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude', 'codex'], acpCatalogSettingsV1: settings.acpCatalogSettingsV1 }),
            featureDecision: { state: 'enabled' },
            source: { currentBackendTargetKey: 'agent:happier.agent.claude/claude', storageKind: 'persisted', canEditSession: true, machinePresence: 'online', hasConversationToCarry: true },
            machine: { machineId: 'machine-1', serverId: 'server-1', connectionGeneration: 1, daemonGeneration: 1 },
            detail: { settings, capabilityServerId: 'server-1', machineId: 'machine-1', cwd: '/repo',
                connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled: true },
        }));
        await act(async () => { hook.getCurrent().onAgentPickerVisibilityChange(true); });
        await act(async () => { await Promise.resolve(); });
        const option = hook.getCurrent().composeAgentPickerOptions([]).find((row) => row.id.includes('codex'));
        expect(option?.disabled).not.toBe(true);
        const detail = option?.renderDetailContent?.();
        if (!React.isValidElement(detail)) throw new Error('Expected target Agent detail content');
        const screen = await renderScreen(detail);
        await act(async () => { await Promise.resolve(); });
        const request = invoke.mock.calls.map((args) => args[1] as { id?: string; method?: string; params?: unknown })
            .find((candidate) => candidate.id === 'cli.codex' && candidate.method === 'probeModels');
        expect(request).toBeDefined();
        expect(request?.params).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId },
        } } });
        await screen.unmount();
        await hook.unmount();
    });
});
