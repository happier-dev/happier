/**
 * Bitbucket Cloud triage vertical.
 *
 * This is the provider-facing half only: authorization through the generic Connected Accounts
 * seam, request construction, bounded pagination, rate-limit evidence, typed failures, and faithful
 * mapping of real Bitbucket Cloud responses into this package's own types. Nothing here imports a
 * cross-source contract.
 *
 * `./source/` is the other half, and the only place these shapes become public
 * `happier.triage/sources` V1 values. The split is deliberate: a provider change is read here, a
 * contract change is read there, and neither module answers to both.
 */
export {
  BITBUCKET_CLOUD_API_BASE_URL,
  BITBUCKET_CLOUD_API_ORIGIN,
  createBitbucketTriageApiClient,
  readBitbucketApiUrl,
  type BitbucketAuthorizationHeaders,
  type BitbucketJsonResponse,
  type BitbucketTriageApiClient,
} from './apiClient.js';
export {
  isBitbucketRateLimitedStatus,
  readBitbucketRateLimitTelemetry,
  readBitbucketRetryNotBeforeMs,
  type BitbucketRateLimitTelemetry,
} from './bitbucketRateLimit.js';
export {
  decodeBitbucketPullRequestRow,
  decodeBitbucketRepositoryRow,
  decodeBitbucketWorkspaceAccessRow,
  type BitbucketAccountRef,
  type BitbucketParticipantFact,
  type BitbucketPullRequestEndpoint,
  type BitbucketPullRequestEntry,
  type BitbucketPullRequestNativeState,
  type BitbucketPullRequestState,
  type BitbucketRepositoryRef,
  type BitbucketWorkspaceRef,
} from './entries.js';
export {
  classifyBitbucketHttpFailure,
  classifyBitbucketTransportFailure,
  createBitbucketFailure,
  type BitbucketFailureClass,
  type BitbucketTriageFailure,
} from './failures.js';
export {
  BITBUCKET_COLLISION_SCOPE_PREFIX,
  BITBUCKET_FORGE_HOST_ID,
  buildBitbucketCollisionScope,
  buildBitbucketRepositoryKey,
  encodeBitbucketPathSegment,
  readBitbucketBracedUuid,
  readBitbucketCollisionScopeRepositoryUuid,
  readBitbucketEntryId,
} from './identity.js';
export {
  BITBUCKET_MAX_PAGE_LENGTH,
  BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH,
  BITBUCKET_MIN_PAGE_LENGTH,
  resolveBitbucketPageGeometry,
  type BitbucketPageGeometry,
} from './pagination.js';
export {
  createBitbucketRepositoryEnumerator,
  type BitbucketRepositoryAdvance,
  type BitbucketRepositoryEnumerator,
} from './repositoryFrontier.js';
export {
  BITBUCKET_REPOSITORY_ROUTE_ID,
  BITBUCKET_WALK_HEALTH_REASONS,
  decodeBitbucketScanContinuation,
  encodeBitbucketScanContinuation,
  type BitbucketScanFrontierRecord,
  type BitbucketWalkHealthReason,
} from './scanContinuation.js';
export {
  BITBUCKET_REVIEW_LANE_FIELDS_PROJECTION,
  BITBUCKET_TRIAGE_LANE_IDS,
  buildBitbucketAuthoredLaneUrl,
  buildBitbucketPullRequestUrl,
  buildBitbucketRepositoryReviewLaneUrl,
  buildBitbucketUserWorkspacesUrl,
  buildBitbucketWorkspaceRepositoriesUrl,
  getBitbucketPullRequest,
  listBitbucketWorkspaceRepositories,
  listBitbucketWorkspaces,
  readBitbucketLaneAvailability,
  scanBitbucketPullRequests,
  withBitbucketPageLength,
  type BitbucketGetOutcome,
  type BitbucketInvolvement,
  type BitbucketLaneAvailability,
  type BitbucketLaneId,
  type BitbucketRepositoryListOutcome,
  type BitbucketScanLaneFrontier,
  type BitbucketScanWalkFrontier,
  type BitbucketScanObservation,
  type BitbucketScanOutcome,
  type BitbucketWorkspaceListOutcome,
} from './pullRequests.js';
export {
  walkBitbucketCollection,
  type BitbucketCollectionOutcome,
} from './collection.js';
export {
  decodeBitbucketConfiguration,
  encodeBitbucketConfiguration,
  readBitbucketLocalInstanceKey,
  type BitbucketConfigurationEncodeResult,
  type BitbucketConfigurationRecord,
} from './instance.js';
export {
  buildBitbucketViewerUrl,
  getBitbucketViewer,
  type BitbucketViewer,
  type BitbucketViewerOutcome,
} from './viewer.js';
