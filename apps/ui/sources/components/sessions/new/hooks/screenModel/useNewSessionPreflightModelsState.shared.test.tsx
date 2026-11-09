import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { readAgentModelChoiceTarget } from '@/components/settings/pickers/projectAgentModelChoices';

const { capabilityRpc } = vi.hoisted(() => ({ capabilityRpc: vi.fn() }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const probeCache = await import('@/sync/domains/models/dynamicModelProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicModelProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

it('observes installed Agent models under the catalog key rather than its runtime compatibility carrier', async () => {
    capabilityRpc.mockReset();
    const [entry] = getResolvedBackendCatalogEntries({ enabledAgentIds: [], mergedProviderProjectionById: {
        'sample-agent': { agentId: 'sample-agent', identity: { pluginId: 'example.agent', localId: 'sample' }, title: 'Sample' },
    } });
    if (!entry) throw new Error('Expected the installed Agent catalog entry');
    const retained = { availableModels: [{ id: 'installed-model', name: 'Installed model' }], supportsFreeform: false };
    const changed = { availableModels: [{ id: 'changed-model', name: 'Changed model' }], supportsFreeform: false };
    const changedTargetKey = 'agent:example.agent/changed';
    for (const [targetKey, models] of [[entry.backendTargetKey, retained], [changedTargetKey, changed]] as const) {
        const key = buildDynamicModelProbeCacheKey({ machineId: 'installed-machine', targetKey,
            providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
        cache.writeDynamicModelProbeCacheSuccess(key, models);
    }
    const hook = await renderHook(({ targetKey }: { targetKey: string }) => {
        const params = { backendTarget: readAgentModelChoiceTarget(entry), backendTargetKey: targetKey,
            runtimeCarrierAgentId: entry.agentId, selectedMachineId: 'installed-machine',
            capabilityServerId: preflight.serverId, cwd: '/repo', enabled: false };
        return useNewSessionPreflightModelsState(params);
    }, { initialProps: { targetKey: entry.backendTargetKey } });
    try {
        expect(hook.getCurrent().preflightModels).toBe(retained);
        expect(hook.getCurrent().preflightModelsTargetKey).toBe(entry.backendTargetKey);
        await hook.rerender({ targetKey: changedTargetKey });
        expect(hook.getCurrent().preflightModels).toBe(changed);
        expect(hook.getCurrent().preflightModelsTargetKey).toBe(changedTargetKey);
        expect(capabilityRpc).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
});

it('returns retained models on the first render without waiting for an effect or opening demand', async () => {
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'retained-machine', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    const retained = { availableModels: [{ id: 'retained', name: 'Retained' }], supportsFreeform: false };
    cache.writeDynamicModelProbeCacheSuccess(key, retained);
    const renders: Array<ReturnType<typeof useNewSessionPreflightModelsState>['preflightModels']> = [];
    const hook = await renderHook(() => {
        const result = useNewSessionPreflightModelsState({
            backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'retained-machine',
            capabilityServerId: preflight.serverId, cwd: '/repo', enabled: false,
        });
        renders.push(result.preflightModels);
        return result;
    });
    try {
        expect(renders[0]).toBe(retained);
        expect(capabilityRpc).not.toHaveBeenCalled();
    } finally { await hook.unmount(); }
});

it('shares one fresh-cache revalidation across demanded siblings and revalidates again after their observer gap', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'shared-machine', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    cache.writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'before', name: 'Before' }], supportsFreeform: false });
    const firstRead = createDeferred<{ ok: true; result: { availableModels: { id: string; name: string }[]; supportsFreeform: boolean } }>();
    const refreshed = { ok: true as const, result: {
        availableModels: [{ id: 'after', name: 'After' }], supportsFreeform: false,
    } };
    capabilityRpc.mockResolvedValue(refreshed).mockImplementationOnce(() => firstRead.promise);
    const render = (cwd: string, enabled = true) => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'shared-machine',
        capabilityServerId: preflight.serverId, cwd, enabled,
    }));
    const screen = await render('/repo');
    expect(screen.getCurrent().probe.phase).toBe('refreshing');
    const detail = await render('/repo');
    const other = await render('/other', false);
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
    const otherOptions = other.getCurrent().modelOptions;
    await act(async () => firstRead.resolve(refreshed));
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(screen.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['after']);
    });
    expect(screen.getCurrent().preflightModels).toBe(detail.getCurrent().preflightModels);
    expect(other.getCurrent().modelOptions).toBe(otherOptions);
    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    const cached = screen.getCurrent().preflightModels;
    await screen.unmount();
    await detail.unmount();
    await other.unmount();
    const pending = createDeferred<{ ok: true; result: { availableModels: { id: string; name: string }[]; supportsFreeform: boolean } }>();
    capabilityRpc.mockImplementationOnce(() => pending.promise);
    const reopened = await render('/repo');
    try {
        expect(reopened.getCurrent().preflightModels).toBe(cached);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
        });
        await act(async () => pending.resolve({ ok: true, result: {
            availableModels: [{ id: 'reopened', name: 'Reopened' }], supportsFreeform: false,
        } }));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(reopened.getCurrent().preflightModels?.availableModels.map(model => model.id)).toEqual(['reopened']);
        });
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
    } finally {
        pending.resolve({ ok: true, result: { availableModels: [], supportsFreeform: false } });
        await reopened.unmount();
    }
});

