import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol';
import { SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE } from '@/sync/runtime/sessionMachineRpcErrorCodes';
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

afterEach(() => {
    machineRpcWithServerScopeMock.mockReset();
});

describe('searchDaemonMemory', () => {
    const query = {
        serverId: 'server-a', accountId: 'account-a', machineId: 'machine-a',
        query: 'fact', scope: { type: 'global' as const }, mode: 'auto' as const,
    };
    const status = {
        v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
        deepIndexReady: true, activeIndexReady: true, embeddingsEnabled: false,
        embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
        embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
        tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
    };
    const transcriptHit = {
        sessionId: 'session-1', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
        summary: 'A matching past Session', score: 0.5,
    };
    const documentHit = {
        type: 'artifact', ref: { kind: 'doc', serverId: 'server-a', artifactId: 'doc-1' },
        revision: { headerVersion: 1, bodyVersion: 2 }, location: 'archive', factId: 'fact-1',
        summary: 'A matching archived fact', score: 0.8,
    };

    it('negotiates document support at the exact Account target before requesting mixed corpora', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ...status, documentSearchSupported: true });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1, ok: true, hits: [documentHit, transcriptHit], documents: { state: 'ready' },
        });
        const controller = new AbortController();
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            ...query, corpora: ['documents', 'sessions'], eligibleSessionIds: [], signal: controller.signal,
        });
        expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toMatchObject({
            serverId: 'server-a', accountId: 'account-a', machineId: 'machine-a',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS, signal: controller.signal,
        });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]).toMatchObject({
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: { corpora: ['documents', 'sessions'] }, signal: controller.signal,
        });
        expect(result).toEqual({ v: 1, ok: true, hits: [documentHit], documents: { state: 'ready' } });
    });

    it('preserves old-peer transcripts and reports unavailable documents without sending an ignorable corpus field', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(status);
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ v: 1, ok: true, hits: [transcriptHit] });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0].payload).not.toHaveProperty('corpora');
        expect(result).toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
    });

    it('never replaces an unsupported documents-only request with transcript search', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce(status);
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({ ...query, corpora: ['documents'] });
        expect(machineRpcWithServerScopeMock.mock.calls.map(([call]) => call.method))
            .toEqual([RPC_METHODS.DAEMON_MEMORY_STATUS]);
        expect(result).toEqual({ v: 1, ok: true, hits: [], documents: { state: 'unavailable' } });
    });

    it('does not label a document-capable peer transcript-only response as complete', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ...status, documentSearchSupported: true });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ v: 1, ok: true, hits: [transcriptHit] });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        expect(await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
    });

    it('cancels after a capability probe without submitting the search', async () => {
        const controller = new AbortController();
        machineRpcWithServerScopeMock.mockImplementationOnce(async () => {
            controller.abort();
            return { ...status, documentSearchSupported: true };
        });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({ ...query, corpora: ['documents'], signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(machineRpcWithServerScopeMock.mock.calls.map(([call]) => call.method))
            .toEqual([RPC_METHODS.DAEMON_MEMORY_STATUS]);
    });

    it('treats a missing old-peer status method as document unavailability while keeping Session search', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('No status method'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ v: 1, ok: true, hits: [transcriptHit] });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        expect(await searchDaemonMemory({ ...query, corpora: ['sessions', 'documents'] }))
            .toEqual({ v: 1, ok: true, hits: [transcriptHit], documents: { state: 'unavailable' } });
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0].payload).not.toHaveProperty('corpora');
    });
    it('calls daemon memory search through server-scoped machine RPC and parses hits', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-1',
                seqFrom: 2,
                seqTo: 4,
                createdAtFromMs: 10,
                createdAtToMs: 20,
                summary: 'Vector cache summary',
                score: 0.72,
            }],
        });

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: ' vector cache ',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 20,
            timeoutMs: 1500,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
            payload: {
                v: 1,
                query: 'vector cache',
                scope: { type: 'global' },
                mode: 'auto',
                maxResults: 20,
            },
            timeoutMs: 1500,
            preferScoped: true,
        });
        expect(result).toEqual({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-1',
                seqFrom: 2,
                seqTo: 4,
                createdAtFromMs: 10,
                createdAtToMs: 20,
                summary: 'Vector cache summary',
                score: 0.72,
            }],
        });
    });

    it('normalizes daemon memory search unavailability into a non-fatal result', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        }));

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        });

        expect(result).toMatchObject({
            v: 1,
            ok: false,
            errorCode: 'memory_index_missing',
        });
    });

    it('preserves machine-target unavailability as a transport/reachability outcome', async () => {
        const unavailable = Object.assign(new Error('Machine target is offline'), {
            rpcErrorCode: SESSION_MACHINE_TARGET_UNAVAILABLE_ERROR_CODE,
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(unavailable);

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
        })).rejects.toBe(unavailable);
    });

    it('sends contextual Session eligibility and rejects unfiltered legacy hits', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'active-session',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Legacy daemon ignored eligibility',
                score: 1,
            }, {
                sessionId: 'archived-session',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Eligible archived result',
                score: 0.9,
            }],
        });

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            eligibleSessionIds: ['archived-session'],
            maxResults: 20,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ eligibleSessionIds: ['archived-session'] }),
        }));
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            hits: [expect.objectContaining({ sessionId: 'archived-session' })],
        }));
    });

    it('threads the caller AbortSignal into the incumbent machine RPC cancellation path', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ v: 1, ok: true, hits: [] });
        const controller = new AbortController();

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            signal: controller.signal,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    it('reports an already-aborted request without issuing a machine RPC', async () => {
        const controller = new AbortController();
        controller.abort();

        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        await expect(searchDaemonMemory({
            serverId: 'server-a',
            accountId: 'account-a',
            machineId: 'machine-a',
            query: 'vector cache',
            scope: { type: 'global' },
            mode: 'auto',
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
