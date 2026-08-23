import { describe, expect, it } from 'vitest';

import {
  advanceSentryCursorWalk,
  readSentryCursorProbe,
  type SentryCursorWalkV1,
} from './sentryCursorCycle.js';

/**
 * Drives a walk over a provider that emits `sequence` forever, and reports the
 * step on which the walk noticed it had been somewhere already.
 *
 * `null` means it never noticed within `limit` steps, which for a repeating
 * sequence is the failure this owner exists to prevent.
 */
function stepsUntilCaught(sequence: readonly string[], limit = 4_096): number | null {
  let walk: SentryCursorWalkV1 | null = null;
  for (let step = 1; step <= limit; step += 1) {
    const advanced = advanceSentryCursorWalk(walk, sequence[(step - 1) % sequence.length] as string);
    if (advanced.kind === 'revisited') return step;
    walk = advanced.walk;
  }
  return null;
}

describe('the shared Sentry cursor-cycle probe', () => {
  it('catches the one-step repeat on the page that closes it', () => {
    expect(stepsUntilCaught(['A', 'A'])).toBe(2);
  });

  it('catches a one-step repeat while the probe is still watching an older position', () => {
    // `A → B → B`. The saved position is still `A` here, so ONLY the comparison
    // against the cursor that produced this very page sees the repeat. Without
    // it the walk reads two more pages before the probe happens to catch up,
    // and a provider that pins itself is followed further than it should be.
    expect(stepsUntilCaught(['A', 'B', 'B'])).toBe(3);
  });

  it('catches the two-page alternation on the page that closes it', () => {
    // `A → B → A`. This is the case a comparison against the current request
    // cannot see at all, and the reason the first wait is two steps rather than
    // Brent's one: a probe that moved off `A` after one step would need a fourth
    // page to say the same thing.
    expect(stepsUntilCaught(['A', 'B'])).toBe(3);
  });

  it('catches a cycle of any length, which is the whole point of keeping evidence', () => {
    // A bounded probe trades WHEN a longer cycle is seen, never WHETHER. Every
    // one of these repeats forever; none may be walked forever.
    for (const length of [3, 4, 5, 8, 13, 32, 100]) {
      const sequence = Array.from({ length }, (_, index) => `c${index}`);
      const caught = stepsUntilCaught(sequence);
      expect(caught).not.toBeNull();
      // And the cost of the bound stays proportionate: a walk never spends more
      // than a small multiple of the cycle before it stops.
      expect(caught ?? Infinity).toBeLessThanOrEqual(length * 4);
    }
  });

  it('never stops a walk that keeps finding new positions', () => {
    let walk: SentryCursorWalkV1 | null = null;
    for (let step = 0; step < 5_000; step += 1) {
      const advanced = advanceSentryCursorWalk(walk, `c${step}`);
      expect(advanced.kind).toBe('advanced');
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
    }
  });

  it('keeps its own state one constant size however long the walk runs', () => {
    // The whole reason this is a probe and not a position history: the record
    // rides inside a bounded token, and a record that grows per page is a page
    // ceiling nobody declared.
    let walk: SentryCursorWalkV1 | null = null;
    let widest = 0;
    for (let step = 0; step < 5_000; step += 1) {
      const advanced = advanceSentryCursorWalk(walk, `1754000000000:${step}:0`);
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
      widest = Math.max(widest, JSON.stringify(walk).length);
    }
    // Two cursors and two small numbers, and nothing that counts pages.
    expect(widest).toBeLessThan(128);
  });

  it('watches only a position this walk actually reached', () => {
    // The first advertised cursor cannot be a return: the walk has requested
    // nothing, so refusing it would stop a walk on its very first page.
    const first = advanceSentryCursorWalk(null, 'A');
    expect(first.kind).toBe('advanced');
    if (first.kind !== 'advanced') return;
    expect(first.walk).toEqual({
      cursor: 'A',
      probe: { cursor: 'A', stepsSince: 0, interval: 2 },
    });
  });

  it('reads back only a record its own schedule could have produced', () => {
    const minted = { cursor: 'A', stepsSince: 1, interval: 4 };
    expect(readSentryCursorProbe(minted)).toEqual(minted);

    for (const rejected of [
      undefined,
      null,
      'A',
      ['A'],
      { cursor: '', stepsSince: 0, interval: 2 },
      { cursor: 'A', stepsSince: 0 },
      { cursor: 'A', interval: 2 },
      // A step count outside its own wait, a wait that is not a doubling of the
      // first, and a wait beyond what two billion pages could reach are all
      // records this side never wrote.
      { cursor: 'A', stepsSince: 2, interval: 2 },
      { cursor: 'A', stepsSince: -1, interval: 2 },
      { cursor: 'A', stepsSince: 0.5, interval: 2 },
      { cursor: 'A', stepsSince: 0, interval: 1 },
      { cursor: 'A', stepsSince: 0, interval: 0 },
      { cursor: 'A', stepsSince: 0, interval: 6 },
      { cursor: 'A', stepsSince: 0, interval: 2 ** 31 },
    ]) {
      expect(readSentryCursorProbe(rejected)).toBeNull();
    }
  });

  it('accepts every schedule an advancing walk actually mints', () => {
    // The reader above rejects a great deal; this is what keeps that from being
    // a reader that would also reject the walk's own output.
    let walk: SentryCursorWalkV1 | null = null;
    for (let step = 0; step < 2_000; step += 1) {
      const advanced = advanceSentryCursorWalk(walk, `c${step}`);
      if (advanced.kind !== 'advanced') return;
      walk = advanced.walk;
      expect(readSentryCursorProbe(JSON.parse(JSON.stringify(walk.probe)))).toEqual(walk.probe);
    }
  });
});
