/**
 * Plugin-local GitLab triage shapes.
 *
 * These are deliberately owned by this package and named in GitLab's own vocabulary.
 * They are the single seam a later unit binds to the source contract: every field here
 * exists because a GitLab response supplies it, not because a contract field needed
 * filling. Nothing in this corridor imports a Triage schema.
 */

/** GitLab's own item vocabulary. `merge-request` is not `pull-request`. */
export const GITLAB_KIND_IDS = ['merge-request', 'issue'] as const;
export type GitlabKindId = (typeof GITLAB_KIND_IDS)[number];

/**
 * Closed failure classification. Every arm is reachable from an observed GitLab
 * response or transport outcome; there is no catch-all success.
 */
export type GitlabFailureClass =
  | 'authentication'
  | 'permission'
  | 'rateLimit'
  | 'transient'
  | 'unsupportedContract'
  | 'unknown';

export type GitlabFailure = Readonly<{
  class: GitlabFailureClass;
  /** Stable machine code. Never provider prose and never a credential. */
  code: string;
  /** Bounded non-secret explanation. */
  detail?: string;
  /**
   * Absolute epoch milliseconds derived from GitLab's own retry evidence.
   * Absent means GitLab supplied none: this client never invents one.
   */
  retryNotBeforeMs?: number;
}>;

/** Presentation projection of a native GitLab state. */
export type GitlabStatePresentation = 'active' | 'closed' | 'unknown';

export type GitlabStateProjection = Readonly<{
  presentation: GitlabStatePresentation;
  /** GitLab's own label for the state, bounded. */
  nativeLabel: string;
}>;

/**
 * The identity half. Built by exactly one builder (`identity.ts`) and consumed by
 * scan, get, detail and mutations alike, so one merge request can never acquire two
 * identities.
 */
export type GitlabEntryIdentity = Readonly<{
  kindId: GitlabKindId;
  /** `gitlab:<base64url(configured origin)>:<project id>` */
  collisionScope: string;
  /** `String(iid)` — the per-project internal id, never the instance-global id. */
  entryId: string;
}>;

/**
 * The locator half. Freely replaced on every observation and never compared for
 * identity.
 */
export type GitlabEntryLocator = Readonly<{
  /** Host plus non-default port, derived from the binding's base URL. */
  forgeHostId: string;
  /**
   * `GitlabConfiguredOrigin.normalized` — the deployment this read reached,
   * scheme and host folded and the path prefix preserved. It is the launch
   * placement join's deployment component: `forgeHostId` drops the path prefix,
   * which is a real deployment distinction on a self-managed GitLab.
   */
  deploymentBaseUrl: string;
  /** `group/subgroup/project` full path, lowercased. Nested groups keep their slashes. */
  repositoryKey: string;
  /** `group/subgroup/project!7` or `group/subgroup/project#7`. */
  displayPath: string;
  /** `repositoryKey`, verbatim. There is no payload and nothing to decode. */
  routingToken: string;
  /** Absolute provider URL, or `null` when GitLab returned a relative or unusable one. */
  webUrl: string | null;
}>;

/** Canonical involvement vocabulary. Native lane ids never appear here. */
export const GITLAB_INVOLVEMENT_FACTS = [
  'author',
  'assignee',
  'reviewRequested',
  'mentioned',
  'subscribed',
  'participating',
] as const;
export type GitlabInvolvementFact = (typeof GITLAB_INVOLVEMENT_FACTS)[number];

export type GitlabRowFactValue =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'actor'; actor: string }>
  | Readonly<{ kind: 'timestamp'; epochMs: number; display: 'relative' | 'absolute' }>
  | Readonly<{ kind: 'number'; value: number; display: 'compact' | 'plain' }>
  | Readonly<{ kind: 'status'; label: string; tone: 'success' | 'danger' | 'warning' | 'info' }>
  | Readonly<{ kind: 'detailOnly' }>;

export type GitlabRowFactImportance = 'primary' | 'secondary' | 'supplementary';

export type GitlabRowFact = Readonly<{
  id: string;
  importance: GitlabRowFactImportance;
  value: GitlabRowFactValue;
}>;

export type GitlabActor = Readonly<{
  username: string;
  displayName: string;
  avatarUrl: string | null;
}>;

export type GitlabEntrySnapshot = Readonly<{
  title: string;
  state: GitlabStateProjection;
  /** GitLab `updated_at`, parsed. Display and change evidence only. */
  sourceUpdatedAtMs: number | null;
  /**
   * The revision this read observed, and the pin a write carries back.
   *
   * A merge request carries GitLab's own `sha` — its head commit — because that
   * is the value `sources/SCM.md` §2.6 requires a merge and a mark-ready to
   * carry, and the one GitLab's merge endpoint consumes as its own `sha`
   * precondition. An issue has no head and carries GitLab's `updated_at`
   * **unparsed**, the token §4.7's issue Actions pin against.
   *
   * It is a separate member from `sourceUpdatedAtMs` on purpose. That one is a
   * clock for display and ordering; this one is an opaque token compared only for
   * equality. Reusing the parsed clock would make two spellings of one instant
   * compare equal, which is a currentness refusal silently becoming a write.
   *
   * `null` means GitLab reported none. It is never invented, shortened or
   * normalized: a shortened revision is a DIFFERENT revision.
   */
  nativeRevision: string | null;
  /** The complete merge-request review tuple, or null when GitLab supplied no exact base/head. */
  reviewRevision: Readonly<{
    baseSha: string;
    headSha: string;
    nativeRevision: string;
  }> | null;
  sourceCreatedAtMs: number | null;
  author: GitlabActor | null;
  assignees: readonly GitlabActor[];
  reviewers: readonly GitlabActor[];
  labels: readonly string[];
  /**
   * `detailed_merge_status` verbatim for a merge request. It carries more members
   * than a boolean can hold, so it is never collapsed here.
   */
  detailedMergeStatus: string | null;
  /** Present only when the row is a merge request. */
  branches: Readonly<{ source: string | null; target: string | null }> | null;
  /** GitLab's own draft flag, never parsed out of the title. */
  draft: boolean | null;
  commentCount: number | null;
}>;

export type GitlabViewerFacts = Readonly<{
  involvement: readonly GitlabInvolvementFact[];
}>;

export type GitlabMappedEntry = Readonly<{
  identity: GitlabEntryIdentity;
  locator: GitlabEntryLocator;
  snapshot: GitlabEntrySnapshot;
  viewer: GitlabViewerFacts;
  rowFacts: readonly GitlabRowFact[];
  /** True when display content was shortened or a bounded count was exceeded. */
  projectionTruncated: boolean;
}>;

/** One decoded provider row: mapped, or skipped with the reason it could not be identified. */
export type GitlabRowDecodeResult =
  | Readonly<{ kind: 'mapped'; entry: GitlabMappedEntry }>
  | Readonly<{ kind: 'undecodable'; reason: string }>;
