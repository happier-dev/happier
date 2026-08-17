import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';

/**
 * What a failure says when the source supplied no detail of its own.
 *
 * `class` is the published closed classification and is a machine word:
 * showing `transient` to a reader explains nothing. These are the shell's own
 * words for the same six answers, and they are only ever a fallback — a source
 * that sent bounded non-secret `detail` is quoted verbatim, because it knows
 * which repository, project or account could not be read and this file does not.
 */
const SOURCE_FAILURE_COPY_V1: Readonly<Record<TriageSourceFailureV1['class'], string>> = Object.freeze({
  authentication: 'A source needs you to sign in again.',
  permission: 'A source refused this account access.',
  rateLimit: 'A source asked us to slow down, so its entries may be missing.',
  transient: 'A source could not be reached just now.',
  unknown: 'A source failed for a reason it did not name.',
  unsupportedContract: 'A source answered with something Happier could not read.',
});

/**
 * The reasons the assembled window itself carries, in the sources' own words.
 *
 * A lane that answered `failed` is provider evidence that one configured
 * connection could not be read, and it lives on the window rather than on the
 * store: the aggregate list Action *succeeded*, so `snapshot.error` — which
 * only ever holds a failure of that Action — stays absent. Reading only the
 * store error is why a window whose every source had just failed reported
 * "Up to date" beside an empty list, which is the one thing this surface must
 * never say untruthfully.
 *
 * `unavailable` is deliberately not folded in. It means the invocation never
 * settled into provider evidence at all — a configured source whose plugin is
 * not currently admitted, or a lane a pass has not reached — and calling that a
 * source failure would accuse a provider that was never asked. Coverage already
 * reports it as an unfinished walk.
 *
 * Every distinct message is kept. A reader with three broken connections needs
 * all three reasons, and each one is already a bounded single-line V1 string.
 */
function readWindowSourceFailure(window: TriageListWindowV1): string | null {
  const messages: string[] = [];
  for (const lane of window.lanes) {
    if (lane.health.kind !== 'failed') continue;
    const failure = lane.health.failure;
    const message = failure.detail ?? SOURCE_FAILURE_COPY_V1[failure.class];
    if (!messages.includes(message)) messages.push(message);
  }
  return messages.length === 0 ? null : messages.join(' ');
}

/**
 * The one honest presentation of the mounted window snapshot.
 *
 * The store already models value, freshness, pending work and a retained error
 * as four independent facts (`core/CORPUS.md` §4.4). This resolver keeps them
 * independent instead of collapsing them into a single status: a failed refresh
 * over an assembled window is a *stale window with a reason*, never an error
 * screen, because blanking the list would tell the reader that nothing needs
 * them — the one thing this surface must never say untruthfully.
 */
export type TriageListShellStateV1 =
  /** No cycle has produced a window yet. Nothing truthful can be listed. */
  | Readonly<{ kind: 'initial' }>
  /** A window exists and it names no configured source instance. */
  | Readonly<{ kind: 'configureSources' }>
  /** No window was ever assembled and the last attempt failed. */
  | Readonly<{ kind: 'unavailable'; message: string }>
  | Readonly<{
      kind: 'window';
      window: TriageListWindowV1;
      /** A refresh is in flight over rows that are already on screen. */
      refreshing: boolean;
      /** The rows are real but no longer known to be current. */
      stale: boolean;
      /** Retained beside the rows, never instead of them. */
      error: string | null;
    }>;

export function resolveTriageListShellState(
  snapshot: TriageListWindowSnapshotV1,
): TriageListShellStateV1 {
  const window = snapshot.window;
  if (window !== undefined) {
    if (snapshot.configuredSources.length === 0) return Object.freeze({ kind: 'configureSources' });
    return Object.freeze({
      kind: 'window',
      window,
      refreshing: snapshot.pending !== 'idle',
      stale: snapshot.freshness !== 'fresh',
      // The store's own failure first: it means the list could not be read at
      // all, which outranks any single connection's reason.
      error: snapshot.error?.message ?? readWindowSourceFailure(window),
    });
  }
  // Before the first completed cycle there are no configured sources to report
  // either, so "configure a source" is withheld until a pass has actually
  // looked. Claiming it earlier would accuse the user of not configuring
  // something we have not yet read.
  if (snapshot.error !== undefined) {
    return Object.freeze({ kind: 'unavailable', message: snapshot.error.message });
  }
  return Object.freeze({ kind: 'initial' });
}