it('retains another model picker but releases an abandoned occurrence before remount', async () => {
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'owned-machine', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    cache.writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'retained', name: 'Retained' }], supportsFreeform: false });
    capabilityRpc.mockImplementationOnce(() => new Promise<never>(() => {}));
    capabilityRpc.mockResolvedValue({ ok: true, result: {
        availableModels: [{ id: 'remounted', name: 'Remounted' }], supportsFreeform: false,
    } });
    const render = () => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'owned-machine',
        capabilityServerId: preflight.serverId, cwd: '/repo',
    }));
    const first = await render();
    const retained = await render();
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
    await first.unmount();
    const joined = await render();
    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    expect(retained.getCurrent().probe.phase).toBe('refreshing');
    await retained.unmount();
    await joined.unmount();
    const remounted = await render();
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
        expect(remounted.getCurrent().preflightModels?.availableModels.map(model => model.id)).toEqual(['remounted']);
        expect(remounted.getCurrent().probe.phase).toBe('idle');
    });
    await remounted.unmount();
});

it.each([
  [false, { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' }],
  [true, { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' }],
  [false, { reason: 'error', errorCode: 'agent_isolation_unavailable', retryable: false }],
  [true, { reason: 'error', errorCode: 'agent_isolation_unavailable', retryable: false }],
] as const)('does not retry an unknown or nonretryable model outcome on the clock or remount (retained: %s, failure: %j)', async (retainGood, failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'unknown-model-machine',
        targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    if (retainGood) cache.writeDynamicModelProbeCacheSuccess(key, {
        availableModels: [{ id: 'retained', name: 'Retained' }], supportsFreeform: false,
    }, 900_000);
    cache.writeDynamicModelProbeCacheError(key, 1_000_000, undefined, failure);
    const render = () => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'unknown-model-machine',
        capabilityServerId: preflight.serverId, cwd: '/repo',
    }));
    const first = await render();
    expect(first.getCurrent().probe).toMatchObject({ phase: 'idle', ...failure });
    await act(async () => { await vi.advanceTimersByTimeAsync(cache.DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS + 1); });
    await first.unmount();
    const remounted = await render();
    expect(remounted.getCurrent().probe).toMatchObject(failure);
    expect(capabilityRpc).not.toHaveBeenCalled();
    expect(remounted.getCurrent().preflightModels?.availableModels.map(model => model.id) ?? []).toEqual(retainGood ? ['retained'] : []);
    await remounted.unmount();
    vi.useRealTimers();
});
