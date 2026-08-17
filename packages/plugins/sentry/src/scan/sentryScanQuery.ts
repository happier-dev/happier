/**
 * The one owner of the scan request's query string (`SENTRY.md` §3.2).
 *
 * Every parameter is sent explicitly, including the ones whose value equals the
 * server default, because on this endpoint the narrowing defaults live in the
 * query string the caller builds:
 *
 * - `query` defaults to `is:unresolved`, so an omitted query silently hides
 *   every resolved issue;
 * - with no window parameter the search covers the last 90 days
 *   (`[SOURCE]` `api/utils.py:78` `MAX_STATS_PERIOD`), so the ceiling is
 *   declared rather than inherited;
 * - `project=-1` is the documented "all accessible projects" value.
 *
 * `collapse=stats` and `collapse=filtered` drop the bulkiest unused fields.
 * `lifetime` is deliberately never collapsed: it is list-only, so collapsing it
 * would make all-time counts unreachable from anywhere. `per_page`,
 * `shortIdLookup`, `environment` and `llmFormat` are never sent.
 */

import {
  SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT,
  SENTRY_SCAN_STATS_PERIOD,
} from '../sentryContracts.js';

import { assertRoutableSentryInstance } from '../api/sentryRoutes.js';
import type { SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';

export type SentryScanRequestInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  /** Frozen for the whole pass; `min(scanLimit, 100)`. */
  nativeLimit: number;
  cursor?: string;
}>;

export const SENTRY_SCAN_QUERY = '';
export const SENTRY_SCAN_SORT = 'date';
export const SENTRY_SCAN_PROJECT_SCOPE = '-1';

export function buildSentryScanIssuesUrl(input: SentryScanRequestInputV1): string {
  // One rule for what makes an instance addressable, owned by the route module
  // this file's own URL construction shares with every detail route.
  const origin = assertRoutableSentryInstance(input.instance);
  if (
    !Number.isSafeInteger(input.nativeLimit)
    || input.nativeLimit < 1
    || input.nativeLimit > SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT
  ) {
    throw new Error('A Sentry scan page limit must be an integer within the provider bound.');
  }

  const url = new URL(
    `/api/0/organizations/${input.instance.organizationId}/issues/`,
    origin,
  );
  url.searchParams.set('query', SENTRY_SCAN_QUERY);
  url.searchParams.set('statsPeriod', SENTRY_SCAN_STATS_PERIOD);
  url.searchParams.set('project', SENTRY_SCAN_PROJECT_SCOPE);
  url.searchParams.set('sort', SENTRY_SCAN_SORT);
  url.searchParams.set('limit', String(input.nativeLimit));
  url.searchParams.append('collapse', 'stats');
  url.searchParams.append('collapse', 'filtered');
  if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
  return url.toString();
}
