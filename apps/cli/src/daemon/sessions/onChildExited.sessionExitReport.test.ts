import { describe, expect, it, vi } from 'vitest';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';

const mocks = vi.hoisted(() => ({
  writeSessionExitReport: vi.fn(async () => '/tmp/session-exit.json'),
}));

vi.mock('@/session/diagnostics/sessionExitReport', () => ({
  writeSessionExitReport: mocks.writeSessionExitReport,
}));

describe('createOnChildExited session exit reports', () => {
  it('records a person-requested SIGKILL as intentional rather than crash recovery', async () => {
    mocks.writeSessionExitReport.mockClear();
    const tracked: TrackedSession = { pid: 5152, startedBy: 'daemon', happySessionId: 'session-killed',
      activeTurnId: 'turn-killed', stopRequestedAtMs: 1234, stopRequestedReason: 'user_process_kill' };
    let crashSettlement = 0;
    let markerRetained = false;
    let markerRemoved = false;
    // The machine transport is a network boundary; real exit staging runs beneath it.
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: async () => undefined,
      captureMachineSessionTerminal: async () => ({ v: 1 as const, status: 'already_inactive' as const, sessionId: 'session-killed' }),
    } as unknown as ApiMachineClient;
    const sessions = new Map([[tracked.pid, tracked]]);
    const onChildExited = createOnChildExited({ pidToTrackedSession: sessions,
      spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn: async () => { markerRemoved = true; },
      beforeUnexpectedExitSettlement: () => { crashSettlement++; },
      shouldPreserveSessionMarkerOnExit: () => { markerRetained = true; return true; },
    });
    await onChildExited(tracked.pid, { reason: 'process-exited', code: null, signal: 'SIGKILL' });
    expect(crashSettlement).toBe(0);
    expect(markerRetained).toBe(false);
    expect(markerRemoved).toBe(true);
    expect(sessions.size).toBe(0);
    expect(mocks.writeSessionExitReport).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({
      reason: 'killed_by_person', terminationKind: 'kill', terminationReason: 'user_request', terminationRequestedAt: 1234,
    }) }));
  });

  it('persists bounded child stderr diagnostics from the observed exit', async () => {
    mocks.writeSessionExitReport.mockClear();
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
