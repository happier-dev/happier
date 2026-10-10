import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const resolveSessionTargetServerIdSpy = vi.hoisted(() => vi.fn<(_sessionId: string, fallbackServerId?: string | null) => string | null>());
const machineExecutionRunsListSpy = vi.hoisted(() => vi.fn());
const transcriptFallback = {
    run: {
        runId: 'run_1',
        callId: 'toolu_1',
        sidechainId: 'toolu_1',
        intent: 'review' as const,
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral' as const,
        runClass: 'bounded' as const,
        ioMode: 'streaming' as const,
        status: 'succeeded' as const,
        startedAtMs: 1,
    },
} as const;

const storageMock = createStorageModuleStub({
    storage: {
        getState: () => ({
            sessions: {
                s1: {
                    metadata: { machineId: 'm1' },
                    serverId: 'server_fallback',
                },
            },
        }),
    } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (...args: unknown[]) => resolveSessionTargetServerIdSpy(args[0] as string, args[1] as string | null | undefined),
}));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: (...args: unknown[]) => machineExecutionRunsListSpy(...args),
}));

beforeEach(() => {
    resolveSessionTargetServerIdSpy.mockReset();
    resolveSessionTargetServerIdSpy.mockImplementation((_sessionId, fallbackServerId) => fallbackServerId ?? null);
    machineExecutionRunsListSpy.mockReset();
        machineExecutionRunsListSpy.mockResolvedValue({
            ok: true,
            runs: [{
                callId: 'toolu_1',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                happySessionId: 's1',
                intent: 'review',
                pid: 123,
                runId: 'run_1',
                startedAtMs: 1,
                status: 'running',
                sidechainId: 'toolu_1',
                resolvedSelection: { source: 'inherited', modelId: 'applied-model', connectedServices: null },
            }],
        });
});

describe('resolveDaemonExecutionRunFallback', () => {
    it('uses the explicit Home and normalized Session id for daemon fallback lookup', async () => {
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: '  s1  ',
            serverId: 'server_fallback',
            runId: 'run_1',
            transcriptFallback,
        })).resolves.toEqual(expect.objectContaining({
            run: expect.objectContaining({
                runId: 'run_1',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                status: 'running',
                resolvedSelection: { source: 'inherited', modelId: 'applied-model', connectedServices: null },
            }),
            daemonProcessLine: null,
        }));

        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('m1', { serverId: 'server_fallback' });
    });

    it('fails closed when the exact Home is unavailable', async () => {
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: '  s1  ',
            runId: 'run_1',
            transcriptFallback,
        })).resolves.toBeNull();

        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        expect(machineExecutionRunsListSpy).not.toHaveBeenCalled();
    });

    it('does not borrow the ambient same-id Session machine for an explicitly different Home', async () => {
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: 's1',
            serverId: 'server_exact',
            runId: 'run_1',
            transcriptFallback,
        })).resolves.toBeNull();

        expect(machineExecutionRunsListSpy).not.toHaveBeenCalled();
    });

    it('does not invent configuration from a minimal daemon marker without transcript state', async () => {
        const { resolveDaemonExecutionRunFallback } = await import('./resolveDaemonExecutionRunFallback');

        await expect(resolveDaemonExecutionRunFallback({
            sessionId: 's1',
            serverId: 'server_fallback',
            runId: 'run_1',
        })).resolves.toBeNull();
    });
});
