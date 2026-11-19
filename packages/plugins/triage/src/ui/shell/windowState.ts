import { formatHappierAsOfTime } from '@happier-dev/plugin-ui';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_LIST_NO_FILTERS_V1, type SurfaceFilterSelectionV1, type TriageListWindowV1 } from '../../projection/listWindow.js';
import { UNREADABLE_IN_THIS_PASS_V1, type TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { TRIAGE_PR_VIEW_INVENTORY_V1, type TriageListViewInventoryV1 } from '../list/viewInventory.js';
import { planTriageViewSourceSelectionV1 } from '../filters/plan.js';
import { createTriageNameListFormatter } from './nameList.js';
import type { TriageSourceDescriptorReaderV1 } from '../detail/sourceSurface.js';
import {
  projectTriageFailedSourceHealth,
  projectTriageUnreadableSourceHealth,
  readTriageSourceDisplayName,
  projectTriageViewSourceHealthV1,
  type TriageListBodyStateV1,
  type TriageOutsideSourcesAttentionV1,
  type TriageSourceHealthV1,
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
  rateLimit: 'Asked us to slow down.',
  transient: 'Could not be reached just now.',
  unknown: 'Failed for a reason it did not name.',
  unsupportedContract: 'Answered with something Happier could not read.',
});

const LIST_READ_TIMEOUT_COPY_V1 = 'The list read did not answer in time. Try again to read it.';

/** This operation reads a list; the host's generic unknown-write copy does not describe its recovery. */
function listReadFailureMessage(code: string | undefined, message: string): string {
  return code === 'timeout' ? LIST_READ_TIMEOUT_COPY_V1 : message;
}

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
  requestId?: string;
  /**
   * The class's own sentence, present when `reason` is the provider's bounded detail. The one-line summary says
   * this; the detail, which can carry a diagnostic such as GitHub's request ID, stays in the notice Details shows.
   */
  lineReason?: string;
  retryable?: boolean;
  /** The provider's own deadline before which a read is refused (a rate limit), when it sent one. */
  retryNotBeforeMs?: number;
  /**
   * Present only for an invocation the host could not make (an offline Machine, a broken transport): its typed
   * code and the reason together. Connections that all carry one key failed for one cause, which is said once.
   */
  sharedCauseKey?: string;
  /** Whether the connection's owner has to change something (sign in, allow it, install it) before a read can work. */
  needsConnectionChange?: boolean;
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
      /** Selected-source body facts; the original window retains whole-scan data for detail and management. */
      body: TriageListBodyStateV1;
      wholeScanFailure: TriageListShellFailureV1 | null;
      /** Typed handoff for the existing status-line owner; opens Manage sources. */
      outsideSourcesAttention: TriageOutsideSourcesAttentionV1 | null;
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
/**
 * One failed connection as every Triage surface names it: the page's line and the Composer picker read the same
 * projection, so the two cannot describe one failure differently.
 */
export function projectTriageSourceHealthFailureV1(entry: TriageSourceHealthV1): TriageListSourceFailureV1 {
  const { failure } = entry;
  return Object.freeze({
    sourceInstanceId: entry.sourceInstance.sourceInstanceId, displayName: entry.displayName,
    reason: listReadFailureMessage(failure.code, failure.detail ?? SOURCE_FAILURE_COPY_V1[failure.class]),
    code: failure.code,
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
    ...(failure.retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs: failure.retryNotBeforeMs }),
    ...(failure.detail === undefined ? {} : { lineReason: listReadFailureMessage(failure.code, SOURCE_FAILURE_COPY_V1[failure.class]) }),
    needsConnectionChange: failure.class === 'authentication' || failure.class === 'permission',
  });
}

/**
 * Every connection the reader should know could not be read, from the one join the page and the Composer
 * picker share: failed lanes, connections the pass could not read, and configured ones that are unavailable.
 */
export function readTriageListSourceFailuresV1(snapshot: TriageListWindowSnapshotV1): readonly TriageListSourceFailureV1[] {
  return readShellFailure(snapshot)?.sources ?? NO_SOURCE_FAILURES_V1;
}
const NO_SOURCE_FAILURES_V1: readonly TriageListSourceFailureV1[] = Object.freeze([]);

