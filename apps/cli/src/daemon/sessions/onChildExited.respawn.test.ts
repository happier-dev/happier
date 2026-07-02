import { describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';

describe('createOnChildExited', () => {
  it('queues durable session-end when a tracked child exits', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
      exit: expect.objectContaining({
        observedBy: 'daemon',
        pid,
        reason: 'process-exited',
      }),
    }));
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
    expect(apiMachine.enqueueSessionTurnSettlementMutation).toHaveBeenCalledWith({
      sid: 'session-1',
      time: expect.any(Number),
    });
  });

  it('settles the dead runner open turn even when a live replacement owns the same session', () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1' };
    const replacement = { pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([
      [obsoletePid, obsolete],
      [livePid, replacement],
    ]);
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map<number, () => void>(),
      sessionAttachCleanupByPid: new Map<number, () => Promise<void>>(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    // Full session-end stays gated on no-live-replacement…
    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
    // …but the dead runner's open canonical turn is still settled (respawn-kill must not leave
    // the session stuck "working" until the next prompt).
    expect(apiMachine.enqueueSessionTurnSettlementMutation).toHaveBeenCalledWith({
      sid: 'session-1',
      time: expect.any(Number),
    });
    killSpy.mockRestore();
  });

  it('does not settle a turn on wrapper-pid promotion to a live runner pid', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
      enqueueSessionTurnSettlementMutation: vi.fn(),
    };
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map<number, () => void>(),
      sessionAttachCleanupByPid: new Map<number, () => Promise<void>>(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => {}),
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).not.toHaveBeenCalled();
    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('does not queue session-end for an obsolete pid when another live pid owns the same session', () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1' };
    const replacement = { pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([
      [obsoletePid, obsolete],
      [livePid, replacement],
    ]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };
    const onUnexpectedExit = vi.fn();
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
      onUnexpectedExit,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(obsoletePid)).toBe(false);
    expect(pidToTrackedSession.get(livePid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
    }));
    killSpy.mockRestore();
  });

  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-1', pid: 123 }),
      expect.objectContaining({ code: 1 }),
    );
  });

  it('invokes onUnexpectedExit hook for process-missing with a known session id', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onUnexpectedExit hook for SIGTERM', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(0);
  });

  it('invokes onUnexpectedExit hook for SIGTERM when override marks it unexpected', () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('removes the wrapper session marker when runner pid is known', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    killSpy.mockRestore();
  });

  it('promotes the tracked wrapper PID to the runner PID when the wrapper exits', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const promoteSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toMatchObject({
      pid: runnerPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
    });
    expect(pidToTrackedSession.get(runnerPid)?.sessionRunnerPid).toBeUndefined();
    expect(promoteSessionMarkerFn).toHaveBeenCalledWith(wrapperPid, runnerPid);
    expect(promoteSessionMarkerFn.mock.invocationCallOrder[0]).toBeLessThan(removeSessionMarkerFn.mock.invocationCallOrder[0]);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    killSpy.mockRestore();
  });

  it('does not promote to a dead runner pid and reports the wrapper exit normally', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const apiMachine = {
      emitSessionEnd: vi.fn(),
      enqueueSessionEndMutation: vi.fn(),
    };

    const removeSessionMarkerFn = vi.fn(async () => {});
    const promoteSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(promoteSessionMarkerFn).not.toHaveBeenCalled();
    expect(apiMachine.enqueueSessionEndMutation).toHaveBeenCalledWith(expect.objectContaining({
      sid: 'session-1',
      exit: expect.objectContaining({
        observedBy: 'daemon',
        pid: wrapperPid,
        reason: 'process-exited',
      }),
    }));
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(wrapperPid);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(runnerPid);
    killSpy.mockRestore();
  });

  it('transfers PID-owned cleanup and notifies promotion listeners when a live runner replaces the wrapper', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
      childProcess: { pid: wrapperPid },
    };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnCleanup = vi.fn();
    const attachCleanup = vi.fn(async () => {});
    const spawnResourceCleanupByPid = new Map<number, () => void>([[wrapperPid, spawnCleanup]]);
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>([[wrapperPid, attachCleanup]]);
    const onPidPromoted = vi.fn();

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => {}),
      onPidPromoted,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(spawnResourceCleanupByPid.has(wrapperPid)).toBe(false);
    expect(spawnResourceCleanupByPid.get(runnerPid)).toBe(spawnCleanup);
    expect(sessionAttachCleanupByPid.has(wrapperPid)).toBe(false);
    expect(sessionAttachCleanupByPid.get(runnerPid)).toBe(attachCleanup);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
      pid: runnerPid,
      happySessionId: 'session-1',
      sessionRunnerPid: undefined,
      childProcess: undefined,
    }));
    expect(onPidPromoted).toHaveBeenCalledWith({
      fromPid: wrapperPid,
      toPid: runnerPid,
      trackedSession: expect.objectContaining({ pid: runnerPid, happySessionId: 'session-1' }),
    });
    expect(spawnCleanup).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
