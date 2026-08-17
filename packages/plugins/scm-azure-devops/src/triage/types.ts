import type {
  ConnectedAccountMaterialization,
  ConnectedAccountMaterializationRequest,
  QualifiedConnectedAccountRef,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type { AzureDevOpsResource } from './apiVersions.js';

/* -------------------------------------------------------------------------- */
/* Origin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The normalized explicitly configured Azure DevOps service organization base or
 * Azure DevOps Server collection base.
 *
 * The base is normalized, never rewritten: scheme and host are lowercased and a default
 * port is dropped, but the path is preserved byte-for-byte because an Azure DevOps Server
 * collection path is case-significant and two differently-cased paths are two deployments.
 */
export type AzureDevOpsOrigin = Readonly<{
  /** Normalized configured base with no trailing slash. Identity, and the scope component. */
  baseUrl: string;
  /** `https://host[:port]` — the exact origin passed to Connected Accounts materialization. */
  requestOrigin: string;
  /** Normalized host including a non-default port. Display/routing only, never identity. */
  forgeHostId: string;
  /**
   * The final configured path segment — the organization on Azure DevOps Services or the
   * collection on Server. Display label only: names are mutable and old names keep resolving.
   */
  organizationOrCollection: string | null;
}>;

export type AzureDevOpsOriginRejectionReason =
  | 'invalid_url'
  | 'insecure_scheme'
  | 'unsupported_url_form';

export type AzureDevOpsOriginResult =
  | Readonly<{ ok: true; origin: AzureDevOpsOrigin }>
  | Readonly<{ ok: false; reason: AzureDevOpsOriginRejectionReason }>;

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of Azure DevOps resources this source addresses. Route construction is
 * the only place API paths exist, and every construction carries its pinned api-version.
 */
export type AzureDevOpsRoute =
  | Readonly<{ resource: Extract<AzureDevOpsResource, 'connectionData'> }>
  | Readonly<{ resource: Extract<AzureDevOpsResource, 'projects'> }>
  | Readonly<{ resource: Extract<AzureDevOpsResource, 'repositories'>; project: string }>
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'pullRequests'>;
    project: string;
    repositoryId: string;
  }>
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'pullRequest'>;
    /**
     * Optional, deliberately. The Git area addresses a repository by its immutable GUID with no
     * project segment, which is the only route an authoritative `get` can build: its input is a
     * local ref plus the configured instance, and neither carries a project name.
     */
    project?: string;
    repositoryId: string;
    pullRequestId: number;
  }>
  /**
   * The pull request's iteration list. Every push to the source branch produces one, and it is
   * the resource `Files` and `Activity` both read through — once, from the detail root.
   */
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'iterations'>;
    repositoryId: string;
    pullRequestId: number;
  }>
  /**
   * One iteration's changed files.
   *
   * `iterationId` is a REAL 1-based iteration. `0` is the documented `compareTo` baseline and
   * appears only as a query parameter — path-addressing iteration `0` asks for a resource that
   * does not exist.
   */
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'iterationChanges'>;
    repositoryId: string;
    pullRequestId: number;
    iterationId: number;
  }>
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'commits'>;
    repositoryId: string;
    pullRequestId: number;
  }>
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'threads'>;
    repositoryId: string;
    pullRequestId: number;
  }>
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'statuses'>;
    repositoryId: string;
    pullRequestId: number;
  }>
  /**
   * Policy evaluations are a PROJECT-scoped resource, not a Git one: they are addressed under
   * the project and select the pull request through an `artifactId`. That organization-path
   * scoping is Azure's own shape and is not flattened into the Git route family.
   */
  | Readonly<{
    resource: Extract<AzureDevOpsResource, 'policyEvaluations'>;
    project: string;
  }>;

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Provider-native rate-limit evidence, exactly as Azure DevOps returned it. This carries no
 * absolute deadline: only the mapping using the injected clock turns it into one.
 */
