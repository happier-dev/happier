import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

const projectionState = vi.hoisted(() => ({
    revision: 0,
    listener: null as (() => void) | null,
    generation: 1,
    cachedEntry: null as ReturnType<typeof readyEntry> | {
        kind: 'error';
        fetchedAtMs: number;
        inputs: ReturnType<typeof readyEntry>['inputs'];
    } | null,
}));
const loadDaemonMergedProjectionCacheEntryMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => projectionState.revision,
    subscribeMachineContributionRegistryProjectionInvalidation: (
        _scope: unknown,
        listener: () => void,
    ) => {
        projectionState.listener = listener;
        return () => {
            if (projectionState.listener === listener) projectionState.listener = null;
        };
    },
}));

vi.mock('./loadDaemonMergedProjectionInputs', () => ({
    entryIsFresh: () => false,
    readCachedDaemonMergedProjectionCacheEntry: () => projectionState.cachedEntry,
    loadDaemonMergedProjectionCacheEntry: loadDaemonMergedProjectionCacheEntryMock,
}));

function readyEntry(generation: number) {
    return {
        kind: 'ready' as const,
        fetchedAtMs: generation,
        inputs: {
            mergedProviderProjectionById: {},
            mergedBackendProjectionById: {},
            discoveredBackendIds: [],
            pluginProjectionById: {},
            registryDiagnostics: [],
            pluginProjectionV2: {
                v: 2,
                generation,
                familiesById: {
                    scmBackends: { family: 'scmBackends', entriesById: {} },
                    scmHostingProviders: { family: 'scmHostingProviders', entriesById: {} },
                },
            },
        },
    };
}

describe('useDaemonMergedProjectionInputs', () => {
    beforeEach(() => {
        projectionState.revision = 0;
        projectionState.listener = null;
        projectionState.generation = 1;
        projectionState.cachedEntry = null;
        loadDaemonMergedProjectionCacheEntryMock.mockReset();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async () => readyEntry(projectionState.generation));
    });

    it('reloads the authoritative projection when plugin mutation invalidates the active machine scope', async () => {
        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(1);
        expect(projectionState.listener).not.toBeNull();

        const reload = createDeferred<ReturnType<typeof readyEntry>>();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementationOnce(async () => await reload.promise);
        projectionState.revision = 1;
        await act(async () => {
            projectionState.listener?.();
        });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'loading',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });

        reload.resolve(readyEntry(2));
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(hook.getCurrent().inputs?.pluginProjectionV2?.generation).toBe(2);
        expect(loadDaemonMergedProjectionCacheEntryMock).toHaveBeenCalledTimes(2);
    });

    it('retains the last ready projection as stale metadata when an invalidation refresh fails', async () => {
        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'ready',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });

        loadDaemonMergedProjectionCacheEntryMock.mockResolvedValueOnce({
            kind: 'error',
            fetchedAtMs: 2,
        });
        projectionState.revision = 1;
        await act(async () => {
            projectionState.listener?.();
        });
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'error',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });
    });

    it('restores inert stale metadata from an error cache entry after remount', async () => {
        projectionState.cachedEntry = {
            kind: 'error',
            fetchedAtMs: 2,
            inputs: readyEntry(1).inputs,
        };
        loadDaemonMergedProjectionCacheEntryMock.mockResolvedValueOnce(projectionState.cachedEntry);

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'error',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });
    });

    it('does not expose the previous machine projection while a newly selected machine loads', async () => {
        const machineTwoLoad = createDeferred<ReturnType<typeof readyEntry>>();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async (params: Readonly<{ machineId: string }>) => {
            if (params.machineId === 'machine-2') {
                return await machineTwoLoad.promise;
            }
            return readyEntry(1);
        });

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(
            (machineId: string) => useDaemonMergedProjectionInputs({
                machineId,
                serverId: 'server-1',
            }),
            { initialProps: 'machine-1' },
        );
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'ready',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });

        await hook.rerender('machine-2');

        expect(hook.getCurrent()).toEqual({
            phase: 'loading',
            inputs: null,
        });

        machineTwoLoad.resolve(readyEntry(2));
        await flushHookEffects({ cycles: 3, turns: 2 });
    });

    it('can retain inert projection metadata across a route-driven authority change', async () => {
        const replacementLoad = createDeferred<ReturnType<typeof readyEntry>>();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async (params: Readonly<{ machineId: string }>) => {
            if (params.machineId === 'machine-2') {
                return await replacementLoad.promise;
            }
            return readyEntry(1);
        });

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(
            (scope: Readonly<{ machineId: string; serverId: string }>) => useDaemonMergedProjectionInputs({
                ...scope,
                retainInputsAcrossScopeChange: true,
            }),
            { initialProps: { machineId: 'machine-1', serverId: 'server-1' } },
        );
        await flushHookEffects({ cycles: 3, turns: 2 });

        await hook.rerender({ machineId: 'machine-2', serverId: 'server-2' });

        expect(hook.getCurrent()).toMatchObject({
            phase: 'loading',
            inputs: {
                pluginProjectionV2: { generation: 1 },
            },
        });

        replacementLoad.resolve(readyEntry(2));
        await flushHookEffects({ cycles: 3, turns: 2 });
    });
});
