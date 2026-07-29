import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeSessionExitReport: vi.fn(async () => '/tmp/session-exit.json'),
}));

vi.mock('@/session/diagnostics/sessionExitReport', () => ({
  writeSessionExitReport: mocks.writeSessionExitReport,
}));

describe('createOnChildExited session exit reports', () => {
  it('persists bounded child stderr diagnostics from the observed exit', async () => {
    const { createOnChildExited } = await import('./onChildExited');
    const pid = 5151;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };
    const apiMachine = { enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined) };

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map<number, () => void>(),
      sessionAttachCleanupByPid: new Map<number, () => Promise<void>>(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as any);

    await onChildExited(pid, {
      reason: 'process-exited',
      code: 1,
      signal: null,
      stderrTail: 'fatal: missing configured provider runtime',
    });

    await vi.waitFor(() => {
      expect(mocks.writeSessionExitReport).toHaveBeenCalledTimes(1);
    });
    expect(mocks.writeSessionExitReport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      pid,
      report: expect.objectContaining({
        reason: 'process-exited',
        code: 1,
        signal: null,
        stderrTail: 'fatal: missing configured provider runtime',
      }),
    }));
  });
});
