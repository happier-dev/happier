import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { stageObservedExit } from './stageObservedExit';

function expectedMutationId(sessionId: string, turnId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sessionId, turnId }))
    .digest('hex');
  return `daemon-observed-exit:${digest}`;
}

describe('stageObservedExit', () => {
  it('awaits durable acceptance of one strict exact-turn row before releasing marker evidence', async () => {
    let accept!: () => void;
    const enqueueExactTurnEnd = vi.fn(() => new Promise<void>((resolve) => {
      accept = resolve;
    }));
    const releaseMarkerEvidence = vi.fn(async () => undefined);

    const staging = stageObservedExit({
      trackedSession: {
        pid: 41,
        sessionRunnerPid: 42,
        happySessionId: 'session-1',
        activeTurnId: 'turn-1',
      },
      observedAt: 1234,
      enqueueExactTurnEnd,
      releaseMarkerEvidence,
    });

    await Promise.resolve();
    expect(enqueueExactTurnEnd).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-1',
      mutationId: expectedMutationId('session-1', 'turn-1'),
      action: 'end_session',
      turnId: 'turn-1',
      observedAt: 1234,
    });
    expect(releaseMarkerEvidence).not.toHaveBeenCalled();

    accept();
    await expect(staging).resolves.toEqual({ status: 'staged', markerPid: 42 });
    expect(releaseMarkerEvidence).toHaveBeenCalledWith({
      markerPid: 42,
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
  });

  it('authors no terminal row without an exact active turn and retains evidence on staging failure', async () => {
    const releaseNoTurn = vi.fn(async () => undefined);
    const enqueueNoTurn = vi.fn(async () => undefined);
    await expect(stageObservedExit({
      trackedSession: { pid: 41, happySessionId: 'session-1' },
      observedAt: 1234,
      enqueueExactTurnEnd: enqueueNoTurn,
      releaseMarkerEvidence: releaseNoTurn,
    })).resolves.toEqual({ status: 'no_exact_turn', markerPid: 41 });
    expect(enqueueNoTurn).not.toHaveBeenCalled();
    expect(releaseNoTurn).toHaveBeenCalledWith({ markerPid: 41, sessionId: 'session-1', turnId: null });

    const releaseFailed = vi.fn(async () => undefined);
    await expect(stageObservedExit({
      trackedSession: { pid: 41, happySessionId: 'session-1', activeTurnId: 'turn-1' },
      observedAt: 1234,
      enqueueExactTurnEnd: async () => { throw new Error('persistence failed'); },
      releaseMarkerEvidence: releaseFailed,
    })).rejects.toThrow('persistence failed');
    expect(releaseFailed).not.toHaveBeenCalled();
  });
});
