import { describe, expect, it } from 'vitest';
import type { JsonValue, SessionTurnV1 } from '@happier-dev/protocol';

import { resolveProviderCheckpointForFork } from './resolveProviderCheckpointForFork';

function turn(
  turnId: string,
  startSeqInclusive: number,
  endSeqInclusive: number,
  providerCheckpoint?: JsonValue,
) {
  return {
    turnId,
    agentId: 'grok',
    status: 'completed' as const,
    startedAt: startSeqInclusive,
    updatedAt: endSeqInclusive,
    transcriptAnchors: {
      startUserMessageSeq: startSeqInclusive,
      startSeqInclusive,
      endSeqInclusive,
      ...(providerCheckpoint === undefined ? {} : { providerCheckpoint }),
    },
    rollback: {
      state: 'eligible' as const,
      ...(providerCheckpoint === undefined ? {} : { providerCheckpoint }),
      updatedAt: endSeqInclusive,
    },
  } satisfies SessionTurnV1;
}

describe('resolveProviderCheckpointForFork', () => {
  it('selects the exact canonical turn checkpoint for a message inside that turn', () => {
    expect(resolveProviderCheckpointForFork({
      targetSeqInclusive: 8,
      turns: [
        turn('turn-1', 2, 5, { kind: 'grok_prompt_index', promptIndex: 0 }),
        turn('turn-2', 6, 9, { kind: 'grok_prompt_index', promptIndex: 1 }),
      ],
    })).toEqual({
      turnId: 'turn-2',
      providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 1 },
    });
  });

  it('reads the canonical stored anchor when a predecessor omits it from the derived rollback view', () => {
    const compatibleTurn = turn(
      'turn-2',
      6,
      9,
      { kind: 'grok_prompt_index', promptIndex: 1 },
    );
    compatibleTurn.rollback = {
      state: 'eligible',
      updatedAt: 9,
    };

    expect(resolveProviderCheckpointForFork({
      targetSeqInclusive: 8,
      turns: [compatibleTurn],
    })).toEqual({
      turnId: 'turn-2',
      providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 1 },
    });
  });

  it('fails closed for missing coordinates and synthetic transcript gaps', () => {
    expect(resolveProviderCheckpointForFork({
      targetSeqInclusive: 8,
      turns: [turn('turn-1', 2, 5, { kind: 'grok_prompt_index', promptIndex: 0 })],
    })).toBeNull();
    expect(resolveProviderCheckpointForFork({
      targetSeqInclusive: 4,
      turns: [turn('turn-1', 2, 5)],
    })).toBeNull();
  });

  it('fails closed when overlapping canonical ranges make the coordinate ambiguous', () => {
    expect(resolveProviderCheckpointForFork({
      targetSeqInclusive: 5,
      turns: [
        turn('turn-1', 2, 5, { kind: 'grok_prompt_index', promptIndex: 0 }),
        turn('turn-2', 5, 8, { kind: 'grok_prompt_index', promptIndex: 1 }),
      ],
    })).toBeNull();
  });
});
