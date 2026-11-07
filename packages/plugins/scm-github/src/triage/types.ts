import type { TriageEntryStateV1, TriageSourceEntrySnapshotV1, TriageSourceViewerFactsV1, TriageTaskFieldsV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubResponseFailureClassV1, GithubResponseFailureV1 } from '../observations/githubResponseFailure.js';

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
export const GITHUB_TRIAGE_KIND_IDS_V1 =
  Object.freeze(['pull-request', 'issue', 'dependabot-alert', 'code-scanning-alert'] as const);
export type GithubTriageKindIdV1 = (typeof GITHUB_TRIAGE_KIND_IDS_V1)[number];

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

export type GithubTriagePresentationV1 = TriageEntryStateV1['presentation'];

/** Closed canonical involvement vocabulary. Native lane ids never cross this boundary. */
export type GithubTriageInvolvementV1 = TriageSourceViewerFactsV1['involvement'][number];

export type GithubTriageRowFactToneV1 = Extract<GithubTriageRowFactValueV1, { kind: 'status' }>['tone'];

export type GithubTriageRowFactImportanceV1 = GithubTriageRowFactV1['importance'];

/** The six closed row-fact value arms. `detailOnly` is answered-but-not-here, not omission. */
export type GithubTriageRowFactValueV1 = GithubTriageRowFactV1['value'];

export type GithubTriageRowFactV1 = TriageSourceEntrySnapshotV1['facts'][number];

export type GithubTriageEntryStateV1 = Readonly<{
  presentation: GithubTriagePresentationV1;
  nativeLabel: string;
  stage?: TriageEntryStateV1['stage'];
  completionReason?: TriageEntryStateV1['completionReason'];
}>;

/** The one provider read's base/head/native revision for a pull request. */
export type GithubTriageReviewRevisionV1 = Readonly<{
  baseSha: string;
  headSha: string;
  nativeRevision: string;
}>;

export type GithubTriageEntrySnapshotV1 = Readonly<{
  kindId: GithubTriageKindIdV1;
  title: string;
  scopeLabel: string;
  scopeDisplayName?: string;
  /** Who opened the entry (their login), one bounded display line; absent when GitHub names nobody. */
  authorLabel?: string;
  assigneeLabel?: string | null;
  /** The entry's number as GitHub writes it ("#2481"), one bounded display line. */
  designation?: string;
  webUrl: string | null;
  /**
   * The provider's own `owner/name` for the repository this entry belongs to.
   *
   * It is the repository's IDENTITY, not its label: `scopeLabel` above is
   * display text that the shared bounded-text owner may shorten, and a
   * shortened identity would join to the wrong checkout. `null` when it cannot
   * be emitted within the published identifier bound.
   */
  nameWithOwner: string | null;
  createdAtMs: number;
  completedAtMs?: number;
  sourceUpdatedAtMs: number;
  nativeRevision: string | null;
  /** Present only on an authoritative pull-request read with all three revisions. */
  reviewRevision?: GithubTriageReviewRevisionV1;
  state: GithubTriageEntryStateV1;
  relations?: TriageSourceEntrySnapshotV1['relations'];
  rowFacts: readonly GithubTriageRowFactV1[];
  projectionTruncated: boolean;
}>;

export type GithubTriageViewerFactsV1 = Readonly<{
  involvement: readonly GithubTriageInvolvementV1[];
  sourceAttention?: TriageSourceViewerFactsV1['sourceAttention'];
}>;

/** Closed failure classes. `permission` and `rateLimit` stay distinct on purpose. */
export type GithubTriageFailureClassV1 = GithubResponseFailureClassV1;
export type GithubTriageFailureV1 = GithubResponseFailureV1;

export type GithubTriagePresentObservationV1 = Readonly<{
  kind: 'present';
  localRef: GithubTriageEntryLocalRefV1;
  locator: GithubTriageEntryLocatorV1;
  snapshot: GithubTriageEntrySnapshotV1;
  viewer: GithubTriageViewerFactsV1;
  /** Exact-read-only values; the scan/observation mapper never copies these. */
  taskFields?: TriageTaskFieldsV1;
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

/** Complete reason vocabulary in reporting priority order. An unencodable continuation ends the walk. */
export const GITHUB_SCAN_PARTIAL_REASON_PRIORITY_V1 = Object.freeze([
  'continuation-unavailable',
  'result-ceiling',
  'incomplete-results',
  'undecodable-items',
  'lane-unresolved',
  'projection-budget',
] as const);
export type GithubTriageScanPartialReasonV1 = (typeof GITHUB_SCAN_PARTIAL_REASON_PRIORITY_V1)[number];

export const GITHUB_CHECKS_STATES_V1 = Object.freeze(['none', 'unknown', 'knownIncomplete', 'resolved'] as const);
export type GithubChecksStateV1 = (typeof GITHUB_CHECKS_STATES_V1)[number];

export const GITHUB_CHECKS_CONDITION_STATES_V1 = Object.freeze([
  'passed', 'failed', 'pending', 'neutral', 'none', 'unknown', 'superseded',
] as const);

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
    /** Walk reason or an already-classified optional Checks read failure code. */
    reason: string;
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
