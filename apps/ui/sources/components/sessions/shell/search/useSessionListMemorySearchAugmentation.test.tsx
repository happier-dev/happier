import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { RPC_METHODS } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { FlushHookEffectsOptions } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useSessionListMemorySearchAugmentation } from './useSessionListMemorySearchAugmentation';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const featureEnabledState = vi.hoisted(() => ({ memorySearch: true }));
const activeServerState = vi.hoisted(() => ({ serverId: 'server-a' as string | null }));
const machinesState = vi.hoisted(() => ({
    machines: [{
        id: 'machine-a',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: 'machine-a',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/tmp/happier',
            homeDir: '/tmp',
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    }] satisfies Machine[],
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'memory.search' && featureEnabledState.memorySearch,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: activeServerState.serverId, generation: 1 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useFirstVisibleMachineId: (enabled: boolean = true) => (
                enabled ? machinesState.machines[0]?.id ?? null : null
            ),
        },
    });
});

function createMemoryStatusResponse(searchable: boolean) {
    return {
        v: 1,
        enabled: true,
        indexMode: 'hints',
        hintsIndexReady: true,
        deepIndexReady: false,
        activeIndexReady: true,
        activeIndexSearchable: searchable,
        indexContent: searchable
            ? {
                lightShardCount: 1,
                lightTermCount: 12,
                deepChunkCount: 0,
                deepEmbeddingCount: 0,
                searchableSessionCount: 1,
                lastIndexedAtMs: 1,
                latestIndexedMessageAtMs: 1,
            }
            : null,
        embeddingsEnabled: false,
        embeddingsMode: 'disabled',
        embeddingsPresetId: null,
        embeddingsProviderKind: null,
        embeddingsModelId: null,
        embeddingsRuntimeState: 'ready',
        embeddingsUsingFallback: false,
        tier1DbPath: '/tmp/memory.sqlite',
        deepDbPath: null,
        tier1DbBytes: 1024,
        deepDbBytes: null,
    };
}

