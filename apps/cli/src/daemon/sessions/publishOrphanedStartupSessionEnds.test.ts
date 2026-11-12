import { describe, expect, it, vi } from 'vitest';

import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';
import { isSessionRunnerActive } from './isSessionRunnerActive';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('publishOrphanedStartupSessionEnds', () => {
  it.each([false, true])('retains another Home marker before a permanent terminal refusal (same Session id sibling=%s)', async sameHomeSibling => {
    const foreign = { sessionId: 'shared-id', trackingKey: legacyPidSessionTrackingKey(101), pid: 101, requesterWorkAttributionV1: {
      serverId: 'other-home', accountId: 'requester', machineId: 'machine', installationId: 'installation',
    } };
    const local = { ...foreign, trackingKey: legacyPidSessionTrackingKey(102), pid: 102, requesterWorkAttributionV1: { ...foreign.requesterWorkAttributionV1, serverId: 'current-home' } };
    let captures = 0;
    const removals: string[] = [];
    const retained = await publishOrphanedStartupSessionEnds({
      serverId: 'current-home', orphanedDeadDaemonSessions: sameHomeSibling ? [foreign, local] : [foreign],
      apiMachine: {
        captureMachineSessionTerminal: async () => { captures++; return { v: 1, status: 'rejected', sessionId: 'shared-id', reason: 'not_found' }; },
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('A permanent refusal has no turn to stage'); },
        finalizeMachineSessionTerminal: async () => { throw new Error('A refused capture cannot finalize'); },
      },
      removeSessionMarkerFn: async trackingKey => { removals.push(trackingKey); },
    });
    expect(retained).toEqual([foreign]);
    expect(captures).toBe(sameHomeSibling ? 1 : 0);
    expect(removals).toEqual(sameHomeSibling ? [legacyPidSessionTrackingKey(102)] : []);
  });

  it('awaits exact terminal staging before releasing the orphan marker', async () => {
    const calls: string[] = [];
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => { calls.push('persisted'); }),
      captureMachineSessionTerminal: vi.fn(async () => {
        calls.push('captured');
        return {
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-orphaned-6480',
          authority: { kind: 'generation' as const, publisherGeneration: '7' },
        };
      }),
      finalizeMachineSessionTerminal: vi.fn(async () => {
        calls.push('finalized');
        return { v: 1 as const, status: 'closed' as const, sessionId: 'sess-orphaned-6480' };
      }),
    };
    const removeSessionMarkerFn = vi.fn(async () => { calls.push('removed'); });

    await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-orphaned-6480',
        trackingKey: legacyPidSessionTrackingKey(6480),
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
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6480));
  });

  it('finalizes the pre-staging authority when a successor advances presence during durable turn staging', async () => {
    const calls: string[] = [];
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => { releaseStage = resolve; });
    const finalizeMachineSessionTerminal = vi.fn(async () => {
      calls.push('finalized');
      return { v: 1 as const, status: 'superseded' as const, sessionId: 'sess-fence-race' };
    });
    const removeSessionMarkerFn = vi.fn(async () => { calls.push('removed'); });
    const observation = publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine: {
        captureMachineSessionTerminal: vi.fn(async () => {
          calls.push('captured');
          return {
            v: 1 as const,
            status: 'captured' as const,
            sessionId: 'sess-fence-race',
            authority: { kind: 'generation' as const, publisherGeneration: '10' },
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
        trackingKey: legacyPidSessionTrackingKey(6486),
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
      authority: { kind: 'generation', publisherGeneration: '10' },
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
        authority: { kind: 'generation' as const, publisherGeneration: '12' },
      };
    });
    const finalizeMachineSessionTerminal = vi.fn(async () => ({
      v: 1 as const,
      status: 'closed' as const,
      sessionId: 'sess-quiesced-capture',
    }));
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const publication = publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd,
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-capture',
        trackingKey: legacyPidSessionTrackingKey(6493),
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
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd,
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-quiesced-staging',
          authority: { kind: 'generation' as const, publisherGeneration: '13' },
        })),
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-staging',
        trackingKey: legacyPidSessionTrackingKey(6494),
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
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-quiesced-finalize',
          authority: { kind: 'generation' as const, publisherGeneration: '14' },
        })),
        finalizeMachineSessionTerminal,
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-quiesced-finalize',
        trackingKey: legacyPidSessionTrackingKey(6495),
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
        authority: { kind: 'generation' as const, publisherGeneration: '8' },
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-orphaned-no-turn',
      })),
    };
    const removeSessionMarkerFn = vi.fn(async () => undefined);

    await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-orphaned-no-turn', trackingKey: legacyPidSessionTrackingKey(6481), pid: 6481 }],
      removeSessionMarkerFn,
    });

    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledWith('sess-orphaned-no-turn');
    expect(apiMachine.finalizeMachineSessionTerminal).toHaveBeenCalledWith({
      sessionId: 'sess-orphaned-no-turn',
      authority: { kind: 'generation', publisherGeneration: '8' },
    });
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6481));
  });

  it('retains the orphan marker and continues when exact terminal staging fails', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    const captureMachineSessionTerminal = vi.fn(async () => ({
      v: 1 as const,
      status: 'captured' as const,
      sessionId: 'sess-orphaned-failed',
      authority: { kind: 'generation' as const, publisherGeneration: '11' },
    }));
    await expect(publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('disk unavailable'); },
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal: vi.fn(),
      },
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-orphaned-failed',
        trackingKey: legacyPidSessionTrackingKey(6482),
        pid: 6482,
        activeTurnId: 'turn-exact-failed',
      }],
      removeSessionMarkerFn,
    })).resolves.toEqual([{
      sessionId: 'sess-orphaned-failed',
      trackingKey: legacyPidSessionTrackingKey(6482),
      pid: 6482,
      activeTurnId: 'turn-exact-failed',
    }]);
    expect(captureMachineSessionTerminal).toHaveBeenCalledWith('sess-orphaned-failed');
    expect(removeSessionMarkerFn).not.toHaveBeenCalled();
  });

  it('releases stale-fence orphan evidence after a successor supersedes finalize', async () => {
    const removeSessionMarkerFn = vi.fn(async () => undefined);
    await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(),
        captureMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'captured' as const,
          sessionId: 'sess-successor',
          authority: { kind: 'generation' as const, publisherGeneration: '9' },
        })),
        finalizeMachineSessionTerminal: vi.fn(async () => ({
          v: 1 as const,
          status: 'superseded' as const,
          sessionId: 'sess-successor',
        })),
      },
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-successor', trackingKey: legacyPidSessionTrackingKey(6483), pid: 6483 }],
      removeSessionMarkerFn,
    });
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6483));
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
      serverId: 'current-home',
      apiMachine: {
        enqueueDaemonTerminalExactTurnEnd: vi.fn(),
        captureMachineSessionTerminal,
        finalizeMachineSessionTerminal: vi.fn(),
      },
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-failed', trackingKey: legacyPidSessionTrackingKey(6484), pid: 6484 },
        { sessionId: 'sess-later', trackingKey: legacyPidSessionTrackingKey(6485), pid: 6485 },
      ],
      removeSessionMarkerFn,
    });
    expect(removeSessionMarkerFn).not.toHaveBeenCalledWith(6484);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6485));
  });

  it.each(['not_found', 'archived', 'unsupported'] as const)(
    'releases orphan evidence when terminal capture definitively reports %s',
    async reason => {
      const enqueueDaemonTerminalExactTurnEnd = vi.fn(async () => undefined);
      const finalizeMachineSessionTerminal = vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-definitively-gone',
      }));
      const retireTerminalControlServiceability = vi.fn(async () => undefined);
      const removeSessionMarkerFn = vi.fn(async () => undefined);

      await expect(publishOrphanedStartupSessionEnds({
        serverId: 'current-home',
        apiMachine: {
          enqueueDaemonTerminalExactTurnEnd,
          captureMachineSessionTerminal: vi.fn(async () => ({
            v: 1 as const,
            status: 'rejected' as const,
            sessionId: 'sess-definitively-gone',
            reason,
          })),
          finalizeMachineSessionTerminal,
        },
        orphanedDeadDaemonSessions: [{
          sessionId: 'sess-definitively-gone',
          trackingKey: legacyPidSessionTrackingKey(6489),
          pid: 6489,
          activeTurnId: 'turn-no-longer-addressable',
        }],
        retireTerminalControlServiceability,
        removeSessionMarkerFn,
      })).resolves.toEqual([]);

      expect(enqueueDaemonTerminalExactTurnEnd).not.toHaveBeenCalled();
      expect(finalizeMachineSessionTerminal).not.toHaveBeenCalled();
      expect(retireTerminalControlServiceability).not.toHaveBeenCalled();
      expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6489));
    },
  );

  it.each(['unauthorized', 'internal_error'] as const)(
    'retains orphan evidence when terminal capture is inconclusive: %s',
    async reason => {
      const removeSessionMarkerFn = vi.fn(async () => undefined);
      const orphan = { sessionId: 'sess-unsettled', trackingKey: legacyPidSessionTrackingKey(6489), pid: 6489 };

      await expect(publishOrphanedStartupSessionEnds({
        serverId: 'current-home',
        apiMachine: {
          enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
          captureMachineSessionTerminal: vi.fn(async () => ({
            v: 1 as const,
            status: 'rejected' as const,
            sessionId: orphan.sessionId,
            reason,
          })),
          finalizeMachineSessionTerminal: vi.fn(),
        },
        orphanedDeadDaemonSessions: [orphan],
        removeSessionMarkerFn,
      })).resolves.toEqual([orphan]);

      expect(removeSessionMarkerFn).not.toHaveBeenCalled();
    },
  );

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
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-hung', trackingKey: legacyPidSessionTrackingKey(6487), pid: 6487 },
        { sessionId: 'sess-ready', trackingKey: legacyPidSessionTrackingKey(6488), pid: 6488 },
      ],
      removeSessionMarkerFn,
    });

    await vi.waitFor(() => expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6488)));
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
        authority: { kind: 'generation' as const, publisherGeneration: '51' },
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const,
        status: 'closed' as const,
        sessionId: 'sess-retry-chain',
      })),
    };
    await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [
        { sessionId: 'sess-retry-chain', trackingKey: legacyPidSessionTrackingKey(6490), pid: 6490, activeTurnId: 'turn-a' },
        { sessionId: 'sess-retry-chain', trackingKey: legacyPidSessionTrackingKey(6491), pid: 6491, activeTurnId: 'turn-b' },
      ],
      removeSessionMarkerFn,
    });
    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledTimes(1);
    expect(apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledTimes(2);
    expect(apiMachine.finalizeMachineSessionTerminal).toHaveBeenCalledTimes(1);
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6490));
    expect(removeSessionMarkerFn).toHaveBeenCalledWith(legacyPidSessionTrackingKey(6491));
  });

  it('releases dead exact-owned markers without closing a recovered live same-Session owner', async () => {
    const removeSessionMarkerIfOwnedFn = vi.fn(async () => true);
    const apiMachine = {
      enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
      captureMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const, status: 'captured' as const, sessionId: 'sess-live-recovered',
        authority: { kind: 'generation' as const, publisherGeneration: '52' },
      })),
      finalizeMachineSessionTerminal: vi.fn(async () => ({
        v: 1 as const, status: 'closed' as const, sessionId: 'sess-live-recovered',
      })),
    };
    await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [{
        sessionId: 'sess-live-recovered',
        trackingKey: legacyPidSessionTrackingKey(6492),
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
      trackingKey: legacyPidSessionTrackingKey(6492),
      happySessionId: 'sess-live-recovered',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 123,
      isStillOwned: expect.any(Function),
    });
    removeSessionMarkerIfOwnedFn.mockClear();
    // This Session acquired a live runner after the original startup scan.
    // Exercise the real live-runner owner, including its OS liveness reader.
    const liveTrackedSessions = [{ trackingKey: legacyPidSessionTrackingKey(process.pid), startedBy: 'daemon', happySessionId: 'sess-live-recovered', pid: process.pid }];
    const remaining = await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-live-recovered', trackingKey: legacyPidSessionTrackingKey(6493), pid: 6493, activeTurnId: 'turn-old-retry' }],
      isSessionAlreadyRunning: async (sessionId: string) =>
        await isSessionRunnerActive({ sessionId, trackedSessions: liveTrackedSessions }),
      removeSessionMarkerIfOwnedFn,
    });
    expect(remaining).toEqual([]);
    expect(apiMachine.captureMachineSessionTerminal).not.toHaveBeenCalled();
    expect(apiMachine.finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(removeSessionMarkerIfOwnedFn).toHaveBeenCalledWith(expect.objectContaining({ trackingKey: legacyPidSessionTrackingKey(6493) }));

    liveTrackedSessions.length = 0;
    apiMachine.captureMachineSessionTerminal.mockImplementation(async () => {
      liveTrackedSessions.push({ trackingKey: legacyPidSessionTrackingKey(process.pid), startedBy: 'daemon', happySessionId: 'sess-live-recovered', pid: process.pid });
      return {
        v: 1 as const, status: 'captured' as const, sessionId: 'sess-live-recovered',
        authority: { kind: 'generation' as const, publisherGeneration: '52' },
      };
    });
    // A successor can appear while capture is in flight, not only before retry.
    expect(await publishOrphanedStartupSessionEnds({
      serverId: 'current-home',
      apiMachine,
      orphanedDeadDaemonSessions: [{ sessionId: 'sess-live-recovered', trackingKey: legacyPidSessionTrackingKey(6494), pid: 6494, activeTurnId: 'turn-capture-retry' }],
      isSessionAlreadyRunning: async (sessionId: string) =>
        await isSessionRunnerActive({ sessionId, trackedSessions: liveTrackedSessions }),
      removeSessionMarkerIfOwnedFn,
    })).toEqual([]);
    expect(apiMachine.captureMachineSessionTerminal).toHaveBeenCalledTimes(1);
    expect(apiMachine.finalizeMachineSessionTerminal).not.toHaveBeenCalled();
    expect(removeSessionMarkerIfOwnedFn).toHaveBeenCalledWith(expect.objectContaining({ trackingKey: legacyPidSessionTrackingKey(6494) }));
  });
});
