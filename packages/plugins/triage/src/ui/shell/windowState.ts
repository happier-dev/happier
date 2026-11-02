import {
  formatTriageTimestampV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import { UNREADABLE_IN_THIS_PASS_V1, type TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { createTriageNameListFormatter } from './nameList.js';
import {
  projectTriageFailedSourceHealth,
  projectTriageUnreadableSourceHealth,
  readTriageSourceDisplayName,
} from '../../projection/sourceHealth.js';
import {
  isTriageRefreshPacingBlockActiveV1,
  type TriageRefreshPacingReasonV1,
} from '../../refresh/refreshEligibility.js';

/**
 * Why a connection could not be read, when the source supplied no words of its
 * own.
 *
 * `class` is the published closed classification and is a machine word: showing
 * `transient` to a reader explains nothing. These are the shell's own words for
 * the same six answers, and they are only ever a fallback — a source that sent
 * bounded non-secret `detail` is quoted verbatim, because it knows which
 * repository, project or account could not be read and this file does not.
 *
 * Each one is a predicate about the connection its line already names, so none
 * of them names a subject. The sentence a reader sees is the connection's own
 * name followed by one of these.
 */
const SOURCE_FAILURE_COPY_V1: Readonly<Record<TriageSourceFailureV1['class'], string>> = Object.freeze({
  authentication: 'Needs you to sign in again.',
  permission: 'Refused this account access.',
  rateLimit: 'Asked us to slow down, so its entries may be missing.',
  transient: 'Could not be reached just now.',
  unknown: 'Failed for a reason it did not name.',
  unsupportedContract: 'Answered with something Happier could not read.',
});

const SOURCE_FAILURE_TRANSLATION_KEYS_V1: Readonly<Record<TriageSourceFailureV1['class'], string>> = Object.freeze({
  authentication: 'plugins.triage.surface.failure.authentication',
  permission: 'plugins.triage.surface.failure.permission',
  rateLimit: 'plugins.triage.surface.failure.rateLimit',
  transient: 'plugins.triage.surface.failure.transient',
  unknown: 'plugins.triage.surface.failure.unknown',
  unsupportedContract: 'plugins.triage.surface.failure.unsupportedContract',
});

/** One configured connection that could not be read, named. */
export type TriageListSourceFailureV1 = Readonly<{
  sourceInstanceId: string;
  /** The user's own name for the connection, or the qualified contribution id. */
  displayName: string;
  /** Why, in the source's own words when it sent them. */
  reason: string;
  /** Non-secret invocation diagnostic; separate from the translated reason. */
  code?: string;
  retryable?: boolean;
  /**
   * Present only for an invocation the host could not make (an offline Machine, a broken transport): its typed
   * code and the reason together. Connections that all carry one key failed for one cause, which is said once.
   */
  sharedCauseKey?: string;
}>;

/**
 * What went wrong beside the rows, and whose it is: always one or more **named
 * connections**.
 *
 * There is no anonymous arm, and that is the point. A failure rendered beside a
 * populated list was three times titled "The list could not be read" — a
 * sentence the reader can see is false, because the list is right there. The
 * aggregate list read failing is a different state entirely (`readFailed`,
 * `sourcesUnreachable` or `unavailable`), reachable only when no window was ever assembled, and
 * `projection/listWindowStore.ts` will not publish its error beside a retained
 * window. An aggregate read that fails over rows names the connections it could
 * not read, which is what `core/SURFACE.md` §6.2 row 4 asks for.
 */
export type TriageListShellFailureV1 =
  Readonly<{ kind: 'sources'; sources: readonly TriageListSourceFailureV1[] }>;

/**
 * Why no list could be assembled, as the reader needs it: whether pressing
 * Refresh can help, and a diagnostic for support behind a disclosure. The
 * message can be a host recovery sentence or the SDK's default error code;
 * the notice reader chooses human text or its localized recovery explanation.
 */
export type TriageListShellReadFailureV1 = Readonly<{
  message: string;
  retryable: boolean;
  detail?: string;
}>;

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
  /**
   * No window was ever assembled, and the reader's durable state is still
   * reachable (`core/SURFACE.md` §6.2, reachability state 5).
   *
   * This is a different answer from `unavailable`, and collapsing the two costs
   * the reader something real: their pins are Collection state, not a source
   * read, so they still page, still apply and still write while no machine can
   * be reached for the sources. A full-screen error takes that away and tells
   * them nothing is there.
   */
  | Readonly<{ kind: 'sourcesUnreachable' } & TriageListShellReadFailureV1>
  /** The list Action failed without establishing a Machine outage; pins remain available. */
  | Readonly<{ kind: 'readFailed' } & TriageListShellReadFailureV1>
  /**
   * No window was ever assembled and the reader's durable state is unreachable
   * too (`core/SURFACE.md` §6.2, reachability state 6) — the whole surface is
   * unavailable, including durable user state.
   */
  | Readonly<{ kind: 'unavailable' } & TriageListShellReadFailureV1>
  | Readonly<{
      kind: 'window';
      window: TriageListWindowV1;
      /** A refresh is in flight over rows that are already on screen. */
      refreshing: boolean;
      /** The rows are real but no longer known to be current. */
      stale: boolean;
      /** Read-health presentation only; age by itself does not request an amber warning. */
      showReadWarning: boolean;
      /** Retained beside the rows, never instead of them. */
      failure: TriageListShellFailureV1 | null;
    }>;

/**
 * Whose failure this is, decided from the facts the projection already carries.
 *
 * Every named connection is collected first, from both projections: one that
 * answered with provider evidence, and one the pass could not read at all. They
 * are the same kind of fact to a reader — a connection to go and look at — and
 * differ only in what can honestly be said about why. The store-level arm
 * survives for the failure it was written for: the aggregate list read itself
 * failing, which no single source owns.
 */
function readShellFailure(snapshot: TriageListWindowSnapshotV1): TriageListShellFailureV1 | null {
  const unavailableSourceIds = new Set(snapshot.configuredSources
    .filter((source) => !source.available).map((source) => source.sourceInstanceId));
  // Every distinct connection is kept. A reader with three broken ones needs
  // all three names, not the first.
  const sources: TriageListSourceFailureV1[] = projectTriageFailedSourceHealth(snapshot)
    .filter((entry) => !unavailableSourceIds.has(entry.sourceInstance.sourceInstanceId))
    .map((entry) => Object.freeze({
      sourceInstanceId: entry.sourceInstance.sourceInstanceId,
      displayName: entry.displayName,
      reason: entry.failure.detail ?? SOURCE_FAILURE_COPY_V1[entry.failure.class],
      code: entry.failure.code,
    }));
  // A connection the pass could not read at all is the same kind of fact as one
  // that failed with provider evidence — one named connection the reader can go
  // and look at. Only the reason differs, and neither is the aggregate read.
  // A host's classified refusal leads with its own sentence, because it can name what the shell cannot: the
  // Machine it could not reach ("…unavailable on MacBook Pro. Reconnect it…"). The store's sentence for a pass
  // that never reached the connection, and an unclassified exception's text, are diagnostics, not reader copy;
  // the reader is told the shell's translated reason instead.
  for (const entry of projectTriageUnreadableSourceHealth(snapshot)) {
    if (unavailableSourceIds.has(entry.sourceInstance.sourceInstanceId)) continue;
    // `plugin_action_failed` is the store's code for an exception no host classified.
    const hostWorded = entry.code !== undefined && entry.code !== 'plugin_action_failed'
      && entry.reason !== UNREADABLE_IN_THIS_PASS_V1.message;
    const reason = (hostWorded ? readHostSentence(entry.reason) : undefined) ?? SOURCE_FAILURE_COPY_V1.transient;
    sources.push(Object.freeze({
      sourceInstanceId: entry.sourceInstance.sourceInstanceId,
      displayName: entry.displayName,
      reason,
      ...(entry.code === undefined ? {} : { code: entry.code }),
      ...(entry.retryable === undefined ? {} : { retryable: entry.retryable }),
      sharedCauseKey: `${entry.code ?? ''}\n${entry.retryable ?? ''}\n${reason}`,
    }));
  }
  // Configuration admission, not the presence of a coverage lane, establishes
  // which contributions cannot be asked. Name that state once, superseding any
  // retained read failure from before admission was lost. An available lane
  // the pass has not reached is still only unfinished coverage.
  for (const configured of snapshot.configuredSources) {
    if (!unavailableSourceIds.has(configured.sourceInstanceId)) continue;
    const sourceInstance = {
      source: configured.source,
      sourceInstanceId: configured.sourceInstanceId,
    };
    sources.push(Object.freeze({
      sourceInstanceId: configured.sourceInstanceId,
      displayName: readTriageSourceDisplayName(snapshot, sourceInstance),
      reason: SOURCE_UNAVAILABLE_COPY_V1,
    }));
  }
  return sources.length === 0
    ? null
    : Object.freeze({ kind: 'sources', sources: Object.freeze(sources) });
}

/** What a reader is told, in one place, so the two surfaces cannot drift. */
export type TriageListFailureNoticeV1 = Readonly<{ title: string; description: string; details?: string }>;
export type TriageTextResolverV1 = (key: string, fallback?: string) => string;

const ENGLISH_TEXT: TriageTextResolverV1 = (_key, fallback = '') => fallback;

/**
 * A host recovery sentence, or `undefined` when the message is empty or only the
 * machine-readable code the SDK uses as its default message.
 */
function readHostSentence(message: string): string | undefined {
  const sentence = message.trim();
  return sentence.length > 0 && !/^[a-z][a-z0-9_.:-]*$/i.test(sentence) ? sentence : undefined;
}

/**
 * A configured connection whose contributing source is not admitted on this
 * machine — uninstalled, disabled, or declaring no kinds.
 *
 * It is kept apart from the failure classes because it is not one: no request
 * was refused, because none was made. But it is still a NAMED connection the
 * reader can act on, which is what the other two arms exist to give them.
 */
const SOURCE_UNAVAILABLE_COPY_V1 = 'This source is not installed or enabled on this machine.';
const SOURCE_UNAVAILABLE_TRANSLATION_KEY_V1 = 'plugins.triage.surface.sourceUnavailable';

function resolveSourceFailureReason(
  text: TriageTextResolverV1,
  reason: string,
): string {
  if (reason === SOURCE_UNAVAILABLE_COPY_V1) {
    return text(SOURCE_UNAVAILABLE_TRANSLATION_KEY_V1, reason);
  }
  for (const failureClass of Object.keys(SOURCE_FAILURE_COPY_V1) as TriageSourceFailureV1['class'][]) {
    if (SOURCE_FAILURE_COPY_V1[failureClass] === reason) {
      return text(SOURCE_FAILURE_TRANSLATION_KEYS_V1[failureClass], reason);
    }
  }
  return reason;
}

/**
 * One failure, as a heading and a body.
 *
 * A single broken connection is named in the heading, because that is the fact
 * the reader acts on and burying it in a body under a plural heading is how
 * attribution gets lost again. Several are listed, one line each, rather than
 * summarized into a count the reader cannot use.
 *
 * Several that failed for one shared cause (owner ruling 2026-11-02: one offline
 * Machine) are all named in the one heading and the cause is said once, instead
 * of the same sentence repeated on every line.
 */
export function readTriageListFailureNotice(
  failure: TriageListShellFailureV1,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
  locale?: string,
): TriageListFailureNoticeV1 {
  const describe = (source: TriageListSourceFailureV1) => source.retryable === false
    && source.reason === SOURCE_FAILURE_COPY_V1.transient
    ? text('plugins.triage.surface.listFailed.permanent', 'Trying again will not fix this. The details below can help support find out why.')
    : resolveSourceFailureReason(text, source.reason);
  const details = failure.sources.flatMap((source) => source.code === undefined ? [] : [
    `${source.displayName} — ${source.code}${source.retryable === undefined ? '' : ` · retryable=${source.retryable}`}`,
  ]).join('\n');
  const first = failure.sources[0];
  const sharedCause = first?.sharedCauseKey !== undefined
    && failure.sources.every((source) => source.sharedCauseKey === first.sharedCauseKey);
  if (first !== undefined && (failure.sources.length === 1 || sharedCause)) {
    const names = createTriageNameListFormatter(locale)(failure.sources.map((source) => source.displayName));
    return Object.freeze({
      title: `${names} ${text('plugins.triage.surface.failure.suffix', 'could not be read')}`,
      description: describe(first),
      ...(details.length === 0 ? {} : { details }),
    });
  }
  return Object.freeze({
    title: text('plugins.triage.surface.failure.some', 'Some sources could not be read'),
    description: failure.sources
      .map((source) => `${source.displayName} — ${describe(source)}`)
      .join('\n'),
    ...(details.length === 0 ? {} : { details }),
  });
}

/**
 * Explain the list read's classified cause while the reader's own state stays available.
 *
 * The failure's own words lead when it has them: the host may say which Machine
 * could not answer and what to do ("…unavailable on studio-mac. Reconnect it
 * or choose another machine with Run on."), which the general sentence cannot.
 */
export function readTriageListReadFailureNotice(
  state: Readonly<{ kind: 'sourcesUnreachable' | 'readFailed' } & TriageListShellReadFailureV1>,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): TriageListFailureNoticeV1 {
  const reason = readHostSentence(state.message);
  const machineUnavailable = state.kind === 'sourcesUnreachable';
  return Object.freeze({
    title: machineUnavailable
      ? text('plugins.triage.surface.sourcesUnreachable.title', 'Your sources could not be reached')
      : text('plugins.triage.surface.listFailed', 'The list could not be read'),
    // The SDK may use the machine-readable code as its default message. Keep
    // host recovery sentences, but use our translated explanation for bare codes.
    description: reason !== undefined
      ? reason
      : machineUnavailable
        ? text('plugins.triage.surface.sourcesUnreachable.description', 'Happier could not reach a machine for these sources, so nothing has been read yet. Your pins are still here, and Refresh tries again.')
        : text('plugins.triage.surface.listFailed.pinsAvailable', 'Happier could not read this list just now. Your pins are still here.'),
  });
}

/**
 * What the one **Refresh** control may currently do.
 *
 * `core/CORPUS.md` §4.2 requires the waiting health to be surfaced rather than
 * bypassed, and a press that silently does nothing is the failure it names: the
 * coordinator was already refusing, and the reader had no way to know. The
 * decision is entirely the coordinator's — the store publishes
 * `refreshBlocked`, this reads it, and nothing here re-derives a narrower answer
 * from lane health.
 */
export type TriageListRefreshV1 =
  | Readonly<{ kind: 'available' }>
  /** A pass is already in flight; it outranks the pacing of the next one. */
  | Readonly<{ kind: 'running' }>
  | Readonly<{
      kind: 'blocked';
      reason: TriageRefreshPacingReasonV1;
      nextEligibleAtMs: number;
    }>;

export function resolveTriageListRefreshV1(
  snapshot: TriageListWindowSnapshotV1,
  nowMs: number,
): TriageListRefreshV1 {
  if (snapshot.pending !== 'idle') return Object.freeze({ kind: 'running' });
  const block = snapshot.refreshBlocked;
  return isTriageRefreshPacingBlockActiveV1(block, nowMs)
    ? Object.freeze({
        kind: 'blocked',
        reason: block.reason,
        nextEligibleAtMs: block.nextEligibleAtMs,
      })
    : Object.freeze({ kind: 'available' });
}

/**
 * Why the next read is waiting, in words.
 *
 * Three refusals, three sentences: "read a moment ago", "the source asked us to
 * wait" and "the last read failed" are different things to act on, and one
 * shared sentence would hide which is happening. The keys are the ones the
 * Composer picker already renders, so both surfaces say the same words about
 * the same coordinator decision.
 */
const PACING_REASON_COPY_V1: Readonly<Record<TriageRefreshPacingReasonV1, Readonly<{
  key: string;
  fallback: string;
}>>> = Object.freeze({
  minimumInterval: Object.freeze({
    key: 'plugins.triage.surface.waiting.recent',
    fallback: 'These sources were read a moment ago.',
  }),
  sourceRetryDeadline: Object.freeze({
    key: 'plugins.triage.surface.waiting.source',
    fallback: 'A source asked us to wait before reading it again.',
  }),
  failureBackoff: Object.freeze({
    key: 'plugins.triage.surface.waiting.backoff',
    fallback: 'A source could not be read, so the next attempt waits a moment.',
  }),
});

export function readTriageRefreshPacingNotice(
  reason: TriageRefreshPacingReasonV1,
  nextEligibleAtMs: number,
  locale: string,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): TriageListFailureNoticeV1 {
  const copy = PACING_REASON_COPY_V1[reason];
  const retryAt = formatTriageTimestampV1(locale, nextEligibleAtMs, 'absolute', nextEligibleAtMs);
  return Object.freeze({
    title: text('plugins.triage.surface.waiting', 'Waiting before the next read'),
    description: `${text(copy.key, copy.fallback)} ${text('plugins.triage.surface.waiting.retryAt', 'Try again at')} ${retryAt}.`,
  });
}

export function resolveTriageListShellState(
  snapshot: TriageListWindowSnapshotV1,
  options: Readonly<{
    /**
     * Whether the reader's durable Account state — their pins — can currently
     * be read. It is the one fact that separates §6.2's two reachability
     * states, and it comes from the durable-state reader rather than from this
     * snapshot, because the aggregate list read says nothing about it.
     *
     * It defaults to `false` so a caller that cannot answer fails closed: the
     * whole-surface state promises the reader nothing, while the narrower one
     * promises that their pins still work.
     */
    durableStateReachable?: boolean;
  }> = {},
): TriageListShellStateV1 {
  const window = snapshot.window;
  if (window !== undefined) {
    if (snapshot.configuredSources.length === 0) return Object.freeze({ kind: 'configureSources' });
    const stale = snapshot.freshness !== 'fresh';
    const failure = readShellFailure(snapshot);
    return Object.freeze({
      kind: 'window',
      window,
      refreshing: snapshot.pending !== 'idle',
      stale,
      showReadWarning: failure !== null || (stale && (
        snapshot.error !== undefined
        || window.lanes.some((lane) => lane.health.kind === 'unavailable')
      )),
      failure,
    });
  }
  // Before the first completed cycle there are no configured sources to report
  // either, so "configure a source" is withheld until a pass has actually
  // looked. Claiming it earlier would accuse the user of not configuring
  // something we have not yet read.
  if (snapshot.error !== undefined) {
    const machineUnavailable = [snapshot.error.code, ...(snapshot.error.diagnostics ?? [])].some(code =>
      code === 'plugin_action_machine_required');
    return Object.freeze({
      kind: options.durableStateReachable !== true ? 'unavailable'
        : machineUnavailable ? 'sourcesUnreachable' : 'readFailed',
      message: snapshot.error.message,
      retryable: snapshot.error.retryable !== false,
      ...(snapshot.error.detail === undefined ? {} : { detail: snapshot.error.detail }),
    });
  }
  return Object.freeze({ kind: 'initial' });
}
