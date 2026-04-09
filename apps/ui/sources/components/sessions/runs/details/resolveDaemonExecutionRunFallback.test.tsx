import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolvePreferredServerIdForSessionIdSpy = vi.hoisted(() => vi.fn<(sessionId: string) => string | undefined>());
const resolveSessionTargetServerIdSpy = vi.hoisted(() => vi.fn<(_sessionId: string, fallbackServerId?: string | null) => string | null>());
const machineExecutionRunsListSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                s1: {
                    metadata: { machineId: 'm1' },
                    serverId: 'server_fallback',
                },
            },
        }),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdSpy(sessionId),
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (...args: unknown[]) => resolveSessionTargetServerIdSpy(args[0] as string, args[1] as string | null | undefined),
}));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: (...args: unknown[]) => machineExecutionRunsListSpy(...args),
}));

beforeEach(() => {
    resolvePreferredServerIdForSessionIdSpy.mockReset();
    resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server_canonical');
    resolveSessionTargetServerIdSpy.mockReset();
    resolveSessionTargetServerIdSpy.mockImplementation((_sessionId, fallbackServerId) => fallbackServerId ?? null);
    machineExecutionRunsListSpy.mockReset();
    machineExecutionRunsListSpy.mockResolvedValue({
        ok: true,
        runs: [{
            callId: 'toolu_1',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            ioMode: 'streaming',
            intent: 'review',
            runClass: 'bounded',
            runId: 'run_1',
            retentionPolicy: 'ephemeral',
            startedAtMs: 1,
            status: 'running',
            sidechainId: 'toolu_1',
        }],
    });
});

describe('resolveDaemonExecutionRunFallback', () => {
    it('uses the canonical preferred-server resolver and normalized session id for daemon fallback lookup', async () => {
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: '  s1  ',
            runId: 'run_1',
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                status: 'running',
            }),
            daemonProcessLine: null,
        }));

        expect(resolvePreferredServerIdForSessionIdSpy).toHaveBeenCalledWith('s1');
        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('m1', { serverId: 'server_canonical' });
    });

    it('falls back to the session record server id when the preferred resolver has no server for a normalized session id', async () => {
        resolvePreferredServerIdForSessionIdSpy.mockReturnValueOnce(undefined);
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: '  s1  ',
            runId: 'run_1',
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                status: 'running',
            }),
            daemonProcessLine: null,
        }));

        expect(resolvePreferredServerIdForSessionIdSpy).toHaveBeenCalledWith('s1');
        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('m1', { serverId: 'server_fallback' });
    });
});
