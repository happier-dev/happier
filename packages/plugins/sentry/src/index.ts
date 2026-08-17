/**
 * `@happier-dev/plugins-sentry` — the Sentry Triage source vertical.
 *
 * This package owns the Sentry manifest and registration spine, the three bound
 * Triage source operations, the three source-native detail reads behind its own
 * detail body, the Connected Account runtime, the API client, route templates,
 * deployment-origin resolution, configured-instance codecs, scan pagination and
 * issue mapping. The selected Tier-B Composer evidence reference arrives with
 * its own later unit.
 */

export * from './sentryContracts.js';

export { activate } from './activate.js';
export {
  PLUGIN_MANIFEST,
  PLUGIN_MANIFEST as manifest,
  SENTRY_DETAIL_ARTIFACT_ID,
  SENTRY_DETAIL_FALLBACK_RENDERER_ID,
  SENTRY_DETAIL_RENDERER_ID,
  SENTRY_PLUGIN,
} from './manifest.js';

export {
  admitSentryEntryInvocation,
  getSentrySourceEntry,
  listSentryInstances,
  resolveInstanceDeployment,
  scanSentrySource,
} from './source/operations.js';
export {
  listSentryIssueEvents,
  listSentryTagValues,
  readSentryIssue,
} from './source/detailOperations.js';
export {
  MAX_SENTRY_DETAIL_CONTINUATION_UTF8_BYTES,
  SENTRY_DETAIL_PAGE_SIZE,
  SentryIssueEventsInputV1Schema,
  SentryIssueEventsResultV1Schema,
  SentryEventProjectionV1Schema,
  SentryEventSelectorV1Schema,
  SentryReadEventInputV1Schema,
  SentryReadEventResultV1Schema,
  SentryReadIssueInputV1Schema,
  SentryReadIssueResultV1Schema,
  SentryTagValuesInputV1Schema,
  SentryTagValuesResultV1Schema,
  decodeSentryDetailContinuation,
  encodeSentryDetailContinuation,
} from './detail/detailContracts.js';
export type {
  SentryIssueEventsInputV1,
  SentryIssueEventsResultV1,
  SentryReadEventInputV1,
  SentryReadEventResultV1,
  SentryReadIssueInputV1,
  SentryReadIssueResultV1,
  SentryTagValuesInputV1,
  SentryTagValuesResultV1,
} from './detail/detailContracts.js';
export {
  SENTRY_DETAIL_BOUNDS_V1,
  SENTRY_MAX_ACTIVITY_ITEMS,
  SENTRY_MAX_EVENT_ROWS,
  SENTRY_MAX_TAG_VALUE_ROWS,
  projectSentryActivity,
  projectSentryEventRows,
  projectSentryIssueTags,
  projectSentryReleaseAssociation,
  projectSentryTagValueRows,
} from './detail/detailProjection.js';
export type {
  SentryActivityProjectionV1,
  SentryProjectedActivityItemV1,
  SentryProjectedEventRowV1,
  SentryProjectedReleaseV1,
  SentryProjectedTagV1,
  SentryProjectedTagValueV1,
} from './detail/detailProjection.js';
export {
  readSentryEventProjection,
  readSentryIssueEventsPage,
  readSentryIssueProjection,
  readSentryTagValuesPage,
} from './detail/detailReads.js';
export {
  SENTRY_EVENT_BOUNDS_V1,
  projectSentryEventForDisplay,
  sentryProjectionHasTrace,
} from './privacy/sentryEventProjection.js';
export type {
  SentryBreadcrumbV1,
  SentryEventProjectionV1,
  SentryEventSectionV1,
  SentryEventTagProjectionV1,
  SentryEventUserProjectionV1,
  SentryFrameV1,
  SentryRedactionV1,
} from './privacy/sentryEventProjection.js';
export {
  isSentryAllowedTagKey,
  isSentrySensitiveTagKey,
} from './privacy/sentryTagAllowList.js';
export type { SentryTagKeyV1 } from './privacy/sentryTagAllowList.js';
export {
  SENTRY_DETAIL_STATS_PERIOD,
  SENTRY_MAX_DETAIL_PAGE_SIZE,
  assertRoutableSentryInstance,
  buildSentryIssueEventUrl,
  buildSentryIssueEventsUrl,
  buildSentryIssueUrl,
  buildSentryTagValuesUrl,
  isSentryRoutableTagKey,
} from './api/sentryRoutes.js';
export {
  SENTRY_MOVING_SCAN_REASON,
  toTriageFailure,
  toTriageLocalRef,
  toTriagePresentObservation,
  toTriageScanEvidence,
  toTriageScanObservation,
} from './source/observation.js';