function readShellFailure(snapshot: TriageListWindowSnapshotV1): TriageListShellFailureV1 | null {
  const unavailableSourceIds = new Set(snapshot.configuredSources
    .filter((source) => !source.available).map((source) => source.sourceInstanceId));
  // Every distinct connection is kept. A reader with three broken ones needs
  // all three names, not the first.
  const sources: TriageListSourceFailureV1[] = projectTriageFailedSourceHealth(snapshot)
    .map(projectTriageSourceHealthFailureV1);
  // A connection the pass could not read at all is the same kind of fact as one
  // that failed with provider evidence — one named connection the reader can go
  // and look at. Only the reason differs, and neither is the aggregate read.
  // A host's classified refusal leads with its own sentence, because it can name what the shell cannot: the
  // Machine it could not reach ("…unavailable on MacBook Pro. Reconnect it…"). The store's sentence for a pass
  // that never reached the connection, and an unclassified exception's text, are diagnostics, not reader copy;
  // the reader is told the shell's translated reason instead.
  for (const entry of projectTriageUnreadableSourceHealth(snapshot)) {
    // `plugin_action_failed` is the store's code for an exception no host classified.
    const hostWorded = entry.code !== undefined && entry.code !== 'plugin_action_failed'
      && entry.reason !== UNREADABLE_IN_THIS_PASS_V1.message;
    const reason = (hostWorded ? readHostSentence(listReadFailureMessage(entry.code, entry.reason)) : undefined) ?? SOURCE_FAILURE_COPY_V1.transient;
    sources.push(Object.freeze({
      sourceInstanceId: entry.sourceInstance.sourceInstanceId,
      displayName: entry.displayName,
      reason,
      ...(entry.code === undefined ? {} : { code: entry.code }),
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.retryable === undefined ? {} : { retryable: entry.retryable }),
      sharedCauseKey: `${entry.code ?? ''}\n${entry.retryable ?? ''}\n${reason}`,
      needsConnectionChange: entry.retryable === false && entry.code !== 'timeout',
    }));
  }
  // Configuration admission, not the presence of a coverage lane, establishes
  // which contributions cannot be asked. Name that state once, superseding any
  // retained read failure from before admission was lost, keeping its diagnostic.
  // An available lane
  // the pass has not reached is still only unfinished coverage.
  const failureIndexBySource = new Map(sources.map((source, index) => [source.sourceInstanceId, index]));
  for (const configured of snapshot.configuredSources) {
    if (!unavailableSourceIds.has(configured.sourceInstanceId)) continue;
    const sourceInstance = {
      source: configured.source,
      sourceInstanceId: configured.sourceInstanceId,
    };
    const existingIndex = failureIndexBySource.get(configured.sourceInstanceId);
    const existing = configured.availabilityFailure === undefined
      ? existingIndex === undefined ? undefined : sources[existingIndex]
      : projectTriageSourceHealthFailureV1({ sourceInstance, displayName: readTriageSourceDisplayName(snapshot, sourceInstance),
        failure: configured.availabilityFailure });
    if (existing !== undefined) {
      const unavailable = Object.freeze({ ...existing,
        lineReason: SOURCE_UNAVAILABLE_COPY_V1, needsConnectionChange: true });
      if (existingIndex === undefined) sources.push(unavailable);
      else sources[existingIndex] = unavailable;
      continue;
    }
    sources.push(Object.freeze({
      sourceInstanceId: configured.sourceInstanceId,
      displayName: readTriageSourceDisplayName(snapshot, sourceInstance),
      reason: SOURCE_UNAVAILABLE_COPY_V1,
      needsConnectionChange: true,
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
const SOURCE_UNAVAILABLE_COPY_V1 = 'Not installed or enabled on this machine.';
const SOURCE_UNAVAILABLE_TRANSLATION_KEY_V1 = 'plugins.triage.surface.sourceUnavailable';

/** The one sentence for a source that is not installed or enabled, as its translation key and English fallback. */
export const TRIAGE_SOURCE_UNAVAILABLE_COPY_V1: Readonly<{ key: string; fallback: string }> = Object.freeze({
  key: SOURCE_UNAVAILABLE_TRANSLATION_KEY_V1,
  fallback: SOURCE_UNAVAILABLE_COPY_V1,
});

/** The one sentence for a failure class, as its translation key and English fallback. */
export function readTriageSourceFailureCopyV1(
  failureClass: TriageSourceFailureV1['class'],
): Readonly<{ key: string; fallback: string }> {
  return { key: SOURCE_FAILURE_TRANSLATION_KEYS_V1[failureClass], fallback: SOURCE_FAILURE_COPY_V1[failureClass] };
}

function resolveSourceFailureReason(
  text: TriageTextResolverV1,
  reason: string,
): string {
  if (reason === LIST_READ_TIMEOUT_COPY_V1) {
    return text('plugins.triage.surface.failure.readTimeout', reason);
  }
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
    : withRetryAt(resolveSourceFailureReason(text, source.reason), source, text, locale);
  const details = failure.sources.flatMap((source) => source.code === undefined ? [] : [
    `${source.displayName} — ${readSourceFailureDetails(source, text)}`,
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

/** A source that sent its own deadline says when it may be read again, in the pacing notice's words. */
function withRetryAt(reason: string, source: Pick<TriageListSourceFailureV1, 'retryNotBeforeMs'>, text: TriageTextResolverV1, locale?: string): string {
  if (source.retryNotBeforeMs === undefined) return reason;
  return `${reason} ${readRetryAtSentence(text, locale ?? 'en', source.retryNotBeforeMs)}`;
}

/** The one deadline a shared throttle reason can name: the latest, and only when every source sent one. */
function latestRetryDeadline(sources: readonly TriageListSourceFailureV1[]): Pick<TriageListSourceFailureV1, 'retryNotBeforeMs'> {
  const deadlines = sources.map((source) => source.retryNotBeforeMs);
  return deadlines.every((ms): ms is number => ms !== undefined) && deadlines.length > 0
    ? { retryNotBeforeMs: Math.max(...deadlines) } : {};
}

/**
 * "Try again at <time>." as one translated sentence, so each locale places the time and punctuation itself. The time
 * is the clock every Happier time reads in: today's time alone, another day's date and time, never the year.
 */
function readRetryAtSentence(text: TriageTextResolverV1, locale: string, retryAtMs: number): string {
  const retryAt = formatHappierAsOfTime(retryAtMs, Date.now(), locale);
  return text('plugins.triage.surface.waiting.retryAtTime', 'Try again at {time}.').replace('{time}', retryAt);
}

/** Details: the producer's own explanation when the line said something shorter, then the code support can look up. */
function readSourceFailureDetails(source: TriageListSourceFailureV1, text: TriageTextResolverV1): string {
  const code = `${text('plugins.triage.surface.sources.supportCode', 'For support')}: ${source.code}${source.requestId === undefined ? '' : ` · Request ID: ${source.requestId}`}`;
  return source.lineReason === undefined ? code : `${source.reason} ${code}`;
}

/** One connection's own health, for its row in Manage sources: its reason in the line's words, and what fixes it. */
export type TriageSourceFailureRowV1 = Readonly<{
  reason: string;
  /** `retry` reads the sources again; `connection` opens the source's own repair; `null` when neither can help. */
  fix: 'retry' | 'connection' | null;
  /** The typed cause for support, shown on demand. */
  details: string | null;
}>;

export function readTriageSourceFailureRowV1(
  source: TriageListSourceFailureV1,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
  locale?: string,
): TriageSourceFailureRowV1 {
  const lineReason = source.lineReason ?? source.reason;
  const permanent = source.retryable === false;
  return Object.freeze({
    // The row's reason stands beside its ⋯, so it names Details rather than pointing below.
    reason: permanent && lineReason === SOURCE_FAILURE_COPY_V1.transient
      ? text('plugins.triage.surface.sources.permanent', 'Trying again won’t fix this. Details has what support needs.')
      : withRetryAt(resolveSourceFailureReason(text, lineReason), source, text, locale),
    fix: source.needsConnectionChange === true ? 'connection' : permanent ? null : 'retry',
    details: source.code === undefined ? null
      : readSourceFailureDetails(source, text),
  });
}

/**
 * The one line a failure takes beside listed rows: who could not be read, why when one reason covers them all, and
 * the one press that can help. Each connection's own reason and diagnostic wait in Manage sources, so the rows lead.
 */
export type TriageListFailureLineV1 = Readonly<{ label: string; recovery: 'retry' | 'manageSources' }>;

export function readTriageListFailureLine(
  failure: TriageListShellFailureV1,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
  locale?: string,
): TriageListFailureLineV1 {
  const names = createTriageNameListFormatter(locale)(failure.sources.map((source) => source.displayName));
  const first = failure.sources[0];
  const lineReason = (source: TriageListSourceFailureV1) => source.lineReason ?? source.reason;
  const oneReason = first !== undefined && failure.sources.every((source) => lineReason(source) === lineReason(first))
    && !(first.retryable === false && lineReason(first) === SOURCE_FAILURE_COPY_V1.transient);
  // "Could not be reached" and "could not be read" say one thing: the shared transient reason becomes the verb.
  const unreachable = oneReason && lineReason(first!) === SOURCE_FAILURE_COPY_V1.transient;
  const title = `${names} ${unreachable
    ? text('plugins.triage.surface.failure.unreachableSuffix', 'could not be reached')
    : text('plugins.triage.surface.failure.suffix', 'could not be read')}`;
  return Object.freeze({
    label: `${title}. ${text('plugins.triage.surface.failure.retained', 'Their entries may be missing or out of date.')}${oneReason && !unreachable ? ` ${withRetryAt(resolveSourceFailureReason(text, lineReason(first!)), latestRetryDeadline(failure.sources), text, locale)}` : ''}`,
    recovery: failure.sources.every((source) => source.needsConnectionChange === true) ? 'manageSources' : 'retry',
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
      ? resolveSourceFailureReason(text, reason)
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
 * The source states when it may be read again. The keys are the ones the
 * Composer picker already renders, so both surfaces say the same words about
 * the same coordinator decision.
 */
const PACING_REASON_COPY_V1: Readonly<Record<TriageRefreshPacingReasonV1, Readonly<{
  key: string;
  fallback: string;
}>>> = Object.freeze({
  sourceRetryDeadline: Object.freeze({
    key: 'plugins.triage.surface.waiting.source',
    fallback: 'A source asked us to wait before reading it again.',
  }),
});

export function readTriageRefreshPacingNotice(
  reason: TriageRefreshPacingReasonV1,
  nextEligibleAtMs: number,
  locale: string,
  text: TriageTextResolverV1 = ENGLISH_TEXT,
): TriageListFailureNoticeV1 {
  const copy = PACING_REASON_COPY_V1[reason];
  return Object.freeze({
    title: text('plugins.triage.surface.waiting', 'Waiting before the next read'),
    description: `${text(copy.key, copy.fallback)} ${readRetryAtSentence(text, locale, nextEligibleAtMs)}`,
  });
}

/**
 * Whether the host already speaks for this mount's outage: while its Run on Machine cannot answer, the host's band
 * (offline, source unavailable, or Connecting) is the one voice for that cause. Every Triage surface (the page, the
 * Home glances) reads this one rule and steps its own failure line, Refreshing and loading rows aside instead of
 * repeating the cause a second way.
 */
export function readTriageHostOutageV1(context: Readonly<{ machineExecutionReady?: boolean; machineConnectionPending?: boolean }>): Readonly<{
  /** The host's band names the cause; the surface's own failure words step aside. */
  speaks: boolean;
  /** Nothing will load until the Machine answers and the host is not connecting to it: no loading rows promise it. */
  settled: boolean;
}> {
  const speaks = context.machineExecutionReady === false;
  return { speaks, settled: speaks && context.machineConnectionPending !== true };
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
    /** The built-in Account task source serves Tasks, not PRs & Issues. */
    tasks?: boolean;
    filters?: SurfaceFilterSelectionV1;
    inventory?: TriageListViewInventoryV1;
    /**
     * The admitted source vocabulary. A source whose descriptor declares an Account-data instance is set up for
     * everyone (Reviews, Happier exceptions), so on the PRs & Issues page it keeps the first run while it lists
     * nothing (QB-63). Without it every configured source counts as one the person chose.
     */
    readSourceDescriptor?: TriageSourceDescriptorReaderV1;
  }> = {},
): TriageListShellStateV1 {
  const window = snapshot.window;
  if (window !== undefined) {
    const personConfigured = (source: TriageListWindowSnapshotV1['configuredSources'][number]) =>
      options.readSourceDescriptor?.(source.source)?.accountDataInstance === undefined;
    if (!snapshot.configuredSources.some(source => options.tasks === true
      || TRIAGE_PR_VIEW_INVENTORY_V1.includesSource(source.source) && (window.rows.length > 0 || personConfigured(source)))) {
      return Object.freeze({ kind: 'configureSources' });
    }
    const stale = snapshot.freshness !== 'fresh';
    const wholeScanFailure = readShellFailure(snapshot);
    const viewHealth = projectTriageViewSourceHealthV1(snapshot,
      planTriageViewSourceSelectionV1(options.filters ?? TRIAGE_LIST_NO_FILTERS_V1,
        options.inventory ?? (options.tasks === true
          ? { includesSource: () => true, includesKind: () => true } : TRIAGE_PR_VIEW_INVENTORY_V1)),
      wholeScanFailure?.sources ?? []);
    const failure = viewHealth.selectedFailures.length === 0 ? null
      : Object.freeze({ kind: 'sources' as const, sources: viewHealth.selectedFailures });
    return Object.freeze({
      kind: 'window',
      window,
      refreshing: snapshot.pending !== 'idle',
      stale,
      showReadWarning: viewHealth.showReadWarning,
      failure,
      body: viewHealth.body,
      wholeScanFailure,
      outsideSourcesAttention: viewHealth.outsideSourcesAttention,
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
      message: listReadFailureMessage(snapshot.error.code, snapshot.error.message),
      retryable: snapshot.error.retryable !== false,
      ...(snapshot.error.detail === undefined ? {} : { detail: snapshot.error.detail }),
    });
  }
  return Object.freeze({ kind: 'initial' });
}
