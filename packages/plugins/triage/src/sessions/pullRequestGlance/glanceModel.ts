import type { SessionPullRequestWatchModeV1 } from '@happier-dev/channels-protocol/v1';
import type {
  TriageConfigureSourceOfferV1,
  TriagePullRequestStatusV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';

/**
 * What the shared PR presentation (Companion glance, Git/Project card, linked-entry detail) says about one
 * linked PR. Pure projection of the one admitted Resource binding: no reads, no clocks, no second readiness
 * vocabulary. Unknown stays unknown; a stale read keeps its facts and says how old they are.
 */
/** `reading`: no status yet because its read is under way, so the words say "Reading…" rather than "not read yet". */
export type PullRequestGlanceUnknownV1 = Readonly<{ kind: 'unknown'; reading?: true }>;
export type PullRequestGlanceChecksV1 =
  | PullRequestGlanceUnknownV1
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'failing';
      count: number;
      first: string | null;
      more: number;
    }>
  | Readonly<{
      kind: 'running';
      done: number | null;
      total: number | null;
      cancelled: number;
    }>
  | Readonly<{ kind: 'passed'; count: number | null; cancelled: number }>;
export type PullRequestGlanceReviewV1 =
  | PullRequestGlanceUnknownV1
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'changesRequested' | 'approved' | 'reviewRequired';
      people: readonly string[];
    }>;
export type PullRequestGlanceMergeV1 =
  | PullRequestGlanceUnknownV1
  | Readonly<{ kind: 'merged' | 'closed' | 'draft' | 'conflicts' }>
  /** The forge states no readiness, but its checks are failing: that, never a guess at ready or blocked. */
  | Readonly<{ kind: 'checksFailing' }>
  /** `failingChecks`: mergeable although checks fail, so none of the failing ones is required. */
  | Readonly<{ kind: 'ready'; queued: boolean; autoMerge: boolean; partial?: true; failingChecks?: true }>
  /** The last successful read said it could merge, but that read is no longer current: never drawn as Ready. */
  | Readonly<{ kind: 'stale' }>
  | Readonly<{
      kind: 'blocked';
      why: 'checksAndReview' | 'checks' | 'review' | 'running' | null;
      blocker?: string;
    }>;
export type PullRequestGlanceWatchV1 =
  | Readonly<{ kind: 'off' }>
  | Readonly<{ kind: 'watching'; mode: SessionPullRequestWatchModeV1 }>
  | Readonly<{
      kind: 'fixing';
      mode: SessionPullRequestWatchModeV1;
      round: number;
      limit: number | null;
    }>
  | Readonly<{
      kind: 'exhausted';
      mode: SessionPullRequestWatchModeV1;
      rounds: number;
    }>
  | Readonly<{ kind: 'credentials'; mode: SessionPullRequestWatchModeV1 }>
  | Readonly<{
      kind: 'paused';
      mode: SessionPullRequestWatchModeV1;
      machine: string | null;
    }>
  | Readonly<{ kind: 'terminal'; terminal: 'merged' | 'closed' | null }>;
export type PullRequestGlanceFreshnessV1 =
  | Readonly<{ kind: 'current'; checkedAtMs: number }>
  | Readonly<{
      kind: 'stale';
      checkedAtMs: number;
      failure: TriageSourceFailureV1;
    }>
  | Readonly<{
      kind: 'unavailable';
      failure: TriageSourceFailureV1;
      /** The sources whose existing setup page can bring this PR's repository in; present only with that failure. */
      configureSources?: readonly TriageConfigureSourceOfferV1[];
    }>;
/** Checks · Review · Merge and head → base: the status facts every PR presentation shares. */
export type PullRequestStatusFactsV1 = Readonly<{
  branch: Readonly<{ head: string; base: string }> | null;
  checks: PullRequestGlanceChecksV1;
  review: PullRequestGlanceReviewV1;
  merge: PullRequestGlanceMergeV1;
}>;
export type PullRequestGlanceV1 = PullRequestStatusFactsV1 & Readonly<{
  number: number;
  repository: string;
  url: string;
  watch: PullRequestGlanceWatchV1;
  freshness: PullRequestGlanceFreshnessV1;
}>;

type Status = TriagePullRequestStatusV1;

function projectChecks(checks: Status['checks']): PullRequestGlanceChecksV1 {
  if (checks === null || checks.state === 'unknown') return { kind: 'unknown' };
  if (checks.state === 'none') return { kind: 'none' };
  const failingRows = checks.rows.filter((row) => row.state === 'failed');
  const failed =
    checks.failed ?? (failingRows.length > 0 ? failingRows.length : null);
  // Cancelled and skipped runs arrive as neutral rows: never a pass, never a failure.
  const cancelled = checks.rows.filter((row) => row.state === 'neutral').length;
  if (failed !== null && failed > 0) {
    return {
      kind: 'failing',
      count: failed,
      first: failingRows[0]?.name ?? null,
      more: Math.max(0, failingRows.length - 1),
    };
  }
  const pending =
    checks.pending ??
    checks.rows.filter((row) => row.state === 'pending').length;
  if (pending > 0) {
    const total = checks.total;
    return {
      kind: 'running',
      done: total === null ? null : Math.max(0, total - pending),
      total,
      cancelled,
    };
  }
  if (checks.state === 'incomplete' || checks.incomplete ||
      (checks.passed === null && checks.rows.length === 0))
    return { kind: 'unknown' };
  return { kind: 'passed', count: checks.passed, cancelled };
}

