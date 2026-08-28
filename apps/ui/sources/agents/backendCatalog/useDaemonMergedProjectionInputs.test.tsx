import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

const projectionState = vi.hoisted(() => ({
    revision: 0,
    listener: null as (() => void) | null,
    generation: 1,
    entryIsFresh: false,
    cachedEntry: null as ReturnType<typeof readyEntry> | {
        kind: 'error';
        fetchedAtMs: number;
        inputs: ReturnType<typeof readyEntry>['inputs'];
    } | null,
}));
const loadDaemonMergedProjectionCacheEntryMock = vi.hoisted(() => vi.fn());
const retainMountedTargetProjectionCacheScopeMock = vi.hoisted(() => vi.fn());
const activeAccountLifetime = vi.hoisted(() => ({
    value: null as Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }> | null,
}));

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
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('./loadDaemonMergedProjectionInputs', () => ({
    entryIsFresh: () => projectionState.entryIsFresh,
    readCachedDaemonMergedProjectionCacheEntry: () => projectionState.cachedEntry,
    loadDaemonMergedProjectionCacheEntry: loadDaemonMergedProjectionCacheEntryMock,
    retainMountedTargetProjectionCacheScope: retainMountedTargetProjectionCacheScopeMock,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
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

function createAccountLifetime(accountId: string) {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
}

describe('useDaemonMergedProjectionInputs', () => {
    beforeEach(() => {
        projectionState.revision = 0;
        projectionState.listener = null;
        projectionState.generation = 1;
        projectionState.entryIsFresh = false;
        projectionState.cachedEntry = null;
        loadDaemonMergedProjectionCacheEntryMock.mockReset();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async () => readyEntry(projectionState.generation));
        retainMountedTargetProjectionCacheScopeMock.mockReset();
        retainMountedTargetProjectionCacheScopeMock.mockImplementation(() => () => {});
        activeAccountLifetime.value = createAccountLifetime('account-a');
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

    it('revalidates instead of serving a fresh cached failure as authoritative', async () => {
        projectionState.entryIsFresh = true;
        projectionState.cachedEntry = {
            kind: 'error',
            fetchedAtMs: Date.now(),
            inputs: readyEntry(1).inputs,
        };

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const renderedPhases: string[] = [];
        const hook = await renderHook(() => {
            const state = useDaemonMergedProjectionInputs({
                machineId: 'machine-1',
                serverId: 'server-1',
            });
            renderedPhases.push(state.phase);
            return state;
        });

        expect(renderedPhases[0]).toBe('loading');
        expect(loadDaemonMergedProjectionCacheEntryMock).toHaveBeenCalledTimes(1);

        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({
            phase: 'ready',
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

    it('does not expose a projection from another server when the machine id is unchanged', async () => {
        const serverTwoLoad = createDeferred<ReturnType<typeof readyEntry>>();
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async (params: Readonly<{ serverId: string }>) => {
            if (params.serverId === 'server-2') {
                return await serverTwoLoad.promise;
            }
            return readyEntry(1);
        });

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(
            (serverId: string) => useDaemonMergedProjectionInputs({
                machineId: 'machine-1',
                serverId,
            }),
            { initialProps: 'server-1' },
        );
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(hook.getCurrent().phase).toBe('ready');
        await hook.rerender('server-2');
        expect(hook.getCurrent()).toEqual({
            phase: 'loading',
            inputs: null,
        });

        serverTwoLoad.resolve(readyEntry(2));
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

    it('releases a target-scoped projection cache entry when its mounted host unmounts', async () => {
        const release = vi.fn();
        retainMountedTargetProjectionCacheScopeMock.mockReturnValueOnce(release);
        const mountedTarget = {
            pluginId: 'acme.preview',
            immutableGenerationId: 'target-generation-a',
        } as const;
        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(() => useDaemonMergedProjectionInputs({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
        }));

        expect(retainMountedTargetProjectionCacheScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
        }));

        await hook.unmount();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('fences a target cache lifecycle to the captured Account lifetime on an Account replacement', async () => {
        const mountedTarget = {
            pluginId: 'acme.preview',
            immutableGenerationId: 'target-generation-a',
        } as const;
        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        activeAccountLifetime.value = accountA;
        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(
            (renderRevision: number) => useDaemonMergedProjectionInputs({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                refreshKey: renderRevision,
            }),
            { initialProps: 0 },
        );
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(retainMountedTargetProjectionCacheScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            accountLifetime: accountA,
        }));
        expect(loadDaemonMergedProjectionCacheEntryMock).toHaveBeenLastCalledWith(expect.objectContaining({
            accountLifetime: accountA,
        }));

        activeAccountLifetime.value = accountB;
        await hook.rerender(1);
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(retainMountedTargetProjectionCacheScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            accountLifetime: accountB,
        }));
        expect(loadDaemonMergedProjectionCacheEntryMock).toHaveBeenLastCalledWith(expect.objectContaining({
            accountLifetime: accountB,
        }));
    });

    it('does not render Account A target inputs while Account B loads the same target', async () => {
        const mountedTarget = {
            pluginId: 'acme.preview',
            immutableGenerationId: 'target-generation-a',
        } as const;
        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        const accountBLoad = createDeferred<ReturnType<typeof readyEntry>>();
        activeAccountLifetime.value = accountA;
        loadDaemonMergedProjectionCacheEntryMock.mockImplementation(async (params: Readonly<{
            accountLifetime?: unknown;
        }>) => {
            if (params.accountLifetime === accountB) return await accountBLoad.promise;
            return readyEntry(1);
        });

        const { useDaemonMergedProjectionInputs } = await import('./useDaemonMergedProjectionInputs');
        const hook = await renderHook(
            (renderRevision: number) => useDaemonMergedProjectionInputs({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                refreshKey: renderRevision,
                retainInputsAcrossScopeChange: true,
            }),
            { initialProps: 0 },
        );
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({
            phase: 'ready',
            inputs: { pluginProjectionV2: { generation: 1 } },
        });

        activeAccountLifetime.value = accountB;
        await hook.rerender(1);

        expect(hook.getCurrent()).toEqual({
            phase: 'loading',
            inputs: null,
        });

        accountBLoad.resolve(readyEntry(2));
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({
            phase: 'ready',
            inputs: { pluginProjectionV2: { generation: 2 } },
        });
    });
});
