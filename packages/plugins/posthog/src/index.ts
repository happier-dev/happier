/**
 * `@happier-dev/plugins-posthog` — the PostHog Triage source vertical.
 *
 * This package owns the PostHog manifest and registration spine, the three bound source
 * operations, the Connected Account runtime, the canonical API client with its typed
 * failures and DTO parsers, origin and authentication-route validation, source identity
 * and the configured-instance codec, the bounded scan page, the CRUD-first read, and the
 * snapshot projection.
 *
 * It also owns the source-native detail body: the sampled-occurrence read behind the
 * three sampled-data tabs, the boundary projector that decides what a sampled event may
 * ever show, the tab declarations, and the React Native detail artifact itself. The
 * artifact is not re-exported here — the host mounts it through the staged UI graph the
 * manifest names, not through this daemon entrypoint.
 *
 * The selected Tier-B Composer evidence reference arrives with its own later unit.
 */

export { activate } from './activate.js';
export {
    PLUGIN_MANIFEST,
    PLUGIN_MANIFEST as manifest,
    POSTHOG_PLUGIN,
} from './manifest.js';
export {
    POSTHOG_ACTION_IDS,
    POSTHOG_API_ORIGIN_FIELD_ID,
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_DETAIL_ARTIFACT_ID,
    POSTHOG_DETAIL_FALLBACK_RENDERER_ID,
    POSTHOG_DETAIL_RENDERER_ID,
    POSTHOG_NETWORK_HOST_ACCESS_ID,
    POSTHOG_PERSONAL_API_KEY_FIELD_ID,
    POSTHOG_PERSONAL_API_KEY_MODE_ID,
    POSTHOG_PLUGIN_ID,
    POSTHOG_SOURCE_CONTRIBUTION_ID,
} from './posthogContracts.js';

export {
    POSTHOG_ACCOUNT_DIAGNOSTIC_CODES,
    posthogConnectedAccountRuntime,
} from './connect/account.js';

export {
    POSTHOG_FAILURE_CODES,
    POSTHOG_MOUNTED_DETAIL_DEADLINE_MS,
    createPosthogSampledEventsReader,
    getPosthogSourceEntry,
    listPosthogInstances,
    readPosthogSampledEvents,
    scanPosthogSource,
    toTriageSourceFailure,
} from './source/operations.js';
export type { PosthogSampledEventsReader } from './source/operations.js';

export {
    MAX_POSTHOG_SAMPLED_EVENTS_CONTINUATION_UTF8_BYTES,
    POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1,
    PosthogSampledEventsInputV1Schema,
    PosthogSampledEventsResultV1Schema,
    decodePosthogSampledEventsContinuation,
    encodePosthogSampledEventsContinuation,
} from './source/detail/issueEventsContract.js';
export type {
    PosthogSampleIncompleteV1,
    PosthogSampledEventsFrontier,
    PosthogSampledEventsInputV1,
    PosthogSampledEventsResultV1,
} from './source/detail/issueEventsContract.js';

export type { PosthogPageWalkV1 } from './source/detail/pageWalk.js';

export {
    buildPosthogIssueEventsQueryBody,
    readPosthogSampledIssueEvents,
    resolvePosthogSampledEventsLimit,
} from './source/detail/issueEvents.js';
export type {
    PosthogIssueEventsQueryBody,
    PosthogSampledEventsInput,
    PosthogSampledEventsPage,
} from './source/detail/issueEvents.js';

export {
    POSTHOG_DRAFT_WINDOW_POLICY,
    decodePosthogConfiguration,
    encodePosthogConfiguration,
    resolvePosthogWindowPolicy,
} from './source/instance.js';
export type {
    PosthogConfigurationEncoding,
    PosthogConfigurationRejection,
    PosthogConfigurationToken,
    PosthogConfiguredEnvironment,
    PosthogWindowPolicy,
} from './source/instance.js';

export { buildPosthogPresentObservation } from './source/map/observation.js';
export type { PosthogObservationInput } from './source/map/observation.js';

export { createPosthogApiClient } from './api/client.js';
export type {
    PosthogApiClient,
    PosthogApiClientDependencies,
    PosthogBodyParser,
    PosthogHeaderMaterializer,
    PosthogJsonRequest,
    PosthogMaterializationOutcome,
    PosthogMaterializationRequest,
    PosthogRequestOptions,
    PosthogResult,
    PosthogTransport,
    PosthogTransportRequest,
} from './api/client.js';

export {
    classifyPosthogResponseStatus,
    isPosthogRateLimitFailure,
    parseRetryAfterMs,
} from './api/errors.js';
export type { PosthogFailure } from './api/errors.js';

export {
    errorTrackingIssueCrudPath,
    errorTrackingIssueEventsQueryPath,
    errorTrackingIssueQueryPath,
    errorTrackingIssuesQueryPath,
    organizationProjectsPath,
    organizationsListPath,
    resolvePosthogTeamRouteId,
} from './api/paths.js';
export type { PosthogTeamRouteId } from './api/paths.js';

