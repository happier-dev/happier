import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('./sessionMachineTarget', async () => {
    const actual = await vi.importActual<typeof import('./sessionMachineTarget')>('./sessionMachineTarget');
    return {
        ...actual,
        readMachineTargetForSession: readMachineTargetForSessionMock,
    };
});

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: vi.fn(),
        sessionRPC: vi.fn(),
    },
}));

describe('sessions ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockReturnValue(null);
    });

    it('routes resume session spawn through server-scoped rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-1' });
        const { resumeSession } = await import('./sessions');

        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-1' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'spawn-happy-session',
            serverId: 'server-b',
        }));
    });

    it('routes continue-with-replay through server-scoped machine rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess-2' });
        const { continueSessionWithReplay } = await import('./sessions');
        const summaryRunner = { v: 1, backendId: 'claude', modelId: 'default', permissionMode: 'no_tools' } as const;

        const result = await continueSessionWithReplay({
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            approvedNewDirectoryCreation: true,
            replay: {
                previousSessionId: 'sess-prev',
                strategy: 'summary_plus_recent',
                recentMessagesCount: 2,
                maxSeedChars: 12_345,
                summaryRunner,
            },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ type: 'success', sessionId: 'sess-2' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'session.continueWithReplay',
            serverId: 'server-b',
            payload: expect.objectContaining({
                replay: expect.objectContaining({ summaryRunner, maxSeedChars: 12_345 }),
            }),
        }));
    });

    it('routes session fork through server-scoped machine rpc with requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess-child' });
        const { forkSession } = await import('./sessions');
        const replaySummaryRunner = { v: 1, backendId: 'claude', modelId: 'default', permissionMode: 'no_tools' } as const;

        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            replaySummaryRunner,
            replayMaxSeedChars: 55_000,
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: 'session.fork',
            serverId: 'server-b',
            payload: expect.objectContaining({ replaySummaryRunner, replayMaxSeedChars: 55_000 }),
        }));
    });

    it('prefers reachable machine target from parent session for forkSession', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, childSessionId: 'sess-child' });
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'reachable-machine', basePath: '/tmp' });
        const { forkSession } = await import('./sessions');

        const result = await forkSession({
            machineId: 'stale-machine',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
        } as any);

        expect(result).toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'reachable-machine',
            method: 'session.fork',
            serverId: 'server-b',
        }));
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for forkSession', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { forkSession } = await import('./sessions');

        const result = await forkSession({
            machineId: 'machine-1',
            parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' },
            serverId: 'server-b',
        } as any);

        expect(result.ok).toBe(false);
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for resumeSession', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { resumeSession } = await import('./sessions');

        const result = await resumeSession({
            sessionId: 'session-1',
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('error');
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });

    it('maps RPC method-not-available to DAEMON_RPC_UNAVAILABLE for continueSessionWithReplay', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { continueSessionWithReplay } = await import('./sessions');

        const result = await continueSessionWithReplay({
            machineId: 'machine-1',
            directory: '/tmp',
            agent: 'claude',
            approvedNewDirectoryCreation: true,
            replay: { previousSessionId: 'sess-prev' },
            serverId: 'server-b',
        } as any);

        expect(result.type).toBe('error');
        expect((result as any).errorCode).toBe('DAEMON_RPC_UNAVAILABLE');
    });
});
