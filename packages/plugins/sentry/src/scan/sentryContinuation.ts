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
 * The strict-JSON envelope is the protocol's (`encodeTriagePagingTokenV1` /
 * `decodeTriagePagingTokenV1`); what stays here is the frontier record inside it
 * and every field check that decides what this walk may resume from.
 */

import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
} from '@happier-dev/triage-protocol/v1';

import {
  readCursorCycleProbeV1,
  type CursorCycleProbeV1,
} from '@happier-dev/triage-sources/runtime';
import {
  SENTRY_MAX_NATIVE_ISSUE_PAGE_LIMIT,
  SENTRY_SCAN_STATS_PERIOD,
} from '../sentryContracts.js';

import {
  readSentryScanStickyReason,
  type SentryScanStickyReasonV1,
} from './sentryScanHealth.js';

import { SENTRY_SCAN_QUERY, SENTRY_SCAN_SORT } from './sentryScanQuery.js';

export type SentryScanContinuationV1 = Readonly<{
  v: 1;
  /** The exact initial aggregate bound, restored on resume. */
  scanLimit: number;
  /** Exactly `min(scanLimit, 100)`; every provider page in this pass uses it. */
  nativeLimit: number;
  /** The `cursor` value taken verbatim from the validated `rel="next"` link. */
  cursor: string;
  /**
   * The earlier position this pass is watching for, and the schedule that moves
   * it (the shared Triage source cursor-cycle owner).
   *
   * It is the walk's own non-progress evidence, and it lives here because that
   * is the only place a pass whose pages are separate invocations can keep it.
   * Comparing an advertised next cursor against the single cursor that produced
   * it only sees `A → A`; a provider alternating `A → B → A` advertises a cursor
   * that differs from the one just requested on every page, so the walk mints a
   * frontier for a position it already read and keeps doing so for as long as
   * the caller asks. The aggregate eventually stops that by exhausting its
   * observation budget — and declares this source a non-progressing walk,
   * discarding every row the lane produced. The walk seeing its own cycle
   * settles a truthful partial instead and keeps the rows.
   *
   * It is a within-pass position, exactly like `cursor`: no route, no
   * credential, no clock, and nothing that outlives the pass. It is one saved
   * cursor rather than the whole requested-position history because one witness
   * detects a cycle without making the frontier grow on every page.
   */
  probe: CursorCycleProbeV1;
  /**
   * The caveats this walk has already established, carried forward across every
   * page of the same pass.
   *
   * A walk's pages are separate invocations, so without this the health went
   * with them: page one omitting undecodable rows and page two running cleanly
   * out of pagination reported a walk that skipped issues as a finished one.
   * Names only — the per-call `omittedItemCount` stays per call, so the
   * aggregate's `observations + omittedItemCount <= limit` check stays exact.
   */
  walkHealth: readonly SentryScanStickyReasonV1[];
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
 * It is emphatically **not** a cursor verdict. It remains available for genuine
 * serialization failures; reporting those as cursor malformation would blame
 * the provider for a failure this side owns.
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
    && nativeLimit === resolveSentryNativeLimit(scanLimit);
}

/**
 * Projects this pass's frozen facts into the protocol's strict-JSON token.
 *
 * `null` means no continuation can be minted — the record does not describe the
 * geometry this pass froze, or strict JSON serialization failed. The caller then
 * settles a truthful partial rather than presenting a truncated walk as a
 * finished one.
 */
export function encodeSentryScanContinuation(
  continuation: SentryScanContinuationV1,
): string | null {
  if (continuation.v !== 1) return null;
  if (!isValidGeometry(continuation.scanLimit, continuation.nativeLimit)) return null;
  if (continuation.cursor === '') return null;
  if (readCursorCycleProbeV1(continuation.probe) === null) return null;
  if (readSentryWalkHealth(continuation.walkHealth) === null) return null;
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
    probe: { ...continuation.probe },
    walkHealth: [...continuation.walkHealth],
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
  const probe = readCursorCycleProbeV1(record['probe']);
  if (probe === null) return REJECTED;
  const walkHealth = readSentryWalkHealth(record['walkHealth']);
  if (walkHealth === null) return REJECTED;
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
      probe,
      walkHealth,
      query: SENTRY_SCAN_QUERY,
      statsPeriod: SENTRY_SCAN_STATS_PERIOD,
      sort: SENTRY_SCAN_SORT,
    }),
  });
}

/**
 * An unrecognized or repeated reason name is a token this source did not mint at
 * this version. Dropping it silently would erase a caveat the walk already
 * established, which is the exact failure this field exists to prevent.
 */
function readSentryWalkHealth(raw: unknown): readonly SentryScanStickyReasonV1[] | null {
  if (!Array.isArray(raw)) return null;
  const reasons: SentryScanStickyReasonV1[] = [];
  for (const entry of raw) {
    const reason = readSentryScanStickyReason(entry);
    if (reason === null || reasons.includes(reason)) return null;
    reasons.push(reason);
  }
  return Object.freeze(reasons);
}