export type AzureDevOpsRateLimitEvidence = Readonly<{
  /** `Retry-After` expressed as delta-seconds. */
  retryAfterSeconds: number | null;
  /** `Retry-After` expressed as an HTTP-date, already absolute. */
  retryAfterAtEpochMs: number | null;
  /** `X-RateLimit-Reset` — Unix epoch **seconds**. */
  resetEpochSeconds: number | null;
  /** Diagnostic only. Never authorizes a wait or a persisted limiter. */
  remaining: number | null;
  /** Diagnostic only. */
  limit: number | null;
  /** `X-RateLimit-Delay` — seconds the provider already delayed this response. Diagnostic. */
  delaySeconds: number | null;
  /** `X-RateLimit-Resource` — diagnostic label for the throttled resource. */
  resource: string | null;
}>;

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

export type AzureDevOpsFailureClass =
  | 'rateLimit'
  | 'unauthorized'
  | 'forbidden'
  /** Azure documents 404 as nonexistent **or** not permitted to view; the two are not separable. */
  | 'notFoundOrForbidden'
  | 'invalidRequest'
  | 'conflict'
  | 'server'
  | 'transport'
  | 'cancelled'
  | 'unexpectedRedirect'
  | 'malformedResponse';

export type AzureDevOpsFailure = Readonly<{
  class: AzureDevOpsFailureClass;
  status: number | null;
  /** Bounded, non-secret provider detail. Never carries a credential or a full body. */
  detail: string;
  /** Azure's `typeKey`, e.g. `GitRepositoryNotFoundException`, when the body supplied one. */
  typeKey: string | null;
  /** Absolute epoch milliseconds, present only when provider evidence supplied a delay. */
  retryNotBeforeMs: number | null;
  rateLimit: AzureDevOpsRateLimitEvidence | null;
}>;

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export type AzureDevOpsHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type AzureDevOpsHttpRequest = Readonly<{
  url: string;
  method: AzureDevOpsHttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
}>;

export type AzureDevOpsHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}>;

/** The one genuine system boundary this client mocks in tests. */
export type AzureDevOpsHttpTransport = (
  request: AzureDevOpsHttpRequest,
) => Promise<AzureDevOpsHttpResponse>;

export type AzureDevOpsAuthorization = Readonly<{
  /** Materialized once per invocation, consumed inside it, never cached or persisted. */
  headers: Readonly<Record<string, string>>;
}>;

export type AzureDevOpsClientDependencies = Readonly<{
  origin: AzureDevOpsOrigin;
  authorization: AzureDevOpsAuthorization;
  transport: AzureDevOpsHttpTransport;
  /** Injected clock. The invocation adapter is the one place a host clock is read. */
  now: () => number;
}>;

export type AzureDevOpsRequestResult =
  | Readonly<{
    ok: true;
    status: number;
    headers: Readonly<Record<string, string>>;
    body: unknown;
  }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzureDevOpsApiClient = Readonly<{
  origin: AzureDevOpsOrigin;
  request(input: Readonly<{
    route: AzureDevOpsRoute;
    query?: Readonly<Record<string, string | number | undefined>>;
    method?: AzureDevOpsHttpMethod;
    body?: unknown;
    signal: AbortSignal;
  }>): Promise<AzureDevOpsRequestResult>;
}>;

/* -------------------------------------------------------------------------- */
/* Connected Accounts seam                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The exact-account listing/materialization slice of the host Connected Accounts service that a
 * Triage source uses. The real `ConnectedAccountsService` satisfies it structurally.
 */
