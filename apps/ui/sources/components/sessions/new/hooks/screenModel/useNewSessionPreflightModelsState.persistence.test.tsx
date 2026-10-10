import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';

const target = { kind: 'backend', backendId: 'codex' } as const;
const storageEntries = new Map<string, string>();
const localStorageBoundary = {
    getItem: (key: string) => storageEntries.get(key) ?? null,
    setItem: (key: string, value: string) => { storageEntries.set(key, value); },
    removeItem: (key: string) => { storageEntries.delete(key); },
};
const thinkingOption = {
    id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium',
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
} as const;
const speedOption = {
    id: 'service_tier', name: 'Speed', type: 'select', currentValue: 'standard',
    options: [{ value: 'standard', name: 'Standard' }, { value: 'fast', name: 'Fast' }],
} as const;
const legacySpeedOption = {
    id: 'speed', name: 'Fast', type: 'boolean', currentValue: 'standard',
    options: [{ value: 'standard', name: 'Standard' }, { value: 'fast', name: 'Fast' }],
} as const;
let probeResult: Readonly<Record<string, unknown>>;
const capabilityRpc = vi.fn(async () => ({ ok: true, result: probeResult }));
let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | undefined;
let serverId: string;

async function loadOwnerGraph() {
    await network?.dispose();
    vi.resetModules();
    // Keep Home credential admission, RPC schemas, discovery and persisted cache real.
    network = await installSessionOpsNetworkBoundary();
    serverId = (await network.addHome('https://model-probe-persistence.test', 'account-a')).id;
    network.setRpcResponder(async (request) => {
        expect(request.targetId).toBe('machine-1');
        expect(request.method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
        return capabilityRpc();
    });
    await loadSyncSingletonForTests();
    return import('./useNewSessionPreflightModelsState');
}

async function mountOwner(providerConnectionId: string | null = null) {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
    return renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: target, providerConnectionId, selectedMachineId: 'machine-1',
        capabilityServerId: serverId, cwd: '/repo',
    }));
}

function expectModelFields(list: PreflightModelList | null, modelId: string, option: typeof thinkingOption | typeof speedOption | typeof legacySpeedOption) {
    expect(list).toMatchObject({
        supportsFreeform: false,
        availableModels: [{ id: modelId, name: modelId, modelOptions: [option] }],
    });
    expect(list?.availableModels).toHaveLength(1);
}

describe('useNewSessionPreflightModelsState persistence through scoped daemon transport', () => {
    beforeEach(async () => {
        storageEntries.clear();
        capabilityRpc.mockClear();
        probeResult = { availableModels: [{ id: 'm1', name: 'm1', modelOptions: [thinkingOption] }], supportsFreeform: false };
        // Browser storage is a genuine persistence boundary and survives module reloads.
        vi.stubGlobal('window', { localStorage: localStorageBoundary });
        vi.stubGlobal('document', {});
        await loadOwnerGraph();
        const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
        resetDynamicModelProbeCacheForTests();
    });
    afterEach(async () => {
        await standardCleanup();
        await network?.dispose();
        network = undefined;
        vi.unstubAllGlobals();
    });

    it('does not reuse a native probe cache entry for a Provider connection on the same target', async () => {
        const native = await mountOwner();
        expectModelFields(native.getCurrent().preflightModels, 'm1', thinkingOption);
        await native.unmount();
        const provider = await mountOwner('pc_01J00000000000000000000000');
        expectModelFields(provider.getCurrent().preflightModels, 'm1', thinkingOption);
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
    });

    it('hydrates cached results across module reloads without another daemon probe', async () => {
        const first = await mountOwner();
        expectModelFields(first.getCurrent().preflightModels, 'm1', thinkingOption);
        await first.unmount();
        await loadOwnerGraph();
        const restarted = await mountOwner();
        expectModelFields(restarted.getCurrent().preflightModels, 'm1', thinkingOption);
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });

    it('does not persist static fallback probe results across module reloads', async () => {
        probeResult = { provider: 'codex', source: 'static', availableModels: [{ id: 'm1', name: 'm1' }], supportsFreeform: false };
        const first = await mountOwner();
        expect(first.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['m1']);
        await first.unmount();
        await loadOwnerGraph();
        const restarted = await mountOwner();
        expect(restarted.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['m1']);
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
    });

    it.each([
        { version: 3, reason: 'legacy model-option contract', modelId: 'gpt-5.4', option: legacySpeedOption,
            legacyOptions: [{ id: 'speed', name: 'Fast', type: 'boolean', currentValue: false }] },
        { version: 4, reason: 'model options metadata', modelId: 'gpt-5.4', option: thinkingOption, legacyOptions: undefined },
        { version: 6, reason: 'GPT 5.6 Speed metadata', modelId: 'gpt-5.6-sol', option: speedOption, legacyOptions: undefined },
    ])('re-probes persisted version $version entries predating $reason', async ({ version, modelId, option, legacyOptions }) => {
        const key = buildDynamicModelProbeCacheKey({ machineId: 'machine-1', targetKey: resolveBackendTargetKeyV2(target),
            providerConnectionId: null, serverId, cwd: '/repo' });
        if (!key) throw new Error('Expected an exact scoped model cache key');
        localStorageBoundary.setItem('dynamic-model-probe-cache-v1', JSON.stringify({
            version, entries: { [key]: { updatedAt: Date.now(), value: {
                availableModels: [{ id: modelId, name: modelId, ...(legacyOptions ? { modelOptions: legacyOptions } : {}) }],
                supportsFreeform: false,
            } } },
        }));
        probeResult = { availableModels: [{ id: modelId, name: modelId, modelOptions: [option] }], supportsFreeform: false };
        const current = await mountOwner();
        expectModelFields(current.getCurrent().preflightModels, modelId, option);
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
});
