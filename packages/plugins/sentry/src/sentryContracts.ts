/**
 * Stable Sentry plugin identities and the bounded semantic constants this source
 * projects against. Nothing here is derived from a provider response.
 */

import {
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_INSTANCE_DRAFTS_V1,
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_ROW_FACTS_V1,
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

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
 * **Residual, stated plainly because this comment previously claimed otherwise:**
 * `privateNetwork` classifies the URL's HOST as written — literal `localhost`,
 * RFC1918 ranges, loopback, link-local and unique-local IPv6. It does NOT resolve
 * the name, so a PUBLIC hostname whose DNS answer points at a private address is
 * not caught here, and this split does not prevent that. Calling it rebinding
 * protection was wrong twice over: nothing resolves or pins the address, and
 * "DNS rebinding" conventionally names an INBOUND Host-header control rather than
 * outbound egress. The grant is a capability DECLARATION that makes a plugin's
 * private-network reach visible and reviewable — which is real value — not an
 * enforcement boundary against the plugin, which is trusted first-party code.
 */
export const SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID = 'sentry-cloud-api';
export const SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID = 'sentry-account-api';
export const SENTRY_CONTRIBUTION_ID = 'sentry-issues';
export const SENTRY_ENTRY_KIND_ID = 'error-issue';

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
  listInstances: 'sentry/list-instances',
  scan: 'sentry/scan-issues',
  get: 'sentry/get-issue',
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

/**
 * Semantic projection bounds.
 *
 * Stage 1 restated these locally while the target protocol package did not yet
 * exist. It does now, and it is the published owner of every one of them, so
 * these names are aliases rather than a second copy that could silently drift
 * from the contract this source projects into.
 */
export const SENTRY_MAX_TEXT_UTF8_BYTES = MAX_TRIAGE_TEXT_UTF8_BYTES_V1;
/** A machine-meaningful destination: emitted whole or omitted, never shortened. */
export const SENTRY_MAX_LOCATION_UTF8_BYTES = MAX_TRIAGE_LOCATION_UTF8_BYTES_V1;
export const SENTRY_MAX_IDENTIFIER_UTF8_BYTES = MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1;
export const SENTRY_MAX_ROW_FACT_VALUE_UTF8_BYTES = MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1;
export const SENTRY_MAX_ROW_FACTS = MAX_TRIAGE_ROW_FACTS_V1;
export const SENTRY_MAX_CONFIGURATION_TOKEN_UTF8_BYTES =
  MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1;
export const SENTRY_MAX_PAGING_TOKEN_UTF8_BYTES = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1;
export const SENTRY_MAX_INSTANCE_DRAFTS = MAX_TRIAGE_INSTANCE_DRAFTS_V1;
/** The aggregate's per-invocation scan page bound. */
export const SENTRY_MAX_SCAN_PAGE_ENTRIES = MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1;

/** `[SCHEMA]` the organization issues list caps `limit` at 100. */
export const SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT = 100;
/** `[SCHEMA]` `per_page` maximum on the organization listing. */
export const SENTRY_ORGANIZATIONS_PAGE_SIZE = 100;
/** `[SOURCE]` `api/utils.py` `MAX_STATS_PERIOD = timedelta(days=90)`. */
export const SENTRY_SCAN_STATS_PERIOD = '90d';

/** The unit separator that joins the two collision-scope components. */
export const SENTRY_SCOPE_SEPARATOR = '\u001F';

/** The middle dot that separates a locator's path from its short id. */
export const SENTRY_DISPLAY_PATH_SEPARATOR = ' \u00B7 ';

/**
 * The closed Sentry failure vocabulary. Every code that can leave this source
 * appears here; no provider status, body or header is ever echoed.
 */
export const SENTRY_FAILURE_CODES = Object.freeze({
  tokenInvalid: 'sentry-token-invalid',
  /**
   * The HOST refused to materialize the exact bound account — the account was
   * removed, the purpose was revoked, or the origin is no longer admitted. It is
   * an `authentication` failure, not a Sentry outage: the user fixes the
   * connection and presses Refresh, which the aggregate's backoff deliberately
   * exempts for this class.
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
  malformedOrganizationRow: 'sentry-malformed-organization-row',
  instanceCapReached: 'sentry-instance-cap-reached',
  accountListTruncated: 'sentry-account-list-truncated',
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
  issuesList: 'sentry-self-hosted-issues-list-unsupported',
  issue: 'sentry-self-hosted-issue-unsupported',
  issueEvents: 'sentry-self-hosted-issue-events-unsupported',
  event: 'sentry-self-hosted-event-unsupported',
  tagValues: 'sentry-self-hosted-tag-values-unsupported',
} as const);

export type SentryOperationV1 = keyof typeof SENTRY_SELF_HOSTED_UNSUPPORTED_CODES;

/**
 * The shared failure classes this source projects into. The names match the
 * Triage contract's closed vocabulary so the later binding is a rename, not a
 * remapping.
 */
export type SentryFailureClassV1 =
  | 'authentication'
  | 'permission'
  | 'rateLimit'
  | 'transient'
  | 'unsupportedContract'
  | 'unknown';

export type SentryFailureV1 = Readonly<{
  class: SentryFailureClassV1;
  code: SentryFailureCodeV1 | (typeof SENTRY_SELF_HOSTED_UNSUPPORTED_CODES)[SentryOperationV1];
  /** Absolute epoch milliseconds; present only when the provider supplied usable evidence. */
  retryNotBeforeMs?: number;
}>;
