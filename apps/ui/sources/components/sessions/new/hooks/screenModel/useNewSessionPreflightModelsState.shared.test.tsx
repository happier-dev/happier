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

it('observes current Codex config in the submitted directory independently of the picker cache', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvokeMock.mockReset();
    const backendTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
    const key = buildDynamicModelProbeCacheKey({
        machineId: 'launch-machine', targetKey: 'agent:codex', serverId: 'launch-server', cwd: '/picker',
    })!;
    cache.writeDynamicModelProbeCacheSuccess(key, {
        availableModels: [{ id: 'cached-model', name: 'Cached' }], supportsFreeform: false,
    });
    machineCapabilitiesInvokeMock.mockResolvedValue({ supported: true, response: { ok: true, result: {
        source: 'dynamic', availableModels: [], supportsFreeform: false, configuredModelId: 'configured-now',
    } } });
    const screen = await renderHook(() => useNewSessionPreflightModelsState({
        backendTarget, selectedMachineId: 'launch-machine', capabilityServerId: 'launch-server', cwd: '/picker',
    }));
    expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
    await expect(screen.getCurrent().getFreshLaunchModelCatalog?.('/submitted')).resolves.toMatchObject({
        availableModels: [], configuredModelId: 'configured-now',
    });
    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledWith('launch-machine', {
        id: 'cli.codex', method: 'probeModels',
        params: expect.objectContaining({ backendTarget, cwd: '/submitted', bypassCache: true }),
    }, { serverId: 'launch-server' });
    machineCapabilitiesInvokeMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: {
        source: 'dynamic', availableModels: [], supportsFreeform: false,
        configuredModelId: 'retained-model', refreshError: true,
    } } });
    await expect(screen.getCurrent().getFreshLaunchModelCatalog?.('/submitted')).resolves.toBeNull();
    machineCapabilitiesInvokeMock.mockResolvedValueOnce({ supported: true, response: { ok: true, result: {
        source: 'dynamic', availableModels: [], supportsFreeform: false,
    } } });
    await expect(screen.getCurrent().getFreshLaunchModelCatalog?.('/submitted')).resolves.toBeNull();
    expect(screen.getCurrent().preflightModels?.availableModels.map(({ id }) => id)).toEqual(['cached-model']);
    await screen.unmount();
});