export {
  SENTRY_CLOUD_MODE_ID,
  SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY,
  SENTRY_ORIGIN_CONFIGURATION_FIELD,
  SENTRY_REGION_CONFIGURATION_FIELD,
  SENTRY_SELF_HOSTED_MODE_ID,
  SENTRY_TOKEN_CREDENTIAL_KEY,
  sentryConnectedAccountRuntime,
} from './auth/connectedAccountRuntime.js';
export { resolveSentryAccountRoute } from './auth/sentryAccountRoute.js';
export type { SentryAccountRouteResultV1 } from './auth/sentryAccountRoute.js';

export { createSentryApiClient } from './api/sentryApiClient.js';
export type {
  SentryApiClientInputV1,
  SentryApiClientV1,
  SentryApiOutcomeV1,
  SentryApiResponseV1,
} from './api/sentryApiClient.js';
export { classifySentryFailure } from './api/sentryFailure.js';
export type { SentryFailureInputV1, SentrySettledResponseV1 } from './api/sentryFailure.js';
export { parseSentryLinkHeader } from './api/sentryLinkHeader.js';
export type { SentryLinkHeaderV1, SentryLinkRelationV1 } from './api/sentryLinkHeader.js';
export {
  SENTRY_MAX_RETRY_HINT_HORIZON_MS,
  readSentryRateLimitSnapshot,
  resolveSentryRetryNotBeforeMs,
} from './api/sentryRateLimit.js';
export type { SentryRateLimitSnapshotV1 } from './api/sentryRateLimit.js';

export {
  checkSentryRegionUrlConsistency,
  normalizeSentryOrigin,
  resolveSentryCloudDeployment,
  resolveSentrySelfHostedDeployment,
} from './auth/sentryOrigin.js';
export type {
  SentryDeploymentResultV1,
  SentryDeploymentV1,
  SentryOriginRejectionReasonV1,
  SentryRegionUrlCheckV1,
} from './auth/sentryOrigin.js';

export {
  deriveSentryCollisionScope,
  isSentryNumericId,
  resolveSentryInvokedScope,
} from './instances/sentryCollisionScope.js';
export type {
  SentryInvokedInstanceV1,
  SentryInvokedScopeResultV1,
} from './instances/sentryCollisionScope.js';
export {
  decodeSentryInstanceConfiguration,
  decodeSentryLocalInstanceKey,
  encodeSentryInstanceConfiguration,
  encodeSentryLocalInstanceKey,
} from './instances/sentryInstanceConfiguration.js';
export type {
  SentryInstanceConfigurationV1,
} from './instances/sentryInstanceConfiguration.js';
export { buildSentryLocator } from './instances/sentryLocator.js';
export type { SentryLocatorInputV1, SentryLocatorV1 } from './instances/sentryLocator.js';
export { parseSentryOrganizationsPage } from './instances/sentryOrganizations.js';
export type {
  SentryOrganizationV1,
  SentryOrganizationsPageV1,
} from './instances/sentryOrganizations.js';

export { executeSentryScanPage } from './scan/scanIssuesPage.js';
export type {
  SentryScanPageInputV1,
  SentryScanPageResultV1,
} from './scan/scanIssuesPage.js';
export {
  decodeSentryScanContinuation,
  encodeSentryScanContinuation,
  resolveSentryNativeLimit,
} from './scan/sentryContinuation.js';
export type { SentryScanContinuationV1 } from './scan/sentryContinuation.js';
export { SENTRY_WALK_FINISHED, sentryPartialHealth } from './scan/sentryScanHealth.js';
export type { SentryScanHealthV1 } from './scan/sentryScanHealth.js';
export { buildSentryScanIssuesUrl } from './scan/sentryScanQuery.js';
export type { SentryScanRequestInputV1 } from './scan/sentryScanQuery.js';

export { resolveSentryGetOutcome } from './entries/getIssueOutcome.js';
export type {
  SentryGetOutcomeInputV1,
  SentryGetOutcomeV1,
} from './entries/getIssueOutcome.js';
export {
  mapSentryIssueForInvokedInstance,
  mapSentryIssueState,
} from './entries/sentryIssueMapping.js';
export type {
  SentryIssueMappingInputV1,
  SentryIssueMappingResultV1,
} from './entries/sentryIssueMapping.js';
export type {
  SentryEntryStateV1,
  SentryFactValueV1,
  SentryIssueSnapshotV1,
  SentryLocalRefV1,
  SentryRowFactV1,
} from './entries/sentryIssueTypes.js';
