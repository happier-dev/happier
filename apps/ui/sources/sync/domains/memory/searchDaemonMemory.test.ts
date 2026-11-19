import { describe, expect, it, vi, afterEach } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

afterEach(() => {
    machineRpcWithServerScopeMock.mockReset();
});

describe('searchDaemonMemory', () => {
    it.each(['"continue with"', 'continue -umbrella', '-"umbrella pigs"'])(
        'rejects unverified legacy daemon results for %s',
        async (query) => {
            machineRpcWithServerScopeMock.mockResolvedValueOnce({ v: 1, ok: true, hits: [] });
            const { searchDaemonMemory } = await import('./searchDaemonMemory');
            const result = await searchDaemonMemory({
                serverId: 'server-a', machineId: 'machine-a', query,
                scope: { type: 'global' }, mode: 'auto',
            });
            expect(result).toMatchObject({ ok: false, errorCode: 'memory_invalid_query' });
        },
    );

    it('accepts verified syntax and preserves indexed session exclusions', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            v: 1, ok: true, hits: [], querySyntaxVersion: 1, excludedSessionIds: ['session-1'],
        });
        const { searchDaemonMemory } = await import('./searchDaemonMemory');
        const result = await searchDaemonMemory({
            serverId: 'server-a', machineId: 'machine-a', query: '-"umbrella pigs"',
            scope: { type: 'global' }, mode: 'auto',
        });
        expect(result).toMatchObject({ ok: true, querySyntaxVersion: 1, excludedSessionIds: ['session-1'] });
    });

    it('calls daemon.memory.search through the server-scoped machine RPC and parses hits', async () => {
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
            machineId: 'machine-a',
            query: ' vector cache ',
            scope: { type: 'global' },
            mode: 'auto',
            maxResults: 20,
            timeoutMs: 1500,
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            serverId: 'server-a',
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
});
