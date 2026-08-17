/**
 * GitHub-local Triage shapes.
 *
 * These are this plugin's OWN types. They deliberately mirror the source-contract
 * vocabulary (arm names, field names, bounds) so that binding them to the published
 * source ABI is a mechanical rename at one seam — `triage/contribution.ts` — once that
 * package exists. Nothing outside this folder consumes them, and no module here reaches
 * for a Triage host import.
 */

/** GitHub's own kind vocabulary. Never flattened into another forge's spelling. */
export type GithubTriageKindIdV1 = 'pull-request' | 'issue';

/**
 * Identity. `collisionScope` is `github:<repository.id>` and `entryId` is the native
 * item number. Built in exactly one place (`triage/identity.ts`).
 */
export type GithubTriageEntryLocalRefV1 = Readonly<{
  kindId: GithubTriageKindIdV1;
  collisionScope: string;
  entryId: string;
}>;

/**
 * Locator. Freely replaced by any newer observation and never compared for identity.
 * `routingToken` is the repository key (`owner/name`, lowercased) verbatim — there is
 * no envelope, no version arm, and nothing to decode.
 */
export type GithubTriageEntryLocatorV1 = Readonly<{
  routingToken: string;
  displayPath: string;
  webUrl: string | null;
}>;

export type GithubTriagePresentationV1 = 'active' | 'closed' | 'resolved' | 'unknown';

/** Closed canonical involvement vocabulary. Native lane ids never cross this boundary. */
export type GithubTriageInvolvementV1 =
  | 'author'
  | 'assignee'
  | 'reviewRequested'
  | 'mentioned'
  | 'subscribed'
  | 'participating';

export type GithubTriageRowFactToneV1 = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

export type GithubTriageRowFactImportanceV1 = 'primary' | 'secondary' | 'supplementary';

/** The six closed row-fact value arms. `detailOnly` is answered-but-not-here, not omission. */
export type GithubTriageRowFactValueV1 =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'number'; value: number; format: 'plain' | 'compact' }>
  | Readonly<{ kind: 'timestamp'; atMs: number; format: 'relative' | 'absolute' }>
  | Readonly<{ kind: 'actor'; label: string }>
  | Readonly<{ kind: 'status'; label: string; tone: GithubTriageRowFactToneV1 }>
  | Readonly<{ kind: 'detailOnly' }>;

export type GithubTriageRowFactV1 = Readonly<{
  id: string;
  importance: GithubTriageRowFactImportanceV1;
  value: GithubTriageRowFactValueV1;
}>;

export type GithubTriageEntryStateV1 = Readonly<{
  presentation: GithubTriagePresentationV1;
  nativeLabel: string;
}>;

export type GithubTriageEntrySnapshotV1 = Readonly<{
  kindId: GithubTriageKindIdV1;
  title: string;
  scopeLabel: string;
  webUrl: string | null;
  createdAtMs: number;
  sourceUpdatedAtMs: number;
  nativeRevision: string | null;
  state: GithubTriageEntryStateV1;
  rowFacts: readonly GithubTriageRowFactV1[];
  projectionTruncated: boolean;
}>;

export type GithubTriageViewerFactsV1 = Readonly<{
  involvement: readonly GithubTriageInvolvementV1[];
}>;

/** Closed failure classes. `permission` and `rateLimit` stay distinct on purpose. */
export type GithubTriageFailureClassV1 =
  | 'authentication'
  | 'permission'
  | 'rateLimit'
  | 'transient'
  | 'unsupportedContract'
  | 'unknown';

export type GithubTriageFailureV1 = Readonly<{
  class: GithubTriageFailureClassV1;
  code: string;
  /** Absolute epoch milliseconds, derived only from provider retry evidence. */
  retryNotBeforeMs?: number;
}>;

export type GithubTriagePresentObservationV1 = Readonly<{
  kind: 'present';
  localRef: GithubTriageEntryLocalRefV1;
  locator: GithubTriageEntryLocatorV1;
  snapshot: GithubTriageEntrySnapshotV1;
  viewer: GithubTriageViewerFactsV1;
}>;

