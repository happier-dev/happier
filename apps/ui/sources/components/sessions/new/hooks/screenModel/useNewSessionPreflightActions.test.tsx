import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';

// The remote daemon is outside the UI process. Action policy, request parsing,
// probe projection and the hooks' real persistent caches remain in the path.
const daemon = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemon }));
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { resetDynamicSessionModeProbeCacheForTests } = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');

describe('New Session preflight Action admission', () => {
    beforeEach(async () => {
        await homes.reset();
        resetDynamicModelProbeCacheForTests();
        resetDynamicSessionModeProbeCacheForTests();
        resetDynamicConfigOptionsProbeCacheForTests();
        daemon.mockReset();
        daemon.mockImplementation(async (request: Readonly<{ method: string; payload: { method?: string } }>) => {
            if (request.method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error('Unexpected daemon operation');
            const result = request.payload.method === 'probeModels'
                ? { availableModels: [{ id: 'model-a', name: 'Model A' }], supportsFreeform: false }
                : request.payload.method === 'probeModes'
                    ? { availableModes: [{ id: 'review', name: 'Review' }] }
                    : { configOptions: [{ id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false }] };
            return { ok: true, result: { ...result, source: 'dynamic' } };
        });
    });
    afterEach(() => standardCleanup());

    it('does not populate any picker when its existing inventory Action is disabled on the invoked Home', async () => {
        const serverId = await homes.addHome({ name: 'Probe Home', serverUrl: 'https://preflight-action-home.test', accountId: 'owner' });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: {
                'agents.models.list': { disabledSurfaces: ['ui'] },
                'agents.session_modes.list': { disabledSurfaces: ['ui'] },
                'agents.config_options.list': { disabledSurfaces: ['ui'] },
            } },
        } } } });
        const request = { backendTarget: { kind: 'backend' as const, backendId: 'acme-review' },
            runtimeCarrierAgentId: 'acme-review', selectedMachineId: 'machine', capabilityServerId: serverId, cwd: '/repo' };
        const hook = await renderHook(() => ({
            models: useNewSessionPreflightModelsState(request),
            modes: useNewSessionPreflightSessionModesState(request),
            config: useNewSessionPreflightConfigOptionsState(request),
        }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().models.probe.phase).toBe('idle');
            expect(hook.getCurrent().modes.probe.phase).toBe('idle');
            expect(hook.getCurrent().config.probe.phase).toBe('idle');
        });
        expect(hook.getCurrent().models.preflightModels).toBeNull();
        expect(hook.getCurrent().modes.preflightModes).toBeNull();
        expect(hook.getCurrent().config.configOptions).toBeNull();
        expect(daemon).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('retains the native runtime observation and refresh semantics on the invoked Home', async () => {
        const serverId = await homes.addHome({ name: 'Probe Home', serverUrl: 'https://preflight-native-home.test', accountId: 'owner' });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://preflight-focus-home.test', accountId: 'focus' });
        const runtimeDescriptorV1 = { v: 1 as const, agentId: 'acme-review', agent: { backendMode: 'stdio', providerSessionId: 'session-a' } };
        const connectedServices = { v: 2 as const, bindingsByServiceId: {} };
        const observedAt = Date.now() - 25_000;
        let modelRevision = 0;
        daemon.mockImplementation(async (request: Readonly<{ method: string; serverId?: string; payload: { method?: string; params: Record<string, unknown> } }>) => {
            expect(request.serverId).toBe(serverId);
            expect(request.payload.params).toMatchObject({ cwd: '/repo', profileId: 'profile-a', runtimeDescriptorV1, connectedServices });
            if (request.payload.method === 'probeModels') {
                const refreshed = request.payload.params.bypassCache === true;
                if (refreshed) modelRevision += 1;
                return { ok: true, result: { source: 'dynamic', availableModels: [{ id: `model-${modelRevision}`, name: 'Session model',
                    extendedContextModelId: 'extended', modelOptions: [{ id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false }] }],
                    supportsFreeform: false, runtimeDescriptorV1Accepted: true, observedAt, cacheable: false } };
            }
            return { ok: true, result: { source: 'dynamic', ...(request.payload.method === 'probeModes'
                ? { availableModes: [{ id: 'review', name: 'Review', description: 'Review this repository' }] }
                : { configOptions: [{ id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false }] }) } };
        });
        const request = { backendTarget: { kind: 'backend' as const, backendId: 'acme-review' },
            runtimeCarrierAgentId: 'acme-review', selectedMachineId: 'machine', capabilityServerId: serverId, cwd: ' /repo ',
            probeContext: { cacheKeySuffixParts: ['exact-runtime'], capabilityParams: { profileId: 'profile-a', runtimeDescriptorV1, connectedServices } } };
        const hook = await renderHook(() => ({ models: useNewSessionPreflightModelsState(request),
            modes: useNewSessionPreflightSessionModesState(request), config: useNewSessionPreflightConfigOptionsState(request) }));
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().models.probe.phase).toBe('idle');
            expect(hook.getCurrent().modes.probe.phase).toBe('idle');
            expect(hook.getCurrent().config.probe.phase).toBe('idle');
        });
        expect(hook.getCurrent().models.probe.failed, JSON.stringify({
            models: hook.getCurrent().models, modes: hook.getCurrent().modes, config: hook.getCurrent().config,
            daemonRequests: daemon.mock.calls,
        })).toBe(false);
        expect(hook.getCurrent().models.preflightModels?.availableModels[0]).toMatchObject({ id: 'model-0', extendedContextModelId: 'extended', modelOptions: [{ id: 'verbose' }] });
        expect(hook.getCurrent().models.probe.refreshedAt).toBe(observedAt);
        expect(hook.getCurrent().modes.preflightModes?.availableModes[0]).toMatchObject({ id: 'review', description: 'Review this repository' });
        expect(hook.getCurrent().config.configOptions?.[0]).toMatchObject({ id: 'verbose', currentValue: 'false' });
        await act(async () => hook.getCurrent().models.probe.onRefresh?.());
        await waitForHomeGovernance(() => expect(hook.getCurrent().models.preflightModels?.availableModels[0]?.id).toBe('model-1'));
        // An older daemon which ignores the exact runtime must not replace or renew last-good rows.
        daemon.mockResolvedValue({ ok: true, result: { source: 'dynamic', availableModels: [{ id: 'account-default', name: 'Account default' }], supportsFreeform: false, observedAt: Date.now() } });
        await act(async () => hook.getCurrent().models.probe.onRefresh?.());
        await waitForHomeGovernance(() => expect(hook.getCurrent().models.probe.failed).toBe(true));
        expect(hook.getCurrent().models.preflightModels?.availableModels[0]?.id).toBe('model-1');
        expect(hook.getCurrent().models.probe.refreshedAt).toBe(observedAt);
        await hook.unmount();
    });
});
