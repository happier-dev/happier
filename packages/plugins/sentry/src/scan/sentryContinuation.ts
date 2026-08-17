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
 */

import {
  SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT,
  SENTRY_MAX_PAGING_TOKEN_UTF8_BYTES,
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeSentryScanContinuation(continuation: SentryScanContinuationV1): string {
  if (continuation.v !== 1) {
    throw new Error('Only version 1 Sentry scan continuations can be encoded.');
  }
  if (!isValidGeometry(continuation.scanLimit, continuation.nativeLimit)) {
    throw new Error('A Sentry scan continuation must freeze nativeLimit at min(scanLimit, 100).');
  }
  if (continuation.cursor === '') {
    throw new Error('A Sentry scan continuation requires the provider cursor.');
  }
  if (
    continuation.query !== SENTRY_SCAN_QUERY
    || continuation.statsPeriod !== SENTRY_SCAN_STATS_PERIOD
    || continuation.sort !== SENTRY_SCAN_SORT
  ) {
    throw new Error('A Sentry scan continuation must carry the frozen full-pass query facts.');
  }
  const token = JSON.stringify({
    v: 1,
    scanLimit: continuation.scanLimit,
    nativeLimit: continuation.nativeLimit,
    cursor: continuation.cursor,
    query: continuation.query,
    statsPeriod: continuation.statsPeriod,
    sort: continuation.sort,
  });
  if (new TextEncoder().encode(token).byteLength > SENTRY_MAX_PAGING_TOKEN_UTF8_BYTES) {
    throw new Error('The Sentry scan continuation exceeds the bounded paging token size.');
  }
  return token;
}

export function decodeSentryScanContinuation(token: string): SentryScanContinuationResultV1 {
  if (new TextEncoder().encode(token).byteLength > SENTRY_MAX_PAGING_TOKEN_UTF8_BYTES) {
    return REJECTED;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return REJECTED;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return REJECTED;
  const { scanLimit, nativeLimit, cursor, query, statsPeriod, sort } = parsed;
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