function createMemorySearchHit(sessionId: string, summary = 'Matching summary', score = 0.9) {
    return {
        sessionId,
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        summary,
        score,
    };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

async function renderMemoryAugmentationHook(props: Readonly<{
    searchQuery: string;
    getCandidateSessionKeys: () => ReadonlySet<string>;
    enabled?: boolean;
}>, options?: Readonly<{ flushOptions?: FlushHookEffectsOptions }>) {
    return await renderHook(
        (nextProps: typeof props) => useSessionListMemorySearchAugmentation(nextProps),
        { initialProps: props, flushOptions: options?.flushOptions },
    );
}

afterEach(() => {
    vi.useRealTimers();
    machineRpcWithServerScopeMock.mockReset();
    featureEnabledState.memorySearch = true;
    activeServerState.serverId = 'server-a';
    standardCleanup();
});

describe('useSessionListMemorySearchAugmentation', () => {
    it('publishes indexed exclusions and clears them when the query changes', async () => {
        vi.useFakeTimers();
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return createMemoryStatusResponse(true);
            return { v: 1, ok: true, querySyntaxVersion: 1, hits: [], excludedSessionIds: ['session-1', 'outside'] };
        });
        const candidates = new Set(['server-a:session-1']);
        const props = { searchQuery: '-umbrella', getCandidateSessionKeys: () => candidates };
        const hook = await renderMemoryAugmentationHook(props);
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        expect([...hook.getCurrent().memoryExcludedSessionKeys]).toEqual(['server-a:session-1']);
        await hook.rerender({ ...props, searchQuery: 'another' });
        expect(hook.getCurrent().memoryExcludedSessionKeys.size).toBe(0);
    });

    it('does not call the daemon when the list surface is not data-active', async () => {
        vi.useFakeTimers();
        const getCandidateSessionKeys = vi.fn(() => new Set(['server-a:session-1']));
        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys,
            enabled: false,
        });

        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(getCandidateSessionKeys).not.toHaveBeenCalled();
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('keeps the idle empty state stable for short queries', async () => {
        const candidateSessionKeys = new Set(['server-a:session-1']);
        let commitCount = 0;
        let latestState: unknown;
        const Wrapper = (props: React.PropsWithChildren) => (
            <React.Profiler id="memory-search-hook" onRender={() => {
                commitCount += 1;
            }}>
                {props.children}
            </React.Profiler>
        );
        const Harness = (props: Readonly<{ searchQuery: string; getCandidateSessionKeys: () => ReadonlySet<string> }>) => {
            latestState = useSessionListMemorySearchAugmentation(props);
            return null;
        };

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <Wrapper>
                    <Harness searchQuery="" getCandidateSessionKeys={() => candidateSessionKeys} />
                </Wrapper>,
            );
        });
        const initialState = latestState;

        expect(commitCount).toBe(1);
        expect(latestState).toBe(initialState);

        act(() => {
            tree.update(
                <Wrapper>
                    <Harness searchQuery="v" getCandidateSessionKeys={() => candidateSessionKeys} />
                </Wrapper>,
            );
        });
        const rerenderedState = latestState;

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(commitCount).toBe(2);
        expect(latestState).toBe(rerenderedState);
        act(() => {
            tree.unmount();
        });
    });

    it('does not call the daemon for short queries', async () => {
        vi.useFakeTimers();
        const getCandidateSessionKeys = vi.fn(() => new Set(['server-a:session-1']));
        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'v',
            getCandidateSessionKeys,
        });

        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(getCandidateSessionKeys).not.toHaveBeenCalled();
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('does not build candidates when memory search is disabled', async () => {
        featureEnabledState.memorySearch = false;
        const getCandidateSessionKeys = vi.fn(() => new Set(['server-a:session-1']));

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys,
        });

        expect(getCandidateSessionKeys).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
    });

    it('shows loading while daemon status is pending', async () => {
        vi.useFakeTimers();
        const status = createDeferred<unknown>();
        machineRpcWithServerScopeMock.mockImplementation((params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return status.promise;
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) throw new Error('search should wait for status');
            throw new Error('unexpected rpc');
        });

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1']),
        });

        await flushHookEffects({ advanceTimersMs: 300, cycles: 2 });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        }));
        expect(hook.getCurrent().isSearchingMemory).toBe(true);
    });

    it('adds daemon memory matches for current candidate sessions only', async () => {
        vi.useFakeTimers();
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return createMemoryStatusResponse(true);
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) {
                return {
                    v: 1,
                    ok: true,
                    hits: [
                        createMemorySearchHit('session-1'),
                        createMemorySearchHit('session-2', 'Out of scope summary'),
                    ],
                };
            }
            throw new Error('unexpected rpc');
        });

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1']),
        });

        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: expect.objectContaining({ query: 'vector', maxResults: 50 }),
        }));
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('keeps current-query matches stable while candidate inputs churn', async () => {
        vi.useFakeTimers();
        let searchCallCount = 0;
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return createMemoryStatusResponse(true);
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) {
                searchCallCount += 1;
                return {
                    v: 1,
                    ok: true,
                    hits: searchCallCount === 1
                        ? [createMemorySearchHit('session-1', 'Initial summary')]
                        : [
                            createMemorySearchHit('session-1', 'Initial summary'),
                            createMemorySearchHit('session-2', 'Expanded summary', 0.8),
                        ],
                };
            }
            throw new Error('unexpected rpc');
        });

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1']),
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(searchCallCount).toBe(1);

        await hook.rerender({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1']),
        });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(searchCallCount).toBe(1);

        await hook.rerender({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1', 'server-a:session-2']),
        });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);

        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1', 'server-a:session-2']);
        expect(searchCallCount).toBe(2);
    });

    it('does not search when daemon status is unusable', async () => {
        vi.useFakeTimers();
        machineRpcWithServerScopeMock.mockImplementation(async (params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return createMemoryStatusResponse(false);
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) throw new Error('search should not run');
            throw new Error('unexpected rpc');
        });

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1']),
        });

        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect(machineRpcWithServerScopeMock.mock.calls.filter(([params]) => params?.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)).toHaveLength(0);
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('ignores stale daemon memory search responses', async () => {
        vi.useFakeTimers();
        const firstSearch = createDeferred<unknown>();
        machineRpcWithServerScopeMock.mockImplementation((params: { method?: string; payload?: { query?: string } }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return Promise.resolve(createMemoryStatusResponse(true));
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH && params.payload?.query === 'vector') {
                return firstSearch.promise;
            }
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH && params.payload?.query === 'parser') {
                return Promise.resolve({
                    v: 1,
                    ok: true,
                    hits: [createMemorySearchHit('session-2', 'Fresh summary')],
                });
            }
            throw new Error('unexpected rpc');
        });

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys: () => new Set(['server-a:session-1', 'server-a:session-2']),
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });

        await hook.rerender({
            searchQuery: 'parser',
            getCandidateSessionKeys: () => new Set(['server-a:session-1', 'server-a:session-2']),
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });
        firstSearch.resolve({
            v: 1,
            ok: true,
            hits: [createMemorySearchHit('session-1', 'Stale summary')],
        });
        await flushHookEffects({ cycles: 3 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-2']);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('parser');
    });

    it('cancels an in-flight search while inactive and refreshes the current query on resume', async () => {
        vi.useFakeTimers();
        const firstSearch = createDeferred<unknown>();
        let searchCallCount = 0;
        machineRpcWithServerScopeMock.mockImplementation((params: { method?: string }) => {
            if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) {
                return Promise.resolve(createMemoryStatusResponse(true));
            }
            if (params.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) {
                searchCallCount += 1;
                if (searchCallCount === 1) return firstSearch.promise;
                return Promise.resolve({
                    v: 1,
                    ok: true,
                    hits: [createMemorySearchHit('session-1', 'Resumed summary')],
                });
            }
            throw new Error('unexpected rpc');
        });
        const getCandidateSessionKeys = () => new Set(['server-a:session-1']);

        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            getCandidateSessionKeys,
            enabled: true,
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });
        expect(searchCallCount).toBe(1);

        await hook.rerender({
            searchQuery: 'vector',
            getCandidateSessionKeys,
            enabled: false,
        });
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);

        firstSearch.resolve({
            v: 1,
            ok: true,
            hits: [createMemorySearchHit('session-1', 'Stale summary')],
        });
        await flushHookEffects({ cycles: 3 });
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);

        await hook.rerender({
            searchQuery: 'vector',
            getCandidateSessionKeys,
            enabled: true,
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect(searchCallCount).toBe(2);
        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(hook.getCurrent().lastSuccessfulQuery).toBe('vector');
    });
});