export {
    parsePosthogDirectoryPage,
    parsePosthogEnvironmentRow,
    parsePosthogOrganizationRow,
    parsePosthogPaginatedEnvelope,
} from './api/types/directory.js';
export type {
    PosthogDirectoryPage,
    PosthogEnvironmentRow,
    PosthogOrganizationRow,
} from './api/types/directory.js';

export {
    POSTHOG_ISSUE_EVENTS_INCLUDE,
    POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
    parsePosthogIssueEventsEnvelope,
} from './api/types/events.js';
export type {
    PosthogIssueEventsEnvelope,
    PosthogRawIssueEvent,
} from './api/types/events.js';

export {
    POSTHOG_NATIVE_ISSUE_STATUSES,
    POSTHOG_NATIVE_SEVERITIES,
    parsePosthogIssueCrudRead,
    parsePosthogIssueQueryDetail,
    parsePosthogIssueRow,
    parsePosthogQueryEnvelope,
} from './api/types/issues.js';
export type {
    PosthogIssueCrudRead,
    PosthogIssueQueryDetail,
    PosthogIssueRow,
    PosthogQueryEnvelope,
} from './api/types/issues.js';

export {
    isSameNormalizedOrigin,
    normalizePosthogApiOrigin,
    selectPosthogApiOrigin,
} from './connect/origin.js';
export type {
    PosthogApiOrigin,
    PosthogOriginResolution,
    PosthogOriginSelection,
} from './connect/origin.js';

export { getPosthogIssue } from './source/get.js';
export type { PosthogGetInput, PosthogGetOutcome } from './source/get.js';

export {
    buildPosthogCollisionScope,
    buildPosthogEntryLocator,
    buildPosthogLocalInstanceKey,
    parsePosthogCollisionScope,
    parsePosthogLocalInstanceKey,
} from './source/identity.js';
export type {
    PosthogEntryLocator,
    PosthogParsedLocalInstanceKey,
} from './source/identity.js';

export { resolvePosthogCrudFailure } from './source/issueResolution.js';
export type {
    PosthogIssueResolution,
    PosthogUnresolvedIssue,
} from './source/issueResolution.js';

export { utf8ByteLength } from './source/map/bounds.js';
export type { PosthogProjectionBounds } from './source/map/bounds.js';

export {
    POSTHOG_ENTRY_KIND,
    buildPosthogEntrySnapshot,
    buildPosthogScopeLabel,
} from './source/map/entrySnapshot.js';
export type { PosthogEntrySnapshot, PosthogSnapshotInput } from './source/map/entrySnapshot.js';

export { POSTHOG_FACT_PRIORITY, projectPosthogFacts } from './source/map/facts.js';
export type { PosthogFact, PosthogFactId } from './source/map/facts.js';

export { mapPosthogIssueState } from './source/map/state.js';
export type { PosthogMappedState, PosthogPresentationState } from './source/map/state.js';

export {
    POSTHOG_ISSUES_QUERY_MAX_LIMIT,
    buildPosthogIssueQueryBody,
    buildPosthogIssuesQueryBody,
    resolvePosthogNativeLimit,
} from './source/scan/request.js';
export type { PosthogResolvedWindow } from './source/scan/request.js';

export { scanPosthogIssuePage } from './source/scan/scan.js';
export type {
    PosthogIssueObservation,
    PosthogScanEnvironment,
    PosthogScanPageInput,
    PosthogScanPageOutcome,
} from './source/scan/scan.js';

export {
    POSTHOG_SAMPLED_EVENT_BOUNDS_V1,
    projectPosthogIssueEvents,
} from './ui/detail/issueEventProjection.js';
export type {
    PosthogProjectedException,
    PosthogProjectedFrame,
    PosthogProjectedIssueEvent,
    PosthogSampledEventBounds,
} from './ui/detail/issueEventProjection.js';

export {
    buildPosthogDetailGetRequest,
    projectPosthogDetailSurface,
} from './ui/detail/model.js';
export type {
    PosthogDetailBodyV1,
    PosthogDetailFieldV1,
    PosthogDetailGetRequestV1,
    PosthogDetailReadV1,
    PosthogDetailSurfaceModelV1,
} from './ui/detail/model.js';

export {
    posthogAffectedSessionRows,
    posthogOccurrenceRows,
    posthogStackTrace,
} from './ui/detail/sampledViews.js';
export type {
    PosthogAffectedSessionRowV1,
    PosthogOccurrenceRowV1,
    PosthogSessionReplayV1,
    PosthogStackFrameRowV1,
    PosthogStackTraceV1,
} from './ui/detail/sampledViews.js';

export {
    POSTHOG_DETAIL_TABS_V1,
    posthogDetailTabDeclaration,
} from './ui/detail/tabDeclarations.js';
export type {
    PosthogDetailTabDeclarationV1,
    PosthogDetailTabIdV1,
    PosthogDetailTabReadPlaneV1,
} from './ui/detail/tabDeclarations.js';