export type GithubTriageObservationV1 =
  | GithubTriagePresentObservationV1
  | Readonly<{ kind: 'absent'; localRef: GithubTriageEntryLocalRefV1 }>
  | Readonly<{
    kind: 'merged';
    localRef: GithubTriageEntryLocalRefV1;
    successor: GithubTriageEntryLocalRefV1;
  }>
  | Readonly<{
    kind: 'unresolved';
    localRef: GithubTriageEntryLocalRefV1;
    failure: GithubTriageFailureV1;
  }>;

/** A scan can never conclude absence, on any evidence. */
export type GithubTriageScanObservationV1 = Exclude<
  GithubTriageObservationV1,
  Readonly<{ kind: 'absent'; localRef: GithubTriageEntryLocalRefV1 }>
>;

export type GithubTriageScanPartialReasonV1 =
  | 'result-ceiling'
  | 'incomplete-results'
  | 'undecodable-items'
  | 'lane-unresolved'
  | 'projection-budget'
  /**
   * The walk stopped with lanes still open but its own continuation bytes could not
   * be produced. Saying so is the point: a `complete` arm that quietly dropped the
   * rest of the walk would read as a finished one.
   */
  | 'continuation-unavailable';

/**
 * The walk-level reasons GitHub can establish on one page and must still report on a
 * later one. `projection-budget` is deliberately absent: it is a per-call page-shape
 * fact the continuation itself resolves. `continuation-unavailable` is absent for the
 * same kind of reason — it ends the walk in the call it appears in.
 */
export const GITHUB_SCAN_STICKY_REASONS_V1 = Object.freeze([
  'result-ceiling',
  'incomplete-results',
  'undecodable-items',
  'lane-unresolved',
] as const);

export type GithubScanStickyReasonV1 = (typeof GITHUB_SCAN_STICKY_REASONS_V1)[number];

export function readGithubScanStickyReason(value: unknown): GithubScanStickyReasonV1 | null {
  return GITHUB_SCAN_STICKY_REASONS_V1.find((reason) => reason === value) ?? null;
}

export type GithubTriageScanEvidenceV1 =
  | Readonly<{ kind: 'walkFinished' }>
  | Readonly<{
    kind: 'partial';
    reason: GithubTriageScanPartialReasonV1;
    omittedItemCount?: number;
  }>;

export type GithubTriageScanResultV1 =
  | Readonly<{
    kind: 'page';
    observations: readonly GithubTriageScanObservationV1[];
    evidence: GithubTriageScanEvidenceV1;
    /** Bounded per-lane read failures. Health-only; carries no scope or window claim. */
    laneFailures: readonly GithubTriageFailureV1[];
    /**
     * The source-private continuation bytes for THIS scan invocation. The target
     * copies them back on the next page without parsing them, and drops them on
     * cancellation, deadline, failure, or restart. They are never persisted, and
     * this source is the only parser of its own token.
     */
    continuation: string;
  }>
  | Readonly<{
    kind: 'complete';
    observations: readonly GithubTriageScanObservationV1[];
    evidence: GithubTriageScanEvidenceV1;
    laneFailures: readonly GithubTriageFailureV1[];
  }>
  | Readonly<{ kind: 'failed'; failure: GithubTriageFailureV1 }>;

/**
 * Semantic projection bounds are NOT mirrored here. `@happier-dev/triage-protocol`
 * publishes them, the strict target rejects an oversized result atomically, and a
 * second local number is exactly how a source starts emitting rows the aggregate
 * throws away whole pages for. Every projection module reads the published symbol.
 */

/** The GitHub search result ceiling, per query, regardless of `total_count`. */
export const GITHUB_SEARCH_RESULT_CEILING_V1 = 1_000;

/** GitHub's per-page maximum for both search and the check surfaces. */
export const GITHUB_MAX_PAGE_SIZE_V1 = 100;
