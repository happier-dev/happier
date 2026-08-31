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
  it('awaits durable acceptance of one deterministic strict exact-turn row before releasing marker evidence', async () => {
    let accept!: () => void;
    const enqueueExactTurnEnd = vi.fn(() => new Promise<void>((resolve) => {
      accept = resolve;
    }));
    const releaseMarkerEvidence = vi.fn(async () => {});

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
      mutationId: expectedMutationId('session-1', 'turn-1', 1234),
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

  it('stages no terminal row when P1 exposes no exact active turn', async () => {
    const enqueueExactTurnEnd = vi.fn(async () => {});
    const releaseMarkerEvidence = vi.fn(async () => {});

    await expect(stageObservedExit({
      trackedSession: { pid: 41, happySessionId: 'session-1' },
      observedAt: 1234,
      enqueueExactTurnEnd,
      releaseMarkerEvidence,
    })).resolves.toEqual({ status: 'no_exact_turn', markerPid: 41 });

    expect(enqueueExactTurnEnd).not.toHaveBeenCalled();
    expect(releaseMarkerEvidence).toHaveBeenCalledWith({
      markerPid: 41,
      sessionId: 'session-1',
      turnId: null,
    });
  });

  it('retains replayable marker evidence when durable acceptance rejects', async () => {
    const releaseMarkerEvidence = vi.fn(async () => {});
    await expect(stageObservedExit({
      trackedSession: {
        pid: 41,
        happySessionId: 'session-1',
        activeTurnId: 'turn-1',
      },
      observedAt: 1234,
      enqueueExactTurnEnd: async () => {
        throw new Error('persistence failed');
      },
      releaseMarkerEvidence,
    })).rejects.toThrow('persistence failed');

    expect(releaseMarkerEvidence).not.toHaveBeenCalled();
  });

  it('keeps identities isolated across sessions and turns', async () => {
    const rows: unknown[] = [];
    for (const [sessionId, turnId] of [['session-a', 'turn-1'], ['session-b', 'turn-1'], ['session-a', 'turn-2']] as const) {
      await stageObservedExit({
        trackedSession: { pid: rows.length + 1, happySessionId: sessionId, activeTurnId: turnId },
        observedAt: 99,
        enqueueExactTurnEnd: async (row) => { rows.push(row); },
        releaseMarkerEvidence: async () => {},
      });
    }

    expect(new Set(rows.map((row) => (row as { mutationId: string }).mutationId)).size).toBe(3);
  });

  it('keeps distinct observations of the same session turn isolated', async () => {
    const rows: Array<{ mutationId: string }> = [];
    for (const observedAt of [99, 100]) {
      await stageObservedExit({
        trackedSession: { pid: observedAt, happySessionId: 'session-a', activeTurnId: 'turn-1' },
        observedAt,
        enqueueExactTurnEnd: async (row) => { rows.push(row); },
        releaseMarkerEvidence: async () => {},
      });
    }

    expect(rows[0]?.mutationId).not.toBe(rows[1]?.mutationId);
  });
});
