import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

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
            useAllMachines: () => machinesState.machines,
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

async function renderMemoryAugmentationHook(props: Readonly<{
    searchQuery: string;
    candidateSessionKeys: ReadonlySet<string>;
    enabled?: boolean;
}>) {
    const { useSessionListMemorySearchAugmentation } = await import('./useSessionListMemorySearchAugmentation');
    return await renderHook(
        (nextProps: typeof props) => useSessionListMemorySearchAugmentation(nextProps),
        { initialProps: props },
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
    it('does not call the daemon for short queries', async () => {
        vi.useFakeTimers();
        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'v',
            candidateSessionKeys: new Set(['server-a:session-1']),
        });

        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
    });

    it('does not call the daemon when the surface is not data-active', async () => {
        vi.useFakeTimers();
        const hook = await renderMemoryAugmentationHook({
            searchQuery: 'vector',
            candidateSessionKeys: new Set(['server-a:session-1']),
            enabled: false,
        });

        await flushHookEffects({ advanceTimersMs: 500, cycles: 2 });

        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().memoryMatchedSessionKeys.size).toBe(0);
        expect(hook.getCurrent().isSearchingMemory).toBe(false);
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
            candidateSessionKeys: new Set(['server-a:session-1']),
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
            candidateSessionKeys: new Set(['server-a:session-1']),
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
            candidateSessionKeys: new Set(['server-a:session-1']),
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(searchCallCount).toBe(1);

        await hook.rerender({
            searchQuery: 'vector',
            candidateSessionKeys: new Set(['server-a:session-1']),
        });
        await flushHookEffects({ advanceTimersMs: 500, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);
        expect(searchCallCount).toBe(1);

        await hook.rerender({
            searchQuery: 'vector',
            candidateSessionKeys: new Set(['server-a:session-1', 'server-a:session-2']),
        });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1']);

        await flushHookEffects({ advanceTimersMs: 300, cycles: 4 });

        expect([...hook.getCurrent().memoryMatchedSessionKeys]).toEqual(['server-a:session-1', 'server-a:session-2']);
        expect(searchCallCount).toBe(2);
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
            candidateSessionKeys: new Set(['server-a:session-1', 'server-a:session-2']),
        });
        await flushHookEffects({ advanceTimersMs: 300, cycles: 3 });

        await hook.rerender({
            searchQuery: 'parser',
            candidateSessionKeys: new Set(['server-a:session-1', 'server-a:session-2']),
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
});
