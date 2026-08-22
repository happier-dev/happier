/**
 * The invocation-local scan continuation (`SENTRY.md` §3.3).
 *
 * For `sort=date` the cursor's leading value is a keyset on a **mutating**
 * `last_seen` (`[SOURCE]` `executors.py:1237-1250`, `:1530`). A cursor kept past
 * the scan that acquired it points at a boundary that no longer partitions the
 * set the same way, so resuming from it silently loses everything whose
 * `last_seen` crossed it. The cursor is therefore a within-pass position and
 * never a durable watermark.
 *
 * Route state is deliberately absent: origin, organization, project/environment
 * scope, account binding and instance id are already owned by the selected
 * configured instance, and repeating them would create a second authority that
 * can go stale after a reconfiguration. No host clock reading is carried either.
 *
 * The bounded JSON envelope is the protocol's (`encodeTriagePagingTokenV1` /
 * `decodeTriagePagingTokenV1`); what stays here is the frontier record inside it
 * and every field check that decides what this walk may resume from.
 */

import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
} from '@happier-dev/triage-protocol/v1';

import {
  SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT,
  SENTRY_MAX_SCAN_PAGE_ENTRIES,
  SENTRY_SCAN_STATS_PERIOD,
} from '../sentryContracts.js';

import { SENTRY_SCAN_QUERY, SENTRY_SCAN_SORT } from './sentryScanQuery.js';

export type SentryScanContinuationV1 = Readonly<{
  v: 1;
  /** The exact initial aggregate bound, restored on resume. */
  scanLimit: number;
  /** Exactly `min(scanLimit, 100)`; every provider page in this pass uses it. */
  nativeLimit: number;
  /** The `cursor` value taken verbatim from the validated `rel="next"` link. */
  cursor: string;
  query: string;
  statsPeriod: '90d';
  sort: 'date';
}>;

export type SentryScanContinuationResultV1 =
  | Readonly<{ ok: true; continuation: SentryScanContinuationV1 }>
  | Readonly<{ ok: false }>;

/**
 * The health reason a walk settles on when its frontier cannot be minted.
 *
 * It is emphatically **not** a cursor verdict. The provider's cursor can be
 * perfectly well formed and still not fit the protocol's bounded paging token,
 * and reporting that as `sentry-pagination-cursor-malformed` blames the
 * provider for a bound this side owns. The truthful claim is the one the other
 * sources already make for the same condition: this page is the last one this
 * pass can hand back.
 */
export const SENTRY_CONTINUATION_UNAVAILABLE_REASON = 'sentry-continuation-unavailable';

const REJECTED = Object.freeze({ ok: false as const });

export function resolveSentryNativeLimit(scanLimit: number): number {
  return Math.min(scanLimit, SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT);
}

function isValidGeometry(scanLimit: unknown, nativeLimit: unknown): boolean {
  return typeof scanLimit === 'number'
    && Number.isSafeInteger(scanLimit)
    && scanLimit >= 1
    && scanLimit <= SENTRY_MAX_SCAN_PAGE_ENTRIES
    && nativeLimit === resolveSentryNativeLimit(scanLimit);
}

/**
 * Projects this pass's frozen facts into the protocol's bounded token.
 *
 * `null` means no continuation can be minted — the record does not describe the
 * geometry this pass froze, or it does not fit the bound. The caller then
 * settles a truthful partial rather than presenting a truncated walk as a
 * finished one, and never emits an over-bound token that would discard the page
 * it belongs to.
 */
export function encodeSentryScanContinuation(
  continuation: SentryScanContinuationV1,
): string | null {
  if (continuation.v !== 1) return null;
  if (!isValidGeometry(continuation.scanLimit, continuation.nativeLimit)) return null;
  if (continuation.cursor === '') return null;
  if (
    continuation.query !== SENTRY_SCAN_QUERY
    || continuation.statsPeriod !== SENTRY_SCAN_STATS_PERIOD
    || continuation.sort !== SENTRY_SCAN_SORT
  ) {
    return null;
  }
  return encodeTriagePagingTokenV1({
    v: 1,
    scanLimit: continuation.scanLimit,
    nativeLimit: continuation.nativeLimit,
    cursor: continuation.cursor,
    query: continuation.query,
    statsPeriod: continuation.statsPeriod,
    sort: continuation.sort,
  });
}

export function decodeSentryScanContinuation(token: string): SentryScanContinuationResultV1 {
  const record = decodeTriagePagingTokenV1(token);
  if (record === null || record.v !== 1) return REJECTED;
  const { scanLimit, nativeLimit, cursor, query, statsPeriod, sort } = record;
  if (!isValidGeometry(scanLimit, nativeLimit)) return REJECTED;
  if (typeof cursor !== 'string' || cursor === '') return REJECTED;
  if (query !== SENTRY_SCAN_QUERY) return REJECTED;
  if (statsPeriod !== SENTRY_SCAN_STATS_PERIOD) return REJECTED;
  if (sort !== SENTRY_SCAN_SORT) return REJECTED;
  return Object.freeze({
    ok: true as const,
    continuation: Object.freeze({
      v: 1 as const,
      scanLimit: scanLimit as number,
      nativeLimit: nativeLimit as number,
      cursor,
      query: SENTRY_SCAN_QUERY,
      statsPeriod: SENTRY_SCAN_STATS_PERIOD,
      sort: SENTRY_SCAN_SORT,
    }),
  });
}
