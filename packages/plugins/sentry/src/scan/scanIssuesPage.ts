/**
 * One provider page of the V1 full scan (`SENTRY.md` §3.3–§3.4).
 *
 * Rules that are correctness, not style:
 *
 * - **An absent `Link` is never a finished walk.** For the request shape this
 *   builds, first-party Sentry always writes `Link` (`[SOURCE]` `api/base.py`
 *   `add_cursor_headers`), and the one branch that omits it — a direct hit — is
 *   rejected outright. An absent header therefore means a proxy stripped it or
 *   the server is not one this contract characterizes: a reason to stop, not to
 *   declare the walk over.
 * - **A successful response never waits.** Rate headers on a 2xx are diagnostics
 *   for that response only; the next page is emitted immediately. Only an actual
 *   429 produces a failed result, and it discards the continuation.
 * - **A malformed row is skipped, never fatal.** Valid siblings survive, and only
 *   omitted raw rows increment `omittedItemCount`; semantic truncation does not.
 */

import { SENTRY_FAILURE_CODES, type SentryFailureV1 } from '../sentryContracts.js';
import type { SentryApiClientV1 } from '../api/sentryApiClient.js';
import {
  advanceSentryCursorWalk,
  type SentryCursorWalkV1,
} from '../api/sentryCursorCycle.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { parseSentryLinkHeader } from '../api/sentryLinkHeader.js';
import { mapSentryIssueForInvokedInstance } from '../entries/sentryIssueMapping.js';
import type { SentryIssueSnapshotV1 } from '../entries/sentryIssueTypes.js';
import type { SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';

import {
  SENTRY_CONTINUATION_UNAVAILABLE_REASON,
  decodeSentryScanContinuation,
  encodeSentryScanContinuation,
  resolveSentryNativeLimit,
} from './sentryContinuation.js';
import {
  SENTRY_WALK_FINISHED,
  sentryPartialHealth,
  type SentryScanHealthV1,
} from './sentryScanHealth.js';
import {
  SENTRY_SCAN_QUERY,
  SENTRY_SCAN_SORT,
  buildSentryScanIssuesUrl,
} from './sentryScanQuery.js';

export type SentryScanPageInputV1 = Readonly<{
  client: SentryApiClientV1;
  configured: SentryInvokedInstanceV1;
  organizationSlug: string | null;
  page:
    | Readonly<{ kind: 'initial'; scanLimit: number }>
    | Readonly<{ kind: 'continuation'; token: string }>;
  nowMs: number;
}>;

export type SentryScanPageResultV1 =
  | Readonly<{
    kind: 'page';
    observations: readonly SentryIssueSnapshotV1[];
    /** null while the walk is in progress and nothing needs reporting. */
    health: SentryScanHealthV1 | null;
    /** Valid only inside this active scan; never persisted or resumed later. */
    continuation: string | null;
  }>
  | Readonly<{ kind: 'failed'; failure: SentryFailureV1; health: SentryScanHealthV1 }>;

function failedResult(failure: SentryFailureV1): SentryScanPageResultV1 {
  return Object.freeze({
    kind: 'failed' as const,
    failure,
    health: sentryPartialHealth(failure.code),
  });
}

/**
 * The direct-hit marker is a flag, not a value.
 *
 * First-party Sentry writes it only on the short-id branch, so the header being
 * there at all is the whole signal and an empty one is still that branch. The
 * shared value reader deliberately reports a present-but-empty header as absent
 * — right for `Retry-After` and `Link`, where an empty value states nothing —
 * which is the opposite of what this refusal needs, so presence is asked here.
 */
function hasSentryDirectHitMarker(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === 'x-sentry-direct-hit');
}

