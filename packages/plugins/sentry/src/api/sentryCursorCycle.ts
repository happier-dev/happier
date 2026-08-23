/**
 * The one rule both of this source's cursor walks share.
 *
 * Sentry paginates the scan plane and the two paged detail reads with the same
 * opaque cursor, and both planes need the same evidence for the same reason:
 * comparing an advertised next cursor against the single cursor that produced it
 * only sees `A → A`. A provider alternating `A → B → A` advertises a cursor that
 * differs from the one just requested on every page, so a walk that keeps only
 * its current position mints a frontier for a position it already read and keeps
 * doing so for as long as the caller asks.
 *
 * ## Why the evidence is a probe and not a history
 *
 * A walk whose pages are separate invocations has exactly one place to keep that
 * evidence: inside the bounded token it hands back. The first shape that worked
 * — the complete list of positions this walk had requested — made the token grow
 * by one cursor per page, and a bounded token that grows is a walk with an
 * undisclosed page ceiling. The arithmetic is not theoretical: with Sentry's own
 * `1754000000000:0:0` keyset cursors the scan token stops fitting the protocol's
 * 4 KiB envelope at the 199th page, and the detail token stops fitting its own
 * 512-byte bound at the 23rd — so the 23rd "Load more" on a busy issue settled a
 * `continuationUnavailable` partial that the reader could not get past, and the
 * branch written for a pathologically wide provider cursor had quietly become
 * the ordinary end of a long walk.
 *
 * So the walk carries ONE saved earlier position instead of all of them, moved
 * on Brent's schedule: watch a position, and after a doubling number of steps
 * adopt the current one in its place. Any repeating cursor sequence is still
 * caught — once the saved position lies inside the cycle and the wait exceeds
 * the cycle's length, the walk necessarily returns to it — while the token stays
 * exactly two cursors wide no matter how long the walk runs. What is traded is
 * WHEN a longer cycle is seen, never WHETHER: the immediate `A → A` repeat and
 * the `A → B → A` alternation are still caught on the page that closes them
 * (which is why the wait starts at two rather than Brent's one), and a wider
 * cycle costs a bounded handful of extra pages before the same stop.
 *
 * ## What is shared, and what is not
 *
 * The SHAPE invariant is shared, not the verdict. Each plane decides for itself
 * what a repeat means in its own outcome vocabulary — the scan settles a partial
 * health, a detail page settles a stopped-short walk — but a second spelling of
 * "has this walk been here already" is how the two would start disagreeing about
 * which tokens they will accept from themselves.
 *
 * The roster of this source's cursor walks is exactly three, and one of them
 * deliberately does NOT reach here: `source/operations.ts#collectAccountCandidates`
 * walks the organization listing inside a single invocation and keeps an exact
 * `Set` of the positions it has requested. Nothing about that walk is
 * serialized, so the bound that forces a probe does not exist for it, and
 * substituting one would only make an exact answer later. It is named here
 * rather than left to be discovered, because a roster that silently omits a
 * straggler is how the last one survived.
 */

/**
 * The saved position one walk is watching for, and the schedule that moves it.
 *
 * `interval` is the number of steps to take before adopting a new position, and
 * `stepsSince` is how many of them have been taken. Both travel in the token
 * because the walk they describe is spread across invocations.
 */
export type SentryCursorProbeV1 = Readonly<{
  /** A position this walk has already requested. Never empty. */
  cursor: string;
  /** Steps taken since this position was adopted. Always `< interval`. */
  stepsSince: number;
  /** Steps to take before adopting the next one. Always a power of two. */
  interval: number;
}>;

/**
 * Where one walk stands: the position that produced the response being read, and
 * the earlier position it is watching for. `null` is a walk that has requested
 * nothing yet, which cannot have been anywhere already.
 */
export type SentryCursorWalkV1 = Readonly<{
  cursor: string;
  probe: SentryCursorProbeV1;
}>;

export type SentryCursorAdvanceV1 =
  /** The advertised cursor is a position this walk has already requested. */
  | Readonly<{ kind: 'revisited' }>
  /** A position this walk has not been to; here is where it now stands. */
  | Readonly<{ kind: 'advanced'; walk: SentryCursorWalkV1 }>;

/**
 * The first wait is two steps, not Brent's one.
 *
 * With a one-step wait the probe moves off `A` before `A → B → A` closes, and
 * the alternation — the exact provider behaviour this evidence exists for — is
 * seen a page later than the position history saw it. Two costs one number in
 * the token and keeps the two named cases caught on the page that closes them.
 */
const INITIAL_INTERVAL = 2;

/**
 * A ceiling on the doubling, so a decoded interval is a number this side could
 * have minted.
 *
 * Reaching it would take more than two billion provider pages, and clamping
 * there loses no detection: a probe re-adopted every `2^30` steps still lands
 * inside any cycle a walk that long could be in.
 */
const MAX_INTERVAL = 2 ** 30;

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value >= INITIAL_INTERVAL && (value & (value - 1)) === 0;
}

/**
 * Reads a probe record back out of a token this source minted, or `null` when
 * the bytes do not describe one.
 *
 * The invariants checked here are the ones the schedule above always produces:
 * a non-empty saved position, a power-of-two wait within the ceiling, and a step
 * count strictly inside that wait. A record shaped any other way was not minted
 * here, and a walk cannot vouch for evidence it did not write.
 */
export function readSentryCursorProbe(value: unknown): SentryCursorProbeV1 | null {
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

/**
 * Advances one walk onto the cursor a provider just advertised.
 *
 * `revisited` means this walk has been at that position before — either the one
 * that produced this very response, or the one it has been watching for. The
 * caller settles that in its own vocabulary; nothing here decides what a repeat
 * costs.
 */
export function advanceSentryCursorWalk(
  walk: SentryCursorWalkV1 | null,
  next: string,
): SentryCursorAdvanceV1 {
  if (walk === null) {
    // The walk has requested nothing, so no cursor can be a return.
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
  const probe: SentryCursorProbeV1 = stepsSince >= walk.probe.interval
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
