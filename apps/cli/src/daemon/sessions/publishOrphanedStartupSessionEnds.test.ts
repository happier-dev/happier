import { describe, expect, it, vi } from 'vitest';

import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';

describe('publishOrphanedStartupSessionEnds', () => {
  it('awaits exact terminal staging before releasing the orphan marker', async () => {
    const calls: string[] = [];
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => { calls.push('persisted'); }),
      captureMachineSessionTerminal: vi.fn(async () => {
        calls.push('captured');
        return { v: 1 as const, status: 'captured' as const, sessionId: 'sess-orphaned-6480', committedFenceMs: 7 };
      }),
      finalizeMachineSessionTerminal: vi.fn(async () => {
        calls.push('finalized');
        return { v: 1 as const, status: 'closed' as const, sessionId: 'sess-orphaned-6480' };
      }),
    };
    const removeSessionMarkerFn = vi.fn(async () => { calls.push('removed'); });

    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-orphaned-6480',
        pid: 6480,
        activeTurnId: 'turn-exact-1',
      }],
      now: () => 123456789,
      removeSessionMarkerFn,
    });

    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'sess-orphaned-6480',
      mutationId: expect.stringMatching(/^daemon-observed-exit:/),
      action: 'end_session',
      turnId: 'turn-exact-1',
      observedAt: 123456789,
    });
    expect(calls).toEqual(['captured', 'persisted', 'finalized', 'removed']);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6480);
  });

  it('finalizes the pre-staging fence when a successor advances presence during durable turn staging', async () => {
    const calls: string[] = [];
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve; });
    const finalizeMachineSessionTerminal = vi.fn(async () => {
      calls.push('finalized');
      return { v: 1 as const, status: 'superseded' as const, sessionId: 'sess-fence-race' };
    });
    const removeSessionMarkerFn = vi.fn(async () => { calls.push('removed'); });
    const observation = publishOrphanedStartupSessionEnds({
      apiMachine: {
        captureMachineSessionTerminal: vi.fn(async () => {
          calls.push('captured');
          return {
            v: 1 as const,
            status: 'captured' as const,
            sessionId: 'sess-fence-race',
            committedFenceMs: 10,
          };
        }),
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {
          calls.push('staging');
          await stageGate;
          calls.push('persisted');
        }),
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-fence-race',
        pid: 6486,
        activeTurnId: 'turn-fence-race',
      }],
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(calls).toEqual(['captured', 'staging']));
    expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    releaseStage();
    await observation;
    expect(finalizeMachineSessionTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-fence-race',
      committedFenceMs: 10,
    });
    expect(calls).toEqual(['captured', 'staging', 'persisted', 'finalized', 'removed']);
  });

  it('retains orphan evidence when quiescence begins while terminal capture is in flight', async () => {
    let quiescing = false;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const enqueueDaemonTerminalExactTurnEnd = vi.fn(async () => undefined);
    const captureMachineSessionTerminal = vi.fn(async () => {
      await captureGate;
      return {
        v: 1 as const,
        status: 'captured' as const,
        sessionId: 'sess-quiesced-capture',
        committedFenceMs: 12,
      };
    });
    const finalizeMachineSessionTerminal = vi.fn(async () => ({
      v: 1 as const,
      status: 'closed' as const,
      sessionId: 'sess-quiesced-capture',
    }));
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const publication = publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd,
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-capture',
        pid: 6493,
        activeTurnId: 'turn-quiesced-capture',
      }],
      isShuttingDown: () => quiescing,
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(captureMachineSessionTerminal).toHaveBeenCalledOnce());
    quiescing = true;
    releaseCapture();
    await publication;

    expect(enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('lets admitted terminal staging finish but starts no finalize or marker release after quiescence', async () => {
    let quiescing = false;
    let releaseStaging!: () => void;
    const stagingGate = new Promise<void>((resolve) => { releaseStaging = resolve; });
    const enqueueDaemonTerminalExactTurnEnd = vi.fn(async () => {
      await stagingGate;
    });
    const finalizeMachineSessionTerminal = vi.fn(async () => ({
      v: 1 as const,
      status: 'closed' as const,
      sessionId: 'sess-quiesced-staging',
    }));
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const publication = publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd,
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-quiesced-staging',
          committedFenceMs: 13,
        })),
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-staging',
        pid: 6494,
        activeTurnId: 'turn-quiesced-staging',
      }],
      isShuttingDown: () => quiescing,
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledOnce());
    quiescing = true;
    releaseStaging();
    await publication;

    expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('lets an admitted terminal finalize finish but retains marker evidence after quiescence', async () => {
    let quiescing = false;
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const finalizeMachineSessionTerminal = vi.fn(async () => {
      await finalizeGate;
      return {
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-quiesced-finalize',
      };
    });
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const publication = publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-quiesced-finalize',
          committedFenceMs: 14,
        })),
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-finalize',
        pid: 6495,
        activeTurnId: 'turn-quiesced-finalize',
      }],
      isShuttingDown: () => quiescing,
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(finalizeMachineSessionTerminal).toHaveBeenCalledOnce());
    quiescing = true;
    releaseFinalize();
    await publication;

    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('authors no terminal row when the orphan marker has no exact turn', async () => {
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'captured' as const,
        sessionId: 'sess-orphaned-no-turn',
        committedFenceMs: 8,
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-orphaned-no-turn',
      })),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);

    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-orphaned-no-turn', pid: 6481 }],
      removeSessionMarkerFn,
    });

    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledWith('sess-orphaned-no-turn');
    expect(apiMachine.finalizeMachineSessionTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-orphaned-no-turn',
      committedFenceMs: 8,
    });
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6481);
  });

  it('retains the orphan marker and continues when exact terminal staging fails', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const captureMachineSessionTerminal = vi.fn(async () => ({
      v: 1 as const,
      status: 'captured' as const,
      sessionId: 'sess-orphaned-failed',
      committedFenceMs: 11,
    }));
    await expect(publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('disk unavailable'); },
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal: vi.fn(),
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-orphaned-failed',
        pid: 6482,
        activeTurnId: 'turn-exact-failed',
      }],
      removeSessionMarkerFn,
    })).resolves.toBeUndefined();
    expect(captureMachineSessionTerminal).toHaveBeenCalledWith('sess-orphaned-failed');
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('releases stale-fence orphan evidence after a successor supersedes finalize', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    await publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-successor',
          committedFenceMs: 9,
        })),
        finalizeMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'superseded' as const,
          sessionId: 'sess-successor',
        })),
      },
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-successor', pid: 6483 }],
      removeSessionMarkerFn,
    });
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6483);
  });

  it('retains failed terminal evidence but continues with later startup orphans', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const captureMachineSessionTerminal = vi.fn()
      .mockRejectedValueOnce(new Error('old server has no ACK'))
      .mockResolvedValueOnce({
        v: 1,
        status: 'already_inactive',
        sessionId: 'sess-later',
      });
    await publishOrphanedStartupSessionEnds({
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(),
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal: vi.fn(),
      },
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-failed', pid: 6484 },
        { sessionId: 'sess-later', pid: 6485 },
      ],
      removeSessionMarkerFn,
    });
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(6484);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6485);
  });

  it('does not serialize later orphan recovery behind an unsupported capture', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstCapture = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(),
      captureMachineSessionTerminal: vi.fn((sessionId: string) => sessionId === 'sess-hung'
        ? firstCapture
        : Promise.resolve({
            v: 1 as const,
            status: 'already_inactive' as const,
            sessionId,
          })),
      finalizeMachineSessionTerminal: vi.fn(),
    };
    const recovery = publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-hung', pid: 6487 },
        { sessionId: 'sess-ready', pid: 6488 },
      ],
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(removeSessionMarkerFn).toHaveBeenCalledWith(6488));
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(6487);
    rejectFirst(new Error('old server ACK timeout'));
    await recovery;
  });

  it('settles one Session fence and releases every dead retry marker in its group', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'captured' as const,
        sessionId: 'sess-retry-chain',
        committedFenceMs: 51,
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-retry-chain',
      })),
    };
    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-retry-chain', pid: 6490, activeTurnId: 'turn-a' },
        { sessionId: 'sess-retry-chain', pid: 6491, activeTurnId: 'turn-b' },
      ],
      removeSessionMarkerFn,
    });
    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledTimes(1);
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledTimes(2);
    expect(apiMachine.finalizeMachineSessionTerminal).toHaveBeenCalledTimes(1);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6490);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(6491);
  });

  it('releases dead exact-owned markers without closing a recovered live same-Session owner', async () => {
    const removeSessionMarkerIfOwnedFn = vi.fn(async () => true);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(),
      finalizeMachineSessionTerminal: vi.fn(),
    };
    await publishOrphanedStartupSessionEnds({
      apiMachine,
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-live-recovered',
        pid: 6492,
        activeTurnId: 'turn-obsolete',
        processCommandHash: 'a'.repeat(64),
        processStartTimeMs: 123,
        recoveredLiveSession: true,
      }],
      removeSessionMarkerIfOwnedFn,
    });
    expect(apiMachine.captureMachineSessionTerminal).not.toHaveBeenCalled();
    expect(apiMachine.finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledTimes(1);
    expect(removeSessionMarkerIfOwnedFn).toHaveBeenCalledWith({
      pid: 6492,
      happySessionId: 'sess-live-recovered',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 123,
      isStillOwned: expect.any(Function),
    });
  });
});