export async function executeSentryScanPage(
  input: SentryScanPageInputV1,
): Promise<SentryScanPageResultV1> {
  let scanLimit: number;
  let nativeLimit: number;
  /**
   * Where this walk stands: the position it is about to request, and the earlier
   * one it is watching for. The initial page has requested nothing, so it starts
   * at `null` rather than at a cursor the walk never used.
   */
  let position: SentryCursorWalkV1 | null = null;

  if (input.page.kind === 'initial') {
    scanLimit = input.page.scanLimit;
    nativeLimit = resolveSentryNativeLimit(scanLimit);
  } else {
    const decoded = decodeSentryScanContinuation(input.page.token);
    if (!decoded.ok) {
      return failedResult(Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_FAILURE_CODES.responseUnparseable,
      }));
    }
    scanLimit = decoded.continuation.scanLimit;
    nativeLimit = decoded.continuation.nativeLimit;
    position = {
      cursor: decoded.continuation.cursor,
      probe: decoded.continuation.probe,
    };
  }

  let url: string;
  try {
    url = buildSentryScanIssuesUrl({
      instance: input.configured,
      nativeLimit,
      ...(position === null ? {} : { cursor: position.cursor }),
    });
  } catch {
    return failedResult(Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.responseUnparseable,
    }));
  }

  const outcome = await input.client.request({ url, operation: 'issuesList' });
  if (outcome.kind === 'failed') return failedResult(outcome.failure);

  const { response } = outcome;
  if (response.status !== 200) {
    // The page is not applied; the continuation is discarded and a later
    // view-driven scan starts from the initial request.
    return failedResult(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: input.nowMs,
      response,
    }));
  }

  if (hasSentryDirectHitMarker(response.headers)) {
    // `scan` never sends `shortIdLookup`, so a direct hit can only mean the
    // request was not the one this source built.
    return failedResult(Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.directHitInScan,
    }));
  }

  let rows: unknown;
  try {
    rows = JSON.parse(response.bodyText);
  } catch {
    return failedResult(classifySentryFailure({ kind: 'unparseable', operation: 'issuesList' }));
  }
  if (!Array.isArray(rows)) {
    return failedResult(classifySentryFailure({ kind: 'unparseable', operation: 'issuesList' }));
  }

  // A duplicate row is expected on a live mutating keyset: the last occurrence
  // in this bounded response wins rather than being applied twice.
  const byEntryId = new Map<string, SentryIssueSnapshotV1>();
  let omittedItemCount = 0;
  for (const raw of rows) {
    const mapped = mapSentryIssueForInvokedInstance({
      raw,
      configured: input.configured,
      requestUrl: url,
      organizationSlug: input.organizationSlug,
    });
    if (!mapped.ok) {
      if (mapped.reason === 'scope-mismatch') return failedResult(mapped.failure);
      omittedItemCount += 1;
      continue;
    }
    byEntryId.delete(mapped.snapshot.localRef.entryId);
    byEntryId.set(mapped.snapshot.localRef.entryId, mapped.snapshot);
  }
  const observations = Object.freeze([...byEntryId.values()]);

  const rowHealth = omittedItemCount > 0
    ? sentryPartialHealth(SENTRY_FAILURE_CODES.malformedIssueRow, omittedItemCount)
    : null;

  const page = (
    health: SentryScanHealthV1 | null,
    continuation: string | null,
  ): SentryScanPageResultV1 => Object.freeze({
    kind: 'page' as const,
    observations,
    health,
    continuation,
  });

  const link = parseSentryLinkHeader(response.headers);
  if (!link.present) {
    return page(sentryPartialHealth(SENTRY_FAILURE_CODES.paginationHeaderAbsent), null);
  }

  const next = link.next;
  if (next === null || !next.hasResults) {
    return page(rowHealth ?? SENTRY_WALK_FINISHED, null);
  }
  if (next.cursor === null || next.cursor === '') {
    return page(sentryPartialHealth(SENTRY_FAILURE_CODES.paginationCursorMalformed), null);
  }
  // Non-progress is "this walk has been here already", not merely "this page
  // pointed at itself". The shared cycle owner watches both the position that
  // produced this response and one earlier saved position, so the one-step
  // repeat and an `A → B → A` alternation — invisible to a comparison that can
  // only see the current request — are both caught, without an evidence record
  // that grows with the walk.
  const advanced = advanceSentryCursorWalk(position, next.cursor);
  if (advanced.kind === 'revisited') {
    return page(sentryPartialHealth(SENTRY_FAILURE_CODES.paginationCursorNotAdvancing), null);
  }

  const continuation = encodeSentryScanContinuation({
    v: 1,
    scanLimit,
    nativeLimit,
    cursor: advanced.walk.cursor,
    probe: advanced.walk.probe,
    query: SENTRY_SCAN_QUERY,
    statsPeriod: '90d',
    sort: SENTRY_SCAN_SORT,
  });
  if (continuation === null) {
    // The walk is open and the cursor is intact; the frontier simply does not
    // fit the bounded token, so this page is the last one this pass can hand
    // back. Saying `cursor-malformed` here would blame the provider for a bound
    // this side owns, and it outranks the row caveat because it is the reason
    // the walk stops.
    return page(sentryPartialHealth(SENTRY_CONTINUATION_UNAVAILABLE_REASON), null);
  }

  return page(rowHealth, continuation);
}
