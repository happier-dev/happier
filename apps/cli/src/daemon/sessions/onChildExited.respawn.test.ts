import { describe, expect, it, vi } from 'vitest';

import { createOnChildExited } from './onChildExited';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

async function drainAsyncWork(cycles = 3): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('createOnChildExited', () => {
  it.each(['staging fails', 'respawn owner takes it'] as const)('settles a spared held Agent within the exit observation (%s)', async (path) => {
    const pid = 131;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'cspare1', activeTurnId: 'turn-9' };
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const order: string[] = [];
    const held = { role: 'primary', socketPath: '/tmp/h.sock', holderPid: 9001, agentPid: 9002 };
    const ends: unknown[] = [];
    const staged: (string | null)[] = [];
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => ({ enqueueDaemonTerminalExactTurnEnd: async () => undefined }),
      ownerRemainder: { end: async (_owner: unknown, _capture: unknown, options: unknown) => { ends.push(options); return { status: 'complete', outcomes: [] }; } },
      spareHeldAgent: async () => ({ held, turnId: 'turn-9', handOff: () => { order.push('handOff'); }, abandon: async () => { order.push('abandon'); } }),
      stageObservedExitFn: vi.fn(async ({ trackedSession }: any) => {
        staged.push(trackedSession.activeTurnId ?? null);
        if (path === 'staging fails') throw new Error('disk unavailable');
      }),
      beforeUnexpectedExitSettlement: async () => undefined,
      onUnexpectedExit: vi.fn(async () => { order.push('respawn'); }),
      shouldPreserveSessionMarkerOnExit: () => false,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect(ends).toEqual([{ spare: [held.holderPid] }]);
    // The exit does not end the turn the spared Agent is still answering.
    expect(staged).toEqual([null]);
    // Every way out of the observation settles the spare: handed over, or ended.
    expect(order).toEqual(path === 'staging fails' ? ['abandon'] : ['handOff', 'respawn', 'abandon']);
  });

  it('moves the turn out of the retained marker when the exit spares the held Agent', async () => {
    // The respawn adopts the spared Agent and completes its turn. The dead runner's
    // retained marker must not name that turn, or a later orphan settlement ends it.
    const pid = 132;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'cspare2', activeTurnId: 'turn-10' };
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const held = { role: 'primary', socketPath: '/tmp/h2.sock', holderPid: 9003, agentPid: 9004 };
    const turnEnds: unknown[] = [];
    const markerTurns: (string | null)[] = [];
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => ({ enqueueDaemonTerminalExactTurnEnd: async (mutation: unknown) => { turnEnds.push(mutation); } }),
      ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
      spareHeldAgent: async () => ({ held, turnId: 'turn-10', handOff: () => undefined, abandon: async () => undefined }),
      updateSessionMarkerActiveTurnFn: async ({ activeTurnId }: { activeTurnId: string | null }) => { markerTurns.push(activeTurnId); },
      beforeUnexpectedExitSettlement: async () => undefined,
      onUnexpectedExit: vi.fn(async () => undefined),
      shouldPreserveSessionMarkerOnExit: () => true,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });

    expect({ turnEnds: turnEnds.length, markerTurns }).toEqual({ turnEnds: 0, markerTurns: [null] });
  });

  it('does not register disconnected terminal recovery after an owned startup launch was cancelled before acknowledgement', async () => {
    const pid = 121;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const onFinalTrackedSessionExitStaged = vi.fn(async () => {
      throw new Error('startup terminal has already been disposed');
    });
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      stageObservedExitFn: vi.fn(async () => undefined),
      onFinalTrackedSessionExitStaged,
    } as any);

    await onChildExited(pid, {
      reason: 'startup-cancelled-before-ack',
      code: null,
      signal: 'SIGTERM',
    });

    expect(onFinalTrackedSessionExitStaged).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
  });

  it('cleans a PID-only pre-webhook exit without session recovery or respawn', async () => {
    const pid = 120;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
      hostedTerminal: { mode: 'herdr' },
    };
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const beforeUnexpectedExitSettlement = vi.fn(async () => undefined);
    const onUnexpectedExit = vi.fn(async () => undefined);
    const onFinalTrackedSessionExitStaged = vi.fn(async () => {
      throw new Error('PID-only sessions have no terminal attachment');
    });
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      beforeUnexpectedExitSettlement,
      onUnexpectedExit,
      shouldPreserveSessionMarkerOnExit: () => true,
      onFinalTrackedSessionExitStaged,
    } as any);

    await onChildExited(pid, {
      reason: 'process-exited-before-webhook',
      code: 1,
      signal: null,
    });

    expect(beforeUnexpectedExitSettlement).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(onFinalTrackedSessionExitStaged).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(pid));
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
  });

  it('retains startup tracking, marker evidence, and cleanup custody when exact launch cleanup fails', async () => {
    const pid = 122;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: `PID-${pid}`,
    };
    const cleanup = vi.fn(async () => {
      throw new Error('managed_provider_stop_unavailable');
    });
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey =
      new Map<SessionTrackingKey, () => void | Promise<void>>([[legacyPidSessionTrackingKey(pid), cleanup]]);
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
    } as any);

    await onChildExited(pid, {
      reason: 'startup-cancelled-before-ack',
      code: null,
      signal: 'SIGTERM',
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(pid))).toBe(tracked);
    expect(spawnResourceCleanupByKey.get(legacyPidSessionTrackingKey(pid))).toBe(cleanup);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('retains marker and tracked custody until the exact terminal row is durably staged', async () => {
    const pid = 123;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-1', activeTurnId: 'turn-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();
    let accept!: () => void;
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(() => new Promise<void>((resolve) => { accept = resolve; })),
      captureMachineSessionTerminal: async () => ({ v: 1 as const, status: 'already_inactive' as const, sessionId: 'session-1' }),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
    } as any);

    const firstObservation = onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });
    const heartbeatObservation = onChildExited(pid, {
      reason: 'process-missing',
      code: null,
      signal: null,
    });

    await vi.waitFor(() => expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-1',
      mutationId: expect.stringMatching(/^daemon-observed-exit:/),
      action: 'end_session',
      turnId: 'turn-1',
      observedAt: expect.any(Number),
    }));
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledTimes(1);
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(true);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();

    accept();
    await Promise.all([firstObservation, heartbeatObservation]);
    await vi.waitFor(() => expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false));
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(pid));
  });

  it('does not clean replacement custody when the PID owner changes during durable exit staging', async () => {
    const pid = 125;
    const oldTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-old', activeTurnId: 'turn-old' };
    const replacementTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-replacement', activeTurnId: 'turn-new' };
    const oldSpawnCleanup = vi.fn();
    const oldAttachCleanup = vi.fn(async () => undefined);
    const replacementSpawnCleanup = vi.fn();
    const replacementAttachCleanup = vi.fn(async () => undefined);
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), oldTracked]]);
    const spawnResourceCleanupByKey = new Map<SessionTrackingKey, () => void>([[legacyPidSessionTrackingKey(pid), oldSpawnCleanup]]);
    const sessionAttachCleanupByKey = new Map<SessionTrackingKey, () => Promise<void>>([[legacyPidSessionTrackingKey(pid), oldAttachCleanup]]);
    let accept!: () => void;
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(() => new Promise<void>((resolve) => { accept = resolve; })),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
    } as any);

    const observation = onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
    await vi.waitFor(() => expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledTimes(1));
    trackedSessionsByKey.set(legacyPidSessionTrackingKey(pid), replacementTracked);
    spawnResourceCleanupByKey.set(legacyPidSessionTrackingKey(pid), replacementSpawnCleanup);
    sessionAttachCleanupByKey.set(legacyPidSessionTrackingKey(pid), replacementAttachCleanup);
    accept();
    await observation;

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementTracked);
    expect(spawnResourceCleanupByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementSpawnCleanup);
    expect(sessionAttachCleanupByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementAttachCleanup);
    expect(replacementSpawnCleanup).not.toHaveBeenCalled();
    expect(replacementAttachCleanup).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('does not consume replacement cleanup registered while old cleanup is awaiting', async () => {
    const pid = 126;
    const oldTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-old' };
    const replacementTracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-replacement' };
    let releaseOldSpawnCleanup!: () => void;
    const oldSpawnCleanup = vi.fn(() => new Promise<void>((resolve) => {
      releaseOldSpawnCleanup = resolve;
    }));
    const oldAttachCleanup = vi.fn(async () => undefined);
    const replacementSpawnCleanup = vi.fn();
    const replacementAttachCleanup = vi.fn(async () => undefined);
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), oldTracked]]);
    const spawnResourceCleanupByKey = new Map<SessionTrackingKey, () => void | Promise<void>>([[legacyPidSessionTrackingKey(pid), oldSpawnCleanup]]);
    const sessionAttachCleanupByKey = new Map<SessionTrackingKey, () => Promise<void>>([[legacyPidSessionTrackingKey(pid), oldAttachCleanup]]);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as any);

    const observation = onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
    await vi.waitFor(() => expect(oldSpawnCleanup).toHaveBeenCalledTimes(1));
    trackedSessionsByKey.set(legacyPidSessionTrackingKey(pid), replacementTracked);
    spawnResourceCleanupByKey.set(legacyPidSessionTrackingKey(pid), replacementSpawnCleanup);
    sessionAttachCleanupByKey.set(legacyPidSessionTrackingKey(pid), replacementAttachCleanup);
    releaseOldSpawnCleanup();
    await observation;

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementTracked);
    expect(spawnResourceCleanupByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementSpawnCleanup);
    expect(sessionAttachCleanupByKey.get(legacyPidSessionTrackingKey(pid))).toBe(replacementAttachCleanup);
    expect(oldAttachCleanup).not.toHaveBeenCalled();
    expect(replacementSpawnCleanup).not.toHaveBeenCalled();
    expect(replacementAttachCleanup).not.toHaveBeenCalled();
  });

  it('fences and finalizes a no-turn final exit before releasing its marker custody', async () => {
    const pid = 124;
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: 'session-2',
    }]]);
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'captured' as const,
        sessionId: 'session-2',
        authority: { kind: 'generation' as const, publisherGeneration: '7' },
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => {
        await finalizeGate;
        return { v: 1 as const, status: 'closed' as const, sessionId: 'session-2' };
      }),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
    } as any);

    const observation = onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    await vi.waitFor(() => expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledWith('session-2'));
    expect(apiMachine.finalizeMachineSessionTerminal).toHaveBeenCalledWith({
      sessionId: 'session-2',
      authority: { kind: 'generation', publisherGeneration: '7' },
    });
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(true);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();

    releaseFinalize();
    await observation;
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(pid));
  });

  it.each([undefined, 'turn-capture-rejected'])('retains final-exit custody when terminal capture transiently fails (turn %s)', async (activeTurnId) => {
    const pid = 126;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon' as const, happySessionId: 'session-capture-rejected', activeTurnId };
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'rejected' as const,
        sessionId: 'session-capture-rejected',
        reason: 'internal_error' as const,
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'session-capture-rejected',
      })),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledWith('session-capture-rejected');
    expect(apiMachine.finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(pid))).toBe(tracked);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('stages the dead runner exact turn even when a live replacement owns the same session', async () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = {
      trackingKey: legacyPidSessionTrackingKey(obsoletePid), pid: obsoletePid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      activeTurnId: 'obsolete-turn',
    };
    const replacement = { trackingKey: legacyPidSessionTrackingKey(livePid), pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(obsoletePid), obsolete],
      [legacyPidSessionTrackingKey(livePid), replacement],
    ]);
    const apiMachine = { enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined) };
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const beforeUnexpectedExitSettlement = vi.fn();
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
      beforeUnexpectedExitSettlement,
      shouldPreserveSessionMarkerOnExit: ({ unexpected }: { unexpected: boolean }) => unexpected,
    } as any);

    onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    await vi.waitFor(() => expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-1',
      mutationId: expect.stringMatching(/^daemon-observed-exit:/),
      action: 'end_session',
      turnId: 'obsolete-turn',
      observedAt: expect.any(Number),
    }));
    expect(beforeUnexpectedExitSettlement).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(obsoletePid));
    killSpy.mockRestore();
  });

  it('does not settle a turn on wrapper-pid promotion to a live runner pid', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const apiMachine = {
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
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => ({
        sourceMarkerOwnership: { happySessionId: 'session-1' },
      })),
    } as any);

    await onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(apiMachine.enqueueSessionTurnSettlementMutation).not.toHaveBeenCalled();
    expect(apiMachine.enqueueSessionEndMutation).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('authors no terminal row for an obsolete pid without an exact turn when another live pid owns the session', async () => {
    const obsoletePid = 123;
    const livePid = 456;
    const obsolete = { trackingKey: legacyPidSessionTrackingKey(obsoletePid), pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-1' };
    const replacement = { trackingKey: legacyPidSessionTrackingKey(livePid), pid: livePid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([
      [legacyPidSessionTrackingKey(obsoletePid), obsolete],
      [legacyPidSessionTrackingKey(livePid), replacement],
    ]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();
    const apiMachine = { enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined) };
    const onUnexpectedExit = vi.fn();
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => apiMachine,
      onUnexpectedExit,
    } as any);

    await onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(obsoletePid))).toBe(false);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(livePid))).toEqual(expect.objectContaining({
      happySessionId: 'session-1',
    }));
    killSpy.mockRestore();
  });

  it('invokes onUnexpectedExit hook for non-zero exits with a known session id', async () => {
    const pid = 123;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
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

  // A killed runner ran none of its own disposal, so its detached managed children must be
  // retired by the daemon BEFORE a replacement runner starts allocating new ones.
  it('retires the managed services an unexpectedly exited runner owned before respawning it', async () => {
    const pid = 129;
    const order: string[] = [];
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-orphan' };
    const retireSessionRunnerOwnedManagedServices = vi.fn(async () => {
      order.push('retire');
    });
    const onUnexpectedExit = vi.fn(() => {
      order.push('respawn');
    });

    const onChildExited = createOnChildExited({
      trackedSessionsByKey: new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      retireSessionRunnerOwnedManagedServices,
      onUnexpectedExit,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGKILL' });

    expect(retireSessionRunnerOwnedManagedServices).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-orphan' }),
    );
    expect(order).toEqual(['retire', 'respawn']);
  });

  // A replacement PID still owns those children, so retiring by session id would kill the live
  // runner's own managed services.
  it('does not retire managed services while another live runner owns the same session', async () => {
    const obsoletePid = 130;
    const livePid = 131;
    const retireSessionRunnerOwnedManagedServices = vi.fn(async () => undefined);
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === livePid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey: new Map<SessionTrackingKey, any>([
        [legacyPidSessionTrackingKey(obsoletePid), { trackingKey: legacyPidSessionTrackingKey(obsoletePid), pid: obsoletePid, startedBy: 'daemon', happySessionId: 'session-shared' }],
        [legacyPidSessionTrackingKey(livePid), { trackingKey: legacyPidSessionTrackingKey(livePid), pid: livePid, startedBy: 'daemon', happySessionId: 'session-shared' }],
      ]),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      }),
      retireSessionRunnerOwnedManagedServices,
    } as any);

    await onChildExited(obsoletePid, { reason: 'process-missing', code: null, signal: null });

    expect(retireSessionRunnerOwnedManagedServices).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('captures unexpected exit authority before durable staging and schedules only after staging', async () => {
    const pid = 126;
    const calls: string[] = [];
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: 'session-fenced',
      activeTurnId: 'turn-fenced',
    };
    let releaseStage!: () => void;
    const stageObservedExitFn = vi.fn(async () => {
      calls.push('staging');
      await new Promise<void>((resolve) => { releaseStage = resolve; });
      calls.push('staged');
    });
    const onChildExited = createOnChildExited({
      trackedSessionsByKey: new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      beforeUnexpectedExitSettlement: vi.fn(async () => { calls.push('captured'); }),
      onUnexpectedExit: vi.fn(async () => { calls.push('scheduled'); }),
      shouldPreserveSessionMarkerOnExit: ({ unexpected }: { unexpected: boolean }) => unexpected,
      stageObservedExitFn,
    } as any);

    const observation = onChildExited(pid, { reason: 'process-exited', code: 1, signal: null });
    await vi.waitFor(() => expect(calls).toEqual(['captured', 'staging']));
    expect(calls).not.toContain('scheduled');
    releaseStage();
    await observation;
    expect(calls).toEqual(['captured', 'staging', 'staged', 'scheduled']);
  });

  it('invokes onUnexpectedExit for a pre-webhook exit even when no non-zero status is available', async () => {
    const pid = 124;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-pre-webhook' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const onUnexpectedExit = vi.fn();
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    await onChildExited(pid, {
      reason: 'process-exited-before-webhook',
      code: null,
      signal: null,
    });

    expect(onUnexpectedExit).toHaveBeenCalledWith(
      expect.objectContaining({ happySessionId: 'session-pre-webhook', pid }),
      expect.objectContaining({ reason: 'process-exited-before-webhook' }),
    );
  });

  it('invokes onUnexpectedExit hook for process-missing with a known session id', async () => {
    const pid = 123;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    await onChildExited(pid, { reason: 'process-missing', code: null, signal: null });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onUnexpectedExit hook for SIGTERM', async () => {
    const pid = 123;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(0);
  });

  it('invokes onUnexpectedExit hook for SIGTERM when override marks it unexpected', async () => {
    const pid = 123;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(pid), pid, startedBy: 'daemon', happySessionId: 'session-1' };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const onUnexpectedExit = vi.fn();

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      onUnexpectedExit,
      isExitUnexpectedOverride: () => true,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: null, signal: 'SIGTERM' });

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it('promotes the Session marker in place instead of removing a wrapper marker when runner pid is known', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = { trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid, startedBy: 'daemon', happySessionId: 'session-1', sessionRunnerPid: runnerPid };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      promoteSessionMarkerFn: vi.fn(async () => ({
        sourceMarkerOwnership: { happySessionId: 'session-1' },
      })),
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });
    await drainAsyncWork();

    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('promotes the tracked wrapper PID to the runner PID when the wrapper exits', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: { happySessionId: 'session-1' },
    }));
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });
    await drainAsyncWork();

    // The Session keeps its key; only its hosting pid moves to the runner.
    expect([...trackedSessionsByKey.keys()]).toEqual([tracked.trackingKey]);
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toMatchObject({
      pid: runnerPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
    });
    expect(trackedSessionsByKey.get(tracked.trackingKey)?.sessionRunnerPid).toBeUndefined();
    expect(promoteSessionMarkerFn).toHaveBeenCalledWith({ trackingKey: tracked.trackingKey, fromPid: wrapperPid, toPid: runnerPid });
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('does not overwrite a runner PID owner that appears during marker promotion', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-old',
      sessionRunnerPid: runnerPid,
    };
    const replacement = {
      trackingKey: legacyPidSessionTrackingKey(runnerPid), pid: runnerPid,
      startedBy: 'daemon',
      happySessionId: 'session-replacement',
    };
    const wrapperSpawnCleanup = vi.fn();
    const wrapperAttachCleanup = vi.fn(async () => undefined);
    const replacementSpawnCleanup = vi.fn();
    const replacementAttachCleanup = vi.fn(async () => undefined);
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnResourceCleanupByKey = new Map<SessionTrackingKey, () => void>([[legacyPidSessionTrackingKey(wrapperPid), wrapperSpawnCleanup]]);
    const sessionAttachCleanupByKey = new Map<SessionTrackingKey, () => Promise<void>>([[legacyPidSessionTrackingKey(wrapperPid), wrapperAttachCleanup]]);
    let completePromotion!: (promotion: {
      sourceMarkerOwnership: { happySessionId: string };
    }) => void;
    const promoteSessionMarkerFn = vi.fn(() => new Promise<{
      sourceMarkerOwnership: { happySessionId: string };
    }>((resolve) => {
      completePromotion = resolve;
    }));
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const onPidPromoted = vi.fn();
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) return true;
      return originalKill(targetPid, signal as any);
    }) as any);
    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
      onPidPromoted,
    } as any);

    const observation = onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });
    await vi.waitFor(() => expect(promoteSessionMarkerFn).toHaveBeenCalledTimes(1));
    trackedSessionsByKey.set(legacyPidSessionTrackingKey(runnerPid), replacement);
    spawnResourceCleanupByKey.set(legacyPidSessionTrackingKey(runnerPid), replacementSpawnCleanup);
    sessionAttachCleanupByKey.set(legacyPidSessionTrackingKey(runnerPid), replacementAttachCleanup);
    completePromotion({
      sourceMarkerOwnership: { happySessionId: 'session-old' },
    });
    await observation;

    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(wrapperPid))).toBe(tracked);
    expect(trackedSessionsByKey.get(legacyPidSessionTrackingKey(runnerPid))).toBe(replacement);
    expect(spawnResourceCleanupByKey.get(legacyPidSessionTrackingKey(wrapperPid))).toBe(wrapperSpawnCleanup);
    expect(spawnResourceCleanupByKey.get(legacyPidSessionTrackingKey(runnerPid))).toBe(replacementSpawnCleanup);
    expect(sessionAttachCleanupByKey.get(legacyPidSessionTrackingKey(wrapperPid))).toBe(wrapperAttachCleanup);
    expect(sessionAttachCleanupByKey.get(legacyPidSessionTrackingKey(runnerPid))).toBe(replacementAttachCleanup);
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    expect(onPidPromoted).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('keeps the wrapper session marker when durable marker promotion fails', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();

    const removeSessionMarkerFn = vi.fn(async () => {});
    const promoteSessionMarkerFn = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
    } as any);

    onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });
    await drainAsyncWork();

    expect(promoteSessionMarkerFn).toHaveBeenCalledWith({ trackingKey: tracked.trackingKey, fromPid: wrapperPid, toPid: runnerPid });
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toBe(tracked);
    expect(tracked.pid).toBe(wrapperPid);
    expect(trackedSessionsByKey.size).toBe(1);
    killSpy.mockRestore();
  });

  it('does not promote to a dead runner pid and authors no terminal row without an exact turn', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnResourceCleanupByKey = new Map();
    const sessionAttachCleanupByKey = new Map();
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'captured' as const,
        sessionId: 'session-1',
        authority: { kind: 'generation' as const, publisherGeneration: '8' },
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'session-1',
      })),
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
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => apiMachine,
      removeSessionMarkerFn,
      promoteSessionMarkerFn,
    } as any);

    await onChildExited(wrapperPid, { reason: 'process-exited', code: 0, signal: null });

    expect(promoteSessionMarkerFn).not.toHaveBeenCalled();
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.size).toBe(0);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(tracked.trackingKey);
    killSpy.mockRestore();
  });

  it('preserves a stopped session marker when the lifecycle owner marks it durable', async () => {
    const pid = 321;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: 'session-preserve-marker',
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'session-preserve-marker',
          authority: { kind: 'generation' as const, publisherGeneration: '9' },
        })),
        finalizeMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'closed' as const,
          sessionId: 'session-preserve-marker',
        })),
      }),
      removeSessionMarkerFn,
      shouldPreserveSessionMarkerOnExit: (input: { trackedSession: typeof tracked }) =>
        input.trackedSession === tracked,
    } as any);

    onChildExited(pid, { reason: 'process-exited', code: 0, signal: 'SIGTERM' });
    await drainAsyncWork();

    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(legacyPidSessionTrackingKey(pid));
  });

  it('hands a final tracked exit to terminal-host recovery only after durable exit staging', async () => {
    const pid = 322;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(pid), pid,
      startedBy: 'daemon',
      happySessionId: 'session-register-terminal-host',
    };
    const events: string[] = [];
    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(pid), tracked]]);
    const removeSessionMarkerFn = vi.fn(async () => {});
    const onFinalTrackedSessionExitStaged = vi.fn(async () => {
      events.push('register-terminal-host');
    });

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => ({
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'session-register-terminal-host',
          authority: { kind: 'generation' as const, publisherGeneration: '10' },
        })),
        finalizeMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'closed' as const,
          sessionId: 'session-register-terminal-host',
        })),
      }),
      removeSessionMarkerFn,
      shouldPreserveSessionMarkerOnExit: () => true,
      stageObservedExitFn: vi.fn(async () => {
        events.push('stage-exit');
      }),
      onFinalTrackedSessionExitStaged,
    } as any);

    await onChildExited(pid, { reason: 'process-exited', code: 0, signal: null });

    expect(events).toEqual(['stage-exit', 'register-terminal-host']);
    expect(onFinalTrackedSessionExitStaged).toHaveBeenCalledWith({
      pid,
      trackedSession: tracked,
      exit: { reason: 'process-exited', code: 0, signal: null },
      observedAt: expect.any(Number),
    });
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    expect(trackedSessionsByKey.has(legacyPidSessionTrackingKey(pid))).toBe(false);
  });

  it('transfers PID-owned cleanup and notifies promotion listeners when a live runner replaces the wrapper', async () => {
    const wrapperPid = 123;
    const runnerPid = 456;
    const tracked = {
      trackingKey: legacyPidSessionTrackingKey(wrapperPid), pid: wrapperPid,
      startedBy: 'daemon',
      happySessionId: 'session-1',
      sessionRunnerPid: runnerPid,
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 1_000,
      processCommand: 'wrapper command',
      childProcess: { pid: wrapperPid },
    };

    const trackedSessionsByKey = new Map<SessionTrackingKey, any>([[legacyPidSessionTrackingKey(wrapperPid), tracked]]);
    const spawnCleanup = vi.fn();
    const attachCleanup = vi.fn(async () => {});
    const spawnResourceCleanupByKey = new Map<SessionTrackingKey, () => void>([[legacyPidSessionTrackingKey(wrapperPid), spawnCleanup]]);
    const sessionAttachCleanupByKey = new Map<SessionTrackingKey, () => Promise<void>>([[legacyPidSessionTrackingKey(wrapperPid), attachCleanup]]);
    const onPidPromoted = vi.fn();

    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((targetPid: number, signal?: any) => {
      if (targetPid === runnerPid && signal === 0) {
        return true;
      }
      return originalKill(targetPid, signal as any);
    }) as any);

    const onChildExited = createOnChildExited({
      trackedSessionsByKey,
      spawnResourceCleanupByKey,
      sessionAttachCleanupByKey,
      getApiMachineForSessions: () => null,
      removeSessionMarkerFn: vi.fn(async () => {}),
      promoteSessionMarkerFn: vi.fn(async () => ({
        sourceMarkerOwnership: { happySessionId: 'session-1' },
        targetMarkerOwnership: {
          happySessionId: 'session-1',
          processCommandHash: 'b'.repeat(64),
          processStartTimeMs: 2_000,
        },
        targetProcessCommand: 'runner command',
      })),
      onPidPromoted,
    } as any);

    await onChildExited(
      wrapperPid,
      { reason: 'process-exited', code: 0, signal: null },
    );

    // The Session keeps its key across the promotion, so its resources stay put.
    expect([...spawnResourceCleanupByKey.entries()]).toEqual([[tracked.trackingKey, spawnCleanup]]);
    expect([...sessionAttachCleanupByKey.entries()]).toEqual([[tracked.trackingKey, attachCleanup]]);
    expect(trackedSessionsByKey.get(tracked.trackingKey)).toEqual(expect.objectContaining({
      pid: runnerPid,
      happySessionId: 'session-1',
      sessionRunnerPid: undefined,
      childProcess: undefined,
      processCommandHash: 'b'.repeat(64),
      processStartTimeMs: 2_000,
      processCommand: 'runner command',
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
