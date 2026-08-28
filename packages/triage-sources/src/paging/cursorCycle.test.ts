import { describe, expect, it } from 'vitest';

import {
  advanceCursorCycleWalkV1,
  readCursorCycleProbeV1,
  type CursorCycleWalkV1,
} from './cursorCycle.js';

function stepsUntilCaught(sequence: readonly string[], limit = 4_096): number | null {
  let walk: CursorCycleWalkV1 | null = null;
  for (let step = 1; step <= limit; step += 1) {
    const advanced = advanceCursorCycleWalkV1(
      walk,
      sequence[(step - 1) % sequence.length] as string,
    );
    if (advanced.kind === 'revisited') return step;
    walk = advanced.walk;
  }
  return null;
}

describe('the shared cursor-cycle probe', () => {
  it('catches immediate and alternating repeats on the step that closes them', () => {
    expect(stepsUntilCaught(['A', 'A'])).toBe(2);
    expect(stepsUntilCaught(['A', 'B', 'B'])).toBe(3);
    expect(stepsUntilCaught(['A', 'B'])).toBe(3);
  });

  it('catches a cycle of any length without false-stopping an advancing walk', () => {
    for (const length of [3, 4, 5, 8, 13, 32, 100]) {
      const caught = stepsUntilCaught(
        Array.from({ length }, (_, index) => `c${index}`),
      );
      expect(caught).not.toBeNull();
      expect(caught ?? Infinity).toBeLessThanOrEqual(length * 4);
    }

    let walk: CursorCycleWalkV1 | null = null;
    for (let step = 0; step < 5_000; step += 1) {
      const advanced = advanceCursorCycleWalkV1(walk, `unique-${step}`);
      expect(advanced.kind).toBe('advanced');
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
    }
  });

  it('keeps serialized evidence constant-size across a long walk', () => {
    let walk: CursorCycleWalkV1 | null = null;
    let widest = 0;
    for (let step = 0; step < 5_000; step += 1) {
      const advanced = advanceCursorCycleWalkV1(walk, `1754000000000:${step}:0`);
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
      widest = Math.max(widest, JSON.stringify(walk).length);
    }
    expect(widest).toBeLessThan(128);
  });

  it('watches only a position the walk actually reached', () => {
    const first = advanceCursorCycleWalkV1(null, 'A');
    expect(first).toEqual({
      kind: 'advanced',
      walk: {
        cursor: 'A',
        probe: { cursor: 'A', stepsSince: 0, interval: 2 },
      },
    });
  });

  it('reads back only states its schedule can mint', () => {
    const minted = { cursor: 'A', stepsSince: 1, interval: 4 };
    expect(readCursorCycleProbeV1(minted)).toEqual(minted);
    for (const rejected of [
      undefined,
      null,
      'A',
      ['A'],
      { cursor: '', stepsSince: 0, interval: 2 },
      { cursor: 'A', stepsSince: 0 },
      { cursor: 'A', interval: 2 },
      { cursor: 'A', stepsSince: 2, interval: 2 },
      { cursor: 'A', stepsSince: -1, interval: 2 },
      { cursor: 'A', stepsSince: 0.5, interval: 2 },
      { cursor: 'A', stepsSince: 0, interval: 1 },
      { cursor: 'A', stepsSince: 0, interval: 0 },
      { cursor: 'A', stepsSince: 0, interval: 6 },
      { cursor: 'A', stepsSince: 0, interval: 2 ** 53 },
    ]) {
      expect(readCursorCycleProbeV1(rejected)).toBeNull();
    }
  });

  it('re-admits every state an advancing walk actually mints', () => {
    let walk: CursorCycleWalkV1 | null = null;
    for (let step = 0; step < 2_000; step += 1) {
      const advanced = advanceCursorCycleWalkV1(walk, `c${step}`);
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
      expect(readCursorCycleProbeV1(JSON.parse(JSON.stringify(walk.probe))))
        .toEqual(walk.probe);
    }
  });
});