function projectReview(review: Status['review']): PullRequestGlanceReviewV1 {
  if (review === null) return { kind: 'unknown' };
  const by = (verb: 'approved' | 'changesRequested' | 'pending') =>
    review.reviewers
      .filter((person) => person.verb === verb)
      .map((person) => person.name);
  if (review.decision === 'changesRequested')
    return { kind: 'changesRequested', people: by('changesRequested') };
  if (review.decision === 'approved')
    return { kind: 'approved', people: by('approved') };
  if (review.decision === 'reviewRequired')
    return { kind: 'reviewRequired', people: by('pending') };
  // No overall decision (a repository that requires none): the reviews that were read still say where it stands,
  // the most consequential first. Comments alone are no verdict.
  if (by('changesRequested').length > 0) return { kind: 'changesRequested', people: by('changesRequested') };
  if (by('approved').length > 0) return { kind: 'approved', people: by('approved') };
  if (by('pending').length > 0) return { kind: 'reviewRequired', people: by('pending') };
  return { kind: 'none' };
}

function projectMerge(
  linkState: TriageSessionPullRequestBindingV1['link']['state'],
  status: Status | null,
  checks: PullRequestGlanceChecksV1,
): PullRequestGlanceMergeV1 {
  if (linkState === 'merged') return { kind: 'merged' };
  if (linkState === 'closed') return { kind: 'closed' };
  const merge = status?.merge;
  if (merge?.draft === true) return { kind: 'draft' };
  if (merge?.state === 'conflicts') return { kind: 'conflicts' };
  const operations = status?.operations;
  if (operations?.readiness === 'ready')
    return {
      kind: 'ready',
      queued: merge?.queue != null,
      autoMerge: merge?.autoMerge?.enabled === true,
      ...(checks.kind === 'failing' ? { failingChecks: true as const } : {}),
      ...(status?.projectionTruncated === true || status?.checks?.incomplete === true || status?.review?.incomplete === true
        ? { partial: true as const } : {}),
    };
  if (operations?.readiness !== 'blocked') return checks.kind === 'failing' ? { kind: 'checksFailing' } : { kind: 'unknown' };
  const checkBlocks = operations.unmetRequirements.some(requirement => requirement.kind === 'check');
  const reviewBlocks = operations.unmetRequirements.some(requirement => requirement.kind === 'review');
  const why =
    checkBlocks && reviewBlocks
      ? 'checksAndReview'
      : checkBlocks
        ? checks.kind === 'running' ? 'running' : 'checks'
        : reviewBlocks
          ? 'review'
          : null;
  // The source's own blocker sentence wins; the derived reason only fills in when the source gives none.
  return merge?.blocker != null
    ? { kind: 'blocked', why, blocker: merge.blocker }
    : { kind: 'blocked', why };
}

function projectWatch(
  binding: TriageSessionPullRequestBindingV1,
): PullRequestGlanceWatchV1 {
  const { watch, link } = binding;
  const mode = watch.policy.mode;
  if (watch.reason === 'terminal')
    return {
      kind: 'terminal',
      terminal:
        link.state === 'merged' || link.state === 'closed' ? link.state : null,
    };
  if (mode === 'off') return { kind: 'off' };
  if (watch.reason === 'exhausted')
    return {
      kind: 'exhausted',
      mode,
      rounds: watch.fixAttemptLimit ?? watch.roundsStarted,
    };
  if (watch.reason === 'credentials') return { kind: 'credentials', mode };
  if (watch.reason === 'paused')
    return {
      kind: 'paused',
      mode,
      machine: watch.watchingMachine?.label ?? null,
    };
  const active = watch.progress?.activeRound;
  if (active?.started === true)
    return {
      kind: 'fixing',
      mode,
      round: Math.max(1, watch.roundsStarted),
      limit: watch.fixAttemptLimit,
    };
  return { kind: 'watching', mode };
}

const READING: PullRequestGlanceUnknownV1 = Object.freeze({ kind: 'unknown', reading: true });

/**
 * The shared status facts from one admitted 06 status. `null` when it could not be read; with `reading`, when its
 * read is still under way, so every fact says "Reading…" until it lands (the one loading word on the page).
 */
export function projectPullRequestStatusFactsV1(
  value: TriagePullRequestStatusV1 | null,
  linkState?: TriageSessionPullRequestBindingV1['link']['state'],
  options: Readonly<{ reading?: boolean }> = {},
): PullRequestStatusFactsV1 {
  const reading = value === null && options.reading === true;
  const checks = reading ? READING : projectChecks(value?.checks ?? null);
  const review = reading ? READING : projectReview(value?.review ?? null);
  const merge = projectMerge(linkState, value, checks);
  return {
    branch: value?.branch?.head !== undefined && value.branch.base !== undefined
      ? { head: value.branch.head, base: value.branch.base } : null,
    checks,
    review,
    merge: reading && merge.kind === 'unknown' ? READING : merge,
  };
}

export function projectPullRequestGlanceV1(
  binding: TriageSessionPullRequestBindingV1,
): PullRequestGlanceV1 {
  const native = binding.nativeStatus;
  const facts = projectPullRequestStatusFactsV1(native.kind === 'unavailable' ? null : native.value, binding.link.state);
  return {
    ...facts,
    merge: native.kind === 'stale' && facts.merge.kind === 'ready' ? { kind: 'stale' } : facts.merge,
    number: binding.link.number,
    repository: binding.link.repository,
    url: binding.link.url,
    watch: projectWatch(binding),
    freshness:
      native.kind === 'current'
        ? { kind: 'current', checkedAtMs: native.checkedAtMs }
        : native.kind === 'stale'
          ? { kind: 'stale', checkedAtMs: native.checkedAtMs, failure: native.failure }
          : {
              kind: 'unavailable',
              failure: native.failure,
              ...(native.recovery === undefined ? {} : { configureSources: native.recovery.offers }),
            },
  };
}
