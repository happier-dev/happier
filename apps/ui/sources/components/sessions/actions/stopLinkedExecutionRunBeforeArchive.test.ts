import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.hoisted(() => vi.fn());
const stopMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: (sessionId: string, request: unknown, options: unknown) => getMock(sessionId, request, options),
    sessionExecutionRunStop: (sessionId: string, request: unknown, options: unknown) => stopMock(sessionId, request, options),
}));

function target(metadata: Record<string, unknown>) {
    return {
        sessionId: 'child',
        serverId: 'server-a',
        session: { id: 'child', metadata },
    } as any;
}

describe('stopLinkedExecutionRunBeforeArchive', () => {
    beforeEach(() => {
        getMock.mockReset();
        stopMock.mockReset();
    });

    it('stops an active linked run on the parent with the child-archive reason', async () => {
        getMock.mockResolvedValue({ run: { runId: 'run-1', status: 'running', runClass: 'bounded' } });
        stopMock.mockResolvedValue({ ok: true });
        const { stopLinkedExecutionRunBeforeArchive } = await import('./stopLinkedExecutionRunBeforeArchive');

        await stopLinkedExecutionRunBeforeArchive(target({
            executionRunLinkV1: { v: 1, parentSessionId: 'lead', runId: 'run-1', turnEpoch: 2 },
        }));

        expect(getMock).toHaveBeenCalledWith('lead', { runId: 'run-1' }, { serverId: 'server-a' });
        expect(stopMock).toHaveBeenCalledWith('lead', { runId: 'run-1', reason: 'child_archived' }, { serverId: 'server-a' });
    });

    it('does nothing for an unlinked child or a terminal linked run', async () => {
        const { stopLinkedExecutionRunBeforeArchive } = await import('./stopLinkedExecutionRunBeforeArchive');
        await stopLinkedExecutionRunBeforeArchive(target({}));
        getMock.mockResolvedValue({ run: { runId: 'run-1', status: 'succeeded', runClass: 'bounded' } });
        await stopLinkedExecutionRunBeforeArchive(target({
            executionRunLinkV1: { v: 1, parentSessionId: 'lead', runId: 'run-1', turnEpoch: 2 },
        }));

        expect(stopMock).not.toHaveBeenCalled();
    });

    it('fails the child archive step when run state or stop cannot be verified', async () => {
        const { stopLinkedExecutionRunBeforeArchive } = await import('./stopLinkedExecutionRunBeforeArchive');
        const linked = target({ executionRunLinkV1: { v: 1, parentSessionId: 'lead', runId: 'run-1', turnEpoch: 2 } });
        getMock.mockResolvedValue({ ok: false, error: 'runner offline' });
        await expect(stopLinkedExecutionRunBeforeArchive(linked)).rejects.toThrow('runner offline');

        getMock.mockResolvedValue({ run: { runId: 'run-1', status: 'running', runClass: 'bounded' } });
        stopMock.mockResolvedValue({ ok: false, error: 'stop refused' });
        await expect(stopLinkedExecutionRunBeforeArchive(linked)).rejects.toThrow('stop refused');
    });
});
