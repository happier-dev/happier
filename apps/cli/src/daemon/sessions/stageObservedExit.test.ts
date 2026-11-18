import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { stageObservedExit } from './stageObservedExit';

function expectedMutationId(sessionId: string, turnId: string, observedAt: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sessionId, turnId, observedAt }))
    .digest('hex');
  return `daemon-observed-exit:${digest}`;
}

describe('stageObservedExit', () => {
  it.each([false, true])('keeps exact settlement in durable custody until acceptance (host lost: %s)', async (hostLost) => {
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
      hostLost,
      observedAt: 1234,
      enqueueExactTurnEnd,
      releaseMarkerEvidence,
    });

    await Promise.resolve();
    expect(enqueueExactTurnEnd).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-1',
      mutationId: expectedMutationId('session-1', 'turn-1', 1234),
      ...(hostLost ? { action: 'fail', issue: { v: 1, scope: 'primary_session',
        status: 'failed', code: 'session_host_lost', source: 'stream_error', occurredAt: 1234 } } : { action: 'end_session' }),
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
      hostLost: true,
      observedAt: 1234,
      enqueueExactTurnEnd: enqueueNoTurn,
      releaseMarkerEvidence: releaseNoTurn,
    })).resolves.toEqual({ status: 'no_exact_turn', markerPid: 41 });
    expect(enqueueNoTurn).not.toHaveBeenCalled();
    expect(releaseNoTurn).toHaveBeenCalledWith({ markerPid: 41, sessionId: 'session-1', turnId: null });

    const releaseFailed = vi.fn(async () => undefined);
    await expect(stageObservedExit({
      trackedSession: { pid: 41, happySessionId: 'session-1', activeTurnId: 'turn-1' },
      hostLost: true,
      observedAt: 1234,
      enqueueExactTurnEnd: async () => { throw new Error('persistence failed'); },
      releaseMarkerEvidence: releaseFailed,
    })).rejects.toThrow('persistence failed');
    expect(releaseFailed).not.toHaveBeenCalled();
  });

  it('keeps distinct observations of the same session turn isolated', async () => {
    const rows: Array<{ mutationId: string }> = [];
    for (const observedAt of [99, 100]) {
      await stageObservedExit({
        trackedSession: { pid: observedAt, happySessionId: 'session-a', activeTurnId: 'turn-1' },
        hostLost: true,
        observedAt,
        enqueueExactTurnEnd: async (row) => { rows.push(row); },
        releaseMarkerEvidence: async () => undefined,
      });
    }

    expect(rows[0]?.mutationId).not.toBe(rows[1]?.mutationId);
  });
});