export type AzureDevOpsListedAccountMaterializer = Readonly<{
  materializeListedAccount(
    request: Readonly<{
      purpose: string;
      account: QualifiedConnectedAccountRef;
      materialization: ConnectedAccountMaterializationRequest;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ConnectedAccountMaterialization>;
}>;

export type AzureDevOpsAuthorizationResult =
  | Readonly<{ ok: true; authorization: AzureDevOpsAuthorization }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

/* -------------------------------------------------------------------------- */
/* Decoded provider rows                                                       */
/* -------------------------------------------------------------------------- */

export type AzureProjectRow = Readonly<{
  /** `TeamProjectReference.id` — GUID. Identity. */
  id: string;
  /** Mutable display name. Addresses the API, renders the row, never enters a scope. */
  name: string;
  state: string | null;
}>;

export type AzureRepositoryRow = Readonly<{
  /** `GitRepository.id` — GUID. The only repository identity. */
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  defaultBranch: string | null;
  isDisabled: boolean;
  webUrl: string | null;
}>;

export type AzureIdentityRow = Readonly<{
  id: string;
  displayName: string | null;
  uniqueName: string | null;
}>;

export type AzureReviewerRow = AzureIdentityRow & Readonly<{
  /** -10 rejected, -5 waiting for author, 0 no vote, 5 approved with suggestions, 10 approved. */
  vote: number;
  isRequired: boolean;
  hasDeclined: boolean;
}>;

export type AzurePullRequestStatus = 'active' | 'completed' | 'abandoned' | 'notSet' | 'all';

export type AzurePullRequestMergeStatus =
  | 'notSet'
  | 'queued'
  | 'conflicts'
  | 'succeeded'
  | 'rejectedByPolicy'
  | 'failure';

export type AzurePullRequestRow = Readonly<{
  pullRequestId: number;
  repositoryId: string;
  title: string;
  description: string | null;
  status: AzurePullRequestStatus;
  isDraft: boolean;
  createdBy: AzureIdentityRow | null;
  creationDate: string | null;
  closedDate: string | null;
  sourceRefName: string | null;
  targetRefName: string | null;
  mergeStatus: AzurePullRequestMergeStatus | null;
  mergeFailureType: string | null;
  mergeFailureMessage: string | null;
  lastMergeSourceCommitId: string | null;
  lastMergeTargetCommitId: string | null;
  lastMergeCommitId: string | null;
  reviewers: readonly AzureReviewerRow[];
  labels: readonly string[];
  supportsIterations: boolean;
  /** Set when auto-complete is enabled: completion can then fire outside our request. */
  autoCompleteSetBy: AzureIdentityRow | null;
  hasStoredCompletionOptions: boolean;
  url: string | null;
}>;

export type AzureConnectionData = Readonly<{
  /** The authenticated identity GUID — the viewer for `creatorId` / `reviewerId` lanes. */
  authenticatedUserId: string;
  authenticatedUserDisplayName: string | null;
  /** Observed deployment, read from the provider. Never inferred from the hostname. */
  deploymentType: string | null;
  instanceId: string | null;
}>;

/* -------------------------------------------------------------------------- */
/* Internal mapped shapes (this package's own vocabulary)                      */
/* -------------------------------------------------------------------------- */

/** Azure ships pull requests only. Work Items are a separate product domain. */
export type AzureEntryKindId = 'pull-request';

export type AzurePresentationState = 'active' | 'closed';

export type AzureInvolvementLaneId = 'authored' | 'reviewer';

/** Canonical involvement vocabulary this source resolves its native lanes into. */
export type AzureInvolvement = 'author' | 'reviewRequested' | 'participating';

export type AzureEntryLocator = Readonly<{
  forgeHostId: string;
  /** `organization/project/repo`, case preserved. Addresses the API and renders the row. */
  repositoryKey: string;
  organizationOrCollection: string | null;
  projectId: string;
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  webUrl: string | null;
}>;

export type AzureRowFact =
  | Readonly<{ kind: 'reviewerVote'; reviewerId: string; vote: number; nativeLabel: string }>
  | Readonly<{ kind: 'mergeStatus'; value: AzurePullRequestMergeStatus; nativeLabel: string }>
  | Readonly<{ kind: 'draft' }>
  | Readonly<{ kind: 'autoCompleteEnabled'; enabledById: string }>
  | Readonly<{ kind: 'label'; value: string }>;

export type AzurePullRequestEntry = Readonly<{
  kindId: AzureEntryKindId;
  /** `azure-devops:<base64url(normalized base)>:<repository GUID>` — no account, no name. */
  collisionScope: string;
  /** `String(pullRequestId)`. */
  entryId: string;
  locator: AzureEntryLocator;
  title: string;
  state: AzurePullRequestStatus;
  presentation: AzurePresentationState;
  nativeLabel: string;
  isDraft: boolean;
  authorId: string | null;
  authorDisplayName: string | null;
  createdAt: string | null;
  closedAt: string | null;
  sourceRefName: string | null;
  targetRefName: string | null;
  /** Produced at read, carried to a later write as the observed revision. */
  headCommitId: string | null;
  baseCommitId: string | null;
  mergeStatus: AzurePullRequestMergeStatus | null;
  involvement: AzureInvolvement;
  facts: readonly AzureRowFact[];
  /** True when display text or fact/label counts were shortened. The entry stays visible. */
  projectionTruncated: boolean;
}>;

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

export type AzureProjectPage =
  | Readonly<{
    ok: true;
    projects: readonly AzureProjectRow[];
    rawCardinality: number;
    undecodable: number;
    /** Response-issued `x-ms-continuationtoken`. Never guessed, never incremented. */
    continuationToken: string | null;
  }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzureRepositoryFrontierResult =
  | Readonly<{
    ok: true;
    /** Sorted by immutable GUID and sliced strictly after the supplied frontier. */
    repositories: readonly AzureRepositoryRow[];
    rawCardinality: number;
    undecodable: number;
  }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzurePullRequestLanePage =
  | Readonly<{
    ok: true;
    rows: readonly AzurePullRequestRow[];
    /** Raw `value.length` before decoding — the only legal `$skip` advance. */
    rawCardinality: number;
    undecodable: number;
    /** A short page ends the lane. */
    ended: boolean;
  }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzureLaneFrontier = Readonly<{
  laneId: AzureInvolvementLaneId;
  skip: number;
  ended: boolean;
}>;

/**
 * The walk-level caveats that outlive the page that observed them.
 *
 * `sources/SCM.md` §2.8b makes this a closed vocabulary in a fixed precedence order, and §6.5
 * names the members Azure can emit. Azure needs the carrier more literally than any other forge:
 * `lanes` describes only the repository being walked now, so once the frontier advances past a
 * repository whose lane offset-paged, this set is the only record that the walk paged at all.
 *
 * `projection-budget`, `continuation-unavailable` and cancellation are deliberately **not** here.
 * They describe the one call that emits them — the first is resolved by the very continuation
 * that carries this set forward, and the other two end the walk where they appear.
 */
export const AZURE_SCAN_STICKY_REASONS = [
  'undecodable-items',
  'lane-unresolved',
  'lane-unavailable',
  'repository-enumeration-incomplete',
  'offset-paging',
] as const;
export type AzureScanStickyReason = (typeof AZURE_SCAN_STICKY_REASONS)[number];

/**
 * Function-local paging state for exactly one bounded scan invocation. It is never
 * persisted, shared, or resumed after interruption, and holds no credential and no delivered ids;
 * it is encoded only into this source's own opaque continuation during the active refresh.
 */
export type AzureScanFrontier = {
  readonly scanLimit: number;
  /** Fixed for the whole invocation. Shrinking it mid-walk corrupts the provider offset. */
  readonly nativePageSize: number;
  projectId: string | null;
  projectNextToken: string | null;
  lastCompletedRepositoryId: string | null;
  currentRepositoryId: string | null;
  /** The round-robin rotation position over `lanes`; §2.8b's fairness rule reads and writes it. */
  nextLaneIndex: number;
  lanes: readonly AzureLaneFrontier[];
  /** §2.8b's sticky reason set — the only walk-level fact this frontier carries. */
  walkHealth: readonly AzureScanStickyReason[];
  observed: number;
};
