import { expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { useNewSessionPreflightModelsState } from './useNewSessionPreflightModelsState';

const { machineCapabilitiesInvokeMock } = vi.hoisted(() => ({ machineCapabilitiesInvokeMock: vi.fn() }));
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: machineCapabilitiesInvokeMock }));

it('synchronizes exact-key consumers after refresh without probing unrelated subscribers', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvokeMock.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'shared-machine', targetKey: 'agent:claude', serverId: 'shared-server', cwd: '/repo' })!;
    cache.writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'before', name: 'Before' }], supportsFreeform: false });
    machineCapabilitiesInvokeMock.mockResolvedValue({ supported: true, response: { ok: true, result: {
        availableModels: [{ id: 'after', name: 'After' }], supportsFreeform: false,
    } } });
    const render = (cwd: string, enabled = true) => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, selectedMachineId: 'shared-machine',
        capabilityServerId: 'shared-server', cwd, enabled,
    }));
    const screen = await render('/repo');
    const detail = await render('/repo');
    const other = await render('/other', false);
    expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
    const otherOptions = other.getCurrent().modelOptions;
    await act(async () => { detail.getCurrent().probe.onRefresh?.(); });
    await flushHookEffects();
    expect(screen.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['after']);
    expect(screen.getCurrent().preflightModels).toBe(detail.getCurrent().preflightModels);
    expect(other.getCurrent().modelOptions).toBe(otherOptions);
    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await detail.unmount();
    await other.unmount();
});

it('uses only completed model discovery for the exact launch target', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvokeMock.mockReset();
    const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
    const launchTarget = { machineId: 'launch-machine', serverId: 'launch-server', cwd: '/picker' };
    let finishProbe!: (result: unknown) => void;
    machineCapabilitiesInvokeMock.mockImplementationOnce(() => new Promise((resolve) => {
        finishProbe = resolve;
    }));
    const render = () => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget, selectedMachineId: launchTarget.machineId, capabilityServerId: launchTarget.serverId,
        cwd: launchTarget.cwd, observeConfiguredModel: true,
    }));
    const screen = await render();
    expect(screen.getCurrent().readMissingConfiguredModel(launchTarget)).toBeNull();
    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledExactlyOnceWith(launchTarget.machineId, {
        id: 'cli.codex', method: 'probeModels',
        params: expect.objectContaining({ backendTarget, cwd: launchTarget.cwd, includeConfiguredModel: true }),
    }, { serverId: launchTarget.serverId });

    await act(async () => finishProbe({ supported: true, response: { ok: true, result: {
        source: 'dynamic', availableModels: [], supportsFreeform: false, configuredModelId: 'configured-now',
    } } }));
    expect(screen.getCurrent().readMissingConfiguredModel(launchTarget)).toBe('configured-now');
    expect(screen.getCurrent().readMissingConfiguredModel({ ...launchTarget, cwd: '/other' })).toBeNull();
    expect(screen.getCurrent().readMissingConfiguredModel({ ...launchTarget, serverId: 'another-server' })).toBeNull();
    const warmScreen = await render();
    expect(warmScreen.getCurrent().readMissingConfiguredModel(launchTarget)).toBeNull();
    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    await warmScreen.unmount();

    machineCapabilitiesInvokeMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: {
        source: 'dynamic', availableModels: [], supportsFreeform: false,
        configuredModelId: 'retained-model', refreshError: true,
    } } });
    await act(async () => { screen.getCurrent().probe.onRefresh?.(); });
    expect(screen.getCurrent().readMissingConfiguredModel(launchTarget)).toBeNull();
    await screen.unmount();
});
