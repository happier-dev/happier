/**
 * Constant-space evidence for opaque provider-cursor walks.
 *
 * A complete cursor history proves a repeat immediately, but a history carried
 * in a continuation grows once per page and eventually turns the transport's
 * real JSON envelope into an accidental depth wall. This probe uses Brent's
 * schedule instead: it retains one earlier cursor and moves that checkpoint on
 * a doubling interval. Every finite cycle is still detected, while serialized
 * state stays two cursors and two integers wide for the whole walk.
 *
 * This owner detects only revisits. Each source keeps authority over what a
 * revisit means in its own result vocabulary.
 */

export type CursorCycleProbeV1 = Readonly<{
  /** A position this walk has already reached. Never empty. */
  cursor: string;
  /** Steps since this checkpoint was adopted. Always `< interval`. */
  stepsSince: number;
  /** Checkpoint interval. Always a power of two. */
  interval: number;
}>;

export type CursorCycleWalkV1 = Readonly<{
  /** The current provider position. */
  cursor: string;
  probe: CursorCycleProbeV1;
}>;

export type CursorCycleAdvanceV1 =
  | Readonly<{ kind: 'revisited' }>
  | Readonly<{ kind: 'advanced'; walk: CursorCycleWalkV1 }>;

// Starting at two catches A -> B -> A on the step that closes it.
const INITIAL_INTERVAL = 2;
// The largest power of two below JavaScript's safe-integer boundary. Clamping
// there prevents numeric corruption without inventing a product/page limit.
const MAX_INTERVAL = 2 ** 52;

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= INITIAL_INTERVAL
    && Number.isInteger(Math.log2(value));
}

/** Re-admit only probe state this schedule can mint. */
export function readCursorCycleProbeV1(value: unknown): CursorCycleProbeV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const cursor = record['cursor'];
  const stepsSince = record['stepsSince'];
  const interval = record['interval'];
  if (typeof cursor !== 'string' || cursor === '') return null;
  if (typeof interval !== 'number' || !isPowerOfTwo(interval) || interval > MAX_INTERVAL) {
    return null;
  }
  if (
    typeof stepsSince !== 'number'
    || !Number.isSafeInteger(stepsSince)
    || stepsSince < 0
    || stepsSince >= interval
  ) {
    return null;
  }
  return Object.freeze({ cursor, stepsSince, interval });
}

/** Advance one cursor walk, or report that it returned to an earlier position. */
export function advanceCursorCycleWalkV1(
  walk: CursorCycleWalkV1 | null,
  next: string,
): CursorCycleAdvanceV1 {
  if (walk === null) {
    return Object.freeze({
      kind: 'advanced' as const,
      walk: Object.freeze({
        cursor: next,
        probe: Object.freeze({ cursor: next, stepsSince: 0, interval: INITIAL_INTERVAL }),
      }),
    });
  }
  if (next === walk.cursor || next === walk.probe.cursor) {
    return Object.freeze({ kind: 'revisited' as const });
  }
  const stepsSince = walk.probe.stepsSince + 1;
  const probe: CursorCycleProbeV1 = stepsSince >= walk.probe.interval
    ? Object.freeze({
      cursor: next,
      stepsSince: 0,
      interval: Math.min(walk.probe.interval * 2, MAX_INTERVAL),
    })
    : Object.freeze({ ...walk.probe, stepsSince });
  return Object.freeze({
    kind: 'advanced' as const,
    walk: Object.freeze({ cursor: next, probe }),
  });
}
