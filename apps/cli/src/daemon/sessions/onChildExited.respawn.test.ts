import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';

const hookSettingsMock = vi.hoisted(() => ({
  cleanupHookPluginDir: vi.fn(),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
  cleanupHookPluginDir: hookSettingsMock.cleanupHookPluginDir,
}));

describe('createOnChildExited', () => {
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    hookSettingsMock.cleanupHookPluginDir.mockClear();
  });

  it('does not report exit completion or release tracking before exact-turn staging is durable', async () => {
    const pid = 123;
    const tracked = {
      pid,
      startedBy: 'daemon',
      happySessionId: 'session-blocked-stage',
      activeTurnId: 'turn-blocked-stage',
    };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    let resolveStage = (): void => {
      throw new Error('Stage resolver was not installed');
    };
    const stageObservedExitFn = vi.fn(() => new Promise<any>((resolve) => {
      resolveStage = () => resolve({ status: 'staged' as const, markerPid: pid });
    }));
    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
      }) as any,
      stageObservedExitFn,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    });

    const completion = onChildExited(pid, { reason: 'process-error', code: null, signal: null });
    await Promise.resolve();

    expect(pidToTrackedSession.has(pid)).toBe(true);
    expect(onUnexpectedExit).not.toHaveBeenCalled();

    resolveStage();
    await completion;

    expect(pidToTrackedSession.has(pid)).toBe(false);
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('retains marker and tracking after transient staging failure so the same daemon can retry', async () => {
    const pid = 124;
    const tracked = {
      pid,
      startedBy: 'daemon',
      happySessionId: 'session-retry-stage',
      activeTurnId: 'turn-retry-stage',
    };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const stageObservedExitFn = vi.fn()
      .mockRejectedValueOnce(new Error('transient persistence failure'))
      .mockResolvedValueOnce({ status: 'staged' as const, markerPid: pid });
    const removeSessionMarkerFn = vi.fn(async () => {});
    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
      }) as any,
      stageObservedExitFn,
      removeSessionMarkerFn,
    });

    await expect(onChildExited(pid, { reason: 'process-missing', code: null, signal: null }))
      .rejects.toThrow('transient persistence failure');
    expect(pidToTrackedSession.has(pid)).toBe(true);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();

    await expect(onChildExited(pid, { reason: 'process-missing', code: null, signal: null }))
      .resolves.toBeUndefined();
    expect(pidToTrackedSession.has(pid)).toBe(false);
    expect(stageObservedExitFn).toHaveBeenCalledTimes(2);
  });

  it('retains exact-turn tracking when daemon terminal custody is temporarily unavailable', async () => {
    const pid = 125;
    const tracked = {
      pid,
      startedBy: 'daemon',
      happySessionId: 'session-custody-unavailable',
      activeTurnId: 'turn-custody-unavailable',
    };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});
    const onUnexpectedExit = vi.fn();
    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    });

    await expect(onChildExited(pid, { reason: 'process-missing', code: null, signal: null }))
      .rejects.toThrow('Daemon terminal custody is unavailable');
    expect(pidToTrackedSession.has(pid)).toBe(true);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('routes child-exit custody through awaited exact-turn staging and never emits full session end', async () => {
    const pid = 123;
    const tracked = {
      pid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      activeTurnId: 'turn-1',
    };
    const stageObservedExitFn = vi.fn(async (input: any) => {
      await input.releaseMarkerEvidence({
        markerPid: pid,
        sessionId: 'session-1',
        turnId: 'turn-1',
      });
      return { status: 'staged' as const, markerPid: pid };
    });
    const removeSessionMarkerFn = vi.fn(async () => {});
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
    };

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine as any,
      stageObservedExitFn,
      removeSessionMarkerFn,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    await expect.poll(() => stageObservedExitFn.mock.calls.length).toBe(1);
    expect(stageObservedExitFn).toHaveBeenCalledWith(expect.objectContaining({
      trackedSession: tracked,
      observedAt: expect.any(Number),
      enqueueExactTurnEnd: expect.any(Function),
      releaseMarkerEvidence: expect.any(Function),
    }));
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(pid);
  });

  it('does not report an unexpected exit for an obsolete pid when another live pid owns the same session', async () => {
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
    const apiMachine = {};
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

    await onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(obsoletePid)).toBe(false);
    expect(pidToTrackedSession.get(livePid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
    }));
    killSpy.mockRestore();
  });

  it('stages the exact open turn even when a live replacement owns the same session', async () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1', activeTurnId: 'turn-obsolete' };
    const replacement = { pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const pidToTrackedSession = new Map<number, any>([
      [obsoletePid, obsolete],
      [livePid, replacement],
    ]);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
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
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-exited', code: 0, signal: 'SIGTERM' });

    await expect.poll(() => apiMachine.enqueueDaemonTerminalExactTurnEnd.mock.calls.length).toBe(1);
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      turnId: 'turn-obsolete',
    }));
    killSpy.mockRestore();
  });

  it('stages the exact open turn on a normal tracked exit too', async () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1', activeTurnId: 'turn-normal' };
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
    };

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    await expect.poll(() => apiMachine.enqueueDaemonTerminalExactTurnEnd.mock.calls.length).toBe(1);
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      turnId: 'turn-normal',
    }));
  });

  it('does not settle the canonical turn when a wrapper pid promotes to a live runner pid', () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };
    const apiMachine = {
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
      pidToTrackedSession: new Map<number, any>([[wrapperPid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => apiMachine,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', async () => {
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

    await onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-1', pid: 123 }),
      expect.objectContaining({ code: 1 }),
    );
  });

  it('does not force-clean retained Claude hook plugins while an unexpected exit is delegated for respawn', async () => {
    const pid = 123;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-1' };
    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      pidToTrackedSession: new Map<number, any>([[pid, tracked]]),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(hookSettingsMock.cleanupHookPluginDir).not.toHaveBeenCalled();
  });

  it('invokes onUnexpectedExit hook for process-missing with a known session id', async () => {
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

    await onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('invokes onUnexpectedExit hook for process-reused with a known session id', async () => {
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

    await onChildExited(pid, { reason: 'process-reused', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onUnexpectedExit hook for SIGTERM', async () => {
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

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(0);
  });

  it('invokes onUnexpectedExit hook for SIGTERM when override marks it unexpected', async () => {
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

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('promotes tracking to the runner pid and preserves the runner marker when the wrapper exits', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async (_pid: number) => {});
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
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
      }) as any,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-1',
      }),
    );
    expect(pidToTrackedSession.get(runnerPid)?.sessionRunnerPid).toBeUndefined();
    killSpy.mockRestore();
  });

  it('promotes a live runner even when a connected-service restart marked the wrapper exit as unexpected', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const onUnexpectedExit = vi.fn();
    const onPidPromoted = vi.fn();
    const removeSessionMarkerFn = vi.fn(async (_pid: number) => {});
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
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
      onPidPromoted,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
      pid: runnerPid,
    }));
    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(wrapperPid);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(runnerPid);
    expect(onPidPromoted).toHaveBeenCalledWith(expect.objectContaining({
      fromPid: wrapperPid,
      toPid: runnerPid,
      trackedSession: expect.objectContaining({ happySessionId: 'session-1' }),
    }));
    killSpy.mockRestore();
  });

  it('transfers pid-owned cleanup registrations when promoting wrapper tracking to the runner', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const wrapperCleanup = vi.fn();
    const wrapperAttachCleanup = vi.fn(async () => {});
    const spawnResourceCleanupByPid = new Map<number, () => void>([[wrapperPid, wrapperCleanup]]);
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>([[wrapperPid, wrapperAttachCleanup]]);

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => null,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(wrapperCleanup).not.toHaveBeenCalled();
    expect(wrapperAttachCleanup).not.toHaveBeenCalled();
    expect(spawnResourceCleanupByPid.has(wrapperPid)).toBe(false);
    expect(sessionAttachCleanupByPid.has(wrapperPid)).toBe(false);
    expect(spawnResourceCleanupByPid.get(runnerPid)).toBe(wrapperCleanup);
    expect(sessionAttachCleanupByPid.get(runnerPid)).toBe(wrapperAttachCleanup);
    killSpy.mockRestore();
  });

  it('removes both wrapper and runner markers when the wrapper exits after the runner is already gone', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const pidToTrackedSession = new Map<number, any>([[wrapperPid, tracked]]);
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();

    const removeSessionMarkerFn = vi.fn(async (_pid: number) => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
      }) as any,
      removeSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(wrapperPid);
    await expect.poll(() => removeSessionMarkerFn.mock.calls.map(([pid]) => pid)).toContain(runnerPid);
    expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(pidToTrackedSession.has(runnerPid)).toBe(false);
    killSpy.mockRestore();
  });

  it('preserves the durable marker when the caller keeps a connected-service restart intent pending', async () => {
    const pid = 789;
    const tracked = { pid, startedBy: 'daemon', happySessionId: 'session-restart-intent' };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      shouldPreserveSessionMarkerOnExit: () => true,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(pidToTrackedSession.has(pid)).toBe(false);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(pid);
  });

  it('hands a final tracked exit to terminal-host recovery only after durable exit staging', async () => {
    const pid = 790;
    const tracked = {
      pid,
      startedBy: 'terminal',
      happySessionId: 'session-disconnected-host',
      activeTurnId: 'turn-disconnected-host',
    };
    const pidToTrackedSession = new Map<number, any>([[pid, tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});
    const stageObservedExitFn = vi.fn(async () => ({ status: 'staged' as const, markerPid: pid }));
    const onFinalTrackedSessionExitStaged = vi.fn(async () => {});

    const onChildExited = createOnChildExited({
      pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
      }) as any,
      stageObservedExitFn,
      removeSessionMarkerFn,
      shouldPreserveSessionMarkerOnExit: () => true,
      onFinalTrackedSessionExitStaged,
    } as any);

    const exit = { reason: 'process-missing', code: null, signal: null };
    await onChildExited(pid, exit);

    expect(stageObservedExitFn).toHaveBeenCalledOnce();
    expect(onFinalTrackedSessionExitStaged).toHaveBeenCalledWith({
      pid,
      trackedSession: tracked,
      exit,
      observedAt: expect.any(Number),
    });
    expect(stageObservedExitFn.mock.invocationCallOrder[0]).toBeLessThan(
      onFinalTrackedSessionExitStaged.mock.invocationCallOrder[0]!,
    );
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(pid);
    expect(pidToTrackedSession.has(pid)).toBe(false);
  });
});
