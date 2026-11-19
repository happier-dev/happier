/**
 * Stable Sentry plugin identities and provider-specific contract constants.
 * Shared Triage projection bounds stay at their protocol owner.
 */

import { TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-sources/runtime';

import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

export const SENTRY_PLUGIN_ID = 'happier.sentry';
export const SENTRY_CONNECTED_ACCOUNT_ID = 'sentry-account';
export const SENTRY_CONNECTED_ACCOUNT_PURPOSE = 'sentry-account-use';
/**
 * The two network grants, split by what the target's origin is allowed to be.
 *
 * `privateNetwork` is scope-level, a sibling of `methods`, so one grant holding
 * both the Cloud origins and the account origin could only declare it for all
 * three at once. Splitting them keeps the two fixed Cloud origins out of the
 * reach a self-hosted deployment needs: a user who configures a private-network
 * Sentry widens only the account grant, and the Cloud origins never gain private
 * reach along with it.
 *
 * Host admission resolves the selected origin, rejects mixed or private answers
 * unless this exact grant permits them, and carries the admitted addresses to the
 * pinned socket owner. The split therefore keeps Cloud public-only while allowing
 * an explicitly configured self-hosted origin to reach its private endpoint.
 */
export const SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID = 'sentry-cloud-api';
export const SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID = 'sentry-account-api';
export const SENTRY_CONTRIBUTION_ID = 'sentry-issues';
export const SENTRY_ENTRY_KIND_ID = 'error-issue';
/** Reserved evidence identity pending the approved projection-size amendment. */
export const SENTRY_EVIDENCE_REFERENCE_ID = 'sentry-evidence';

/** The source display name, named once for the descriptor and the Settings page. */
export const SENTRY_SOURCE_DISPLAY_NAME = 'Sentry';

/**
 * The source-owned Settings page a person uses to put Sentry into PRs & Issues,
 * and the artifact that mounts it.
 *
 * It is a plain Settings contribution: the generic Settings catalog owns the
 * group, route and availability decision, and this source supplies one page and
 * one renderer. The page is the only production caller of the target-owned
 * `happier.triage/sources/administer-v1` Action for this source, and without it
 * every configured-instance path in this package is unreachable from the
 * product.
 */
export const SENTRY_TRIAGE_SETTINGS_GROUP_ID = 'sentry';
export const SENTRY_TRIAGE_SETTINGS_PAGE_ID = 'triage-sources';
export const SENTRY_TRIAGE_SETTINGS_RENDERER_ID = 'sentry-triage-sources';
export const SENTRY_TRIAGE_SETTINGS_ARTIFACT_ID = 'sentry-triage-sources-native';

export const SENTRY_ACTION_IDS = Object.freeze({
  setupIssueEvent: TRIAGE_ISSUE_SETUP_ACTION_LOCAL_ID_V1,
  resetIssueEvent: 'automation/reset-issue-transition-v1',
  listInstances: 'sentry/list-instances',
  listScopeUnits: 'sentry/list-projects',
  scan: 'sentry/scan-issues',
  get: 'sentry/get-issue',
  resolve: 'sentry/resolve-issue',
  archive: 'sentry/archive-issue',
  assign: 'sentry/assign-issue',
  readIssue: 'sentry/read-issue',
  listIssueEvents: 'sentry/list-issue-events',
  readEvent: 'sentry/read-event',
  listTagValues: 'sentry/list-tag-values',
} as const);

/** The two documented Sentry Cloud API deployments. */
export const SENTRY_CLOUD_REGION_ORIGINS = Object.freeze({
  us: 'https://us.sentry.io',
  de: 'https://de.sentry.io',
} as const);

export type SentryCloudRegionV1 = keyof typeof SENTRY_CLOUD_REGION_ORIGINS;

/**
 * The closed Cloud choice set, in the order the connect form offers it. It is
 * the descriptor's `enum` and the key set of its declared origin table, so a
 * pickable region can never lack a route and a route can never lack a picker.
 */
export const SENTRY_CLOUD_REGIONS: readonly SentryCloudRegionV1[] = Object.freeze(
  Object.keys(SENTRY_CLOUD_REGION_ORIGINS) as SentryCloudRegionV1[],
);

export function isSentryCloudRegion(value: unknown): value is SentryCloudRegionV1 {
  return typeof value === 'string' && Object.hasOwn(SENTRY_CLOUD_REGION_ORIGINS, value);
}

/** `[SCHEMA]` the organization issues list caps `limit` at 100. */
export const SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT = 100;
/** `[SCHEMA]` `per_page` maximum on the organization listing. */
export const SENTRY_ORGANIZATIONS_PAGE_SIZE = 100;
/** Organization projects API documents a maximum `per_page` of 100. */
export const SENTRY_PROJECTS_PAGE_SIZE = 100;
/** `[SOURCE]` `api/utils.py` `MAX_STATS_PERIOD = timedelta(days=90)`. */
export const SENTRY_SCAN_STATS_PERIOD = '90d';

/** The unit separator that joins the two collision-scope components. */
export const SENTRY_SCOPE_SEPARATOR = '\u001F';

/** The middle dot that separates a locator's path from its short id. */
export const SENTRY_DISPLAY_PATH_SEPARATOR = ' \u00B7 ';

/**
 * Sentry-owned failure codes. Classified host refusals retain the shared owner's
 * code and redacted request identity instead of using this local vocabulary.
 */
export const SENTRY_FAILURE_CODES = Object.freeze({
  tokenInvalid: 'sentry-token-invalid',
  /**
   * A materialization refusal with no typed host diagnostic. Classified host
   * refusals keep their original code and class through the shared owner.
   */
  accountMaterializationFailed: 'sentry-account-materialization-failed',
  /** The account materialized, but carried no usable `authorization` header. */
  authorizationHeaderUnavailable: 'sentry-authorization-header-unavailable',
  /** The account materialized something other than HTTP headers. */
  unsupportedMaterialization: 'sentry-unsupported-materialization',
  insufficientPermission: 'sentry-insufficient-permission',
  rateLimited: 'sentry-rate-limited',
  rateLimitedUnhinted: 'sentry-rate-limited-unhinted',
  queryRejected: 'sentry-query-rejected',
  notFoundUnverified: 'sentry-not-found-unverified',
  upstreamUnavailable: 'sentry-upstream-unavailable',
  cancelled: 'sentry-cancelled',
  /**
   * Sentry accepted the request and did not answer inside this source's own
   * invocation deadline. It is deliberately not `cancelled`: nobody abandoned
   * this read, and a reader told "cancelled" has no reason to try again.
   */
  deadlineElapsed: 'sentry-deadline-elapsed',
  responseUnparseable: 'sentry-response-unparseable',
  unexpectedStatus: 'sentry-unexpected-status',
  paginationHeaderAbsent: 'sentry-pagination-header-absent',
  paginationCursorMalformed: 'sentry-pagination-cursor-malformed',
  paginationCursorNotAdvancing: 'sentry-pagination-cursor-not-advancing',
  directHitInScan: 'sentry-direct-hit-in-scan',
  malformedIssueRow: 'sentry-malformed-issue-row',
  /**
   * The issue Sentry returned is not the issue the detail asked for.
   *
   * Sentry serves a merged-away issue id by answering with the SURVIVING issue, and it
   * resolves a short id to whatever it now points at. Both answers are `200` with a
   * perfectly well-formed body, so nothing downstream can tell them from the requested
   * issue — the panel would render another issue's state, counts and releases under this
   * entry's identity, and every Action dispatched from it would carry the wrong subject.
   */
  issueIdentityMismatch: 'sentry-issue-identity-mismatch',
  /**
   * An event body that carried no readable event, including one that was not an object
   * at all. The projector answers an empty allow-listed projection for anything it
   * cannot read, and an empty projection returned as a SUCCESS is indistinguishable from
   * an occurrence that genuinely has no content.
   */
  eventUnreadable: 'sentry-event-unreadable',
  malformedOrganizationRow: 'sentry-malformed-organization-row',
  malformedProjectRow: 'sentry-malformed-project-row',
  accountListTruncated: 'sentry-account-list-truncated',
  instanceListResponseTruncated: 'sentry-instance-list-response-truncated',
  regionOriginUndeclared: 'sentry-region-origin-undeclared',
  invokedOriginMismatch: 'sentry-invoked-origin-mismatch',
  invokedOrganizationMismatch: 'sentry-invoked-organization-mismatch',
  noAccessibleOrganizations: 'sentry-no-accessible-organizations',
  deploymentUnconfirmed: 'sentry-deployment-unconfirmed',
  verificationUnavailable: 'sentry-verification-unavailable',
  verificationUnknown: 'sentry-verification-unknown',
} as const);

export type SentryFailureCodeV1 =
  (typeof SENTRY_FAILURE_CODES)[keyof typeof SENTRY_FAILURE_CODES];

/**
 * One fixed operation-qualified code per allowed self-hosted `GET`, used when a
 * deployment does not implement the current public operation this source parses.
 */
export const SENTRY_SELF_HOSTED_UNSUPPORTED_CODES = Object.freeze({
  organizations: 'sentry-self-hosted-organizations-unsupported',
  organizationMember: 'sentry-self-hosted-organization-member-unsupported',
  projects: 'sentry-self-hosted-projects-unsupported',
  issuesList: 'sentry-self-hosted-issues-list-unsupported',
  issue: 'sentry-self-hosted-issue-unsupported',
  issueEvents: 'sentry-self-hosted-issue-events-unsupported',
  event: 'sentry-self-hosted-event-unsupported',
  tagValues: 'sentry-self-hosted-tag-values-unsupported',
  projectMembers: 'sentry-self-hosted-project-members-unsupported',
  projectTeams: 'sentry-self-hosted-project-teams-unsupported',
} as const);

export type SentryOperationV1 = keyof typeof SENTRY_SELF_HOSTED_UNSUPPORTED_CODES;

/**
 * The shared failure classes this source projects into. The names match the
 * Triage contract's closed vocabulary so the later binding is a rename, not a
 * remapping.
 */
export type SentryFailureClassV1 = TriageSourceFailureV1['class'];

export type SentryFailureV1 = TriageSourceFailureV1;
