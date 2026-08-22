/**
 * The four detail reads behind the Sentry detail body.
 *
 * `readSentryIssueProjection` is the only owner of the public issue HTTP request
 * for the detail body (`SENTRY.md` §4.3). It accepts a closed,
 * consumer-qualified projection and selects it **at the response parser**, so an
 * Overview caller can never retain a tag value or an activity record and a Tags
 * caller can never receive a broad issue object. The raw body stays inside this
 * call frame; only a boundary projection leaves it.
 *
 * The two paged reads follow Sentry's own cursor pagination, but only after
 * verifying it. A `Link` header's `rel="next"` is a provider-controlled absolute
 * URL: it can name another issue, another route, or the page just read. These
 * modules therefore never treat it as a position to request. They accept its
 * `cursor` only when the URL still addresses this exact route and the provider
 * itself says the page has results, and the caller then constructs the next
 * request. No provider URL crosses the Action boundary or reaches a panel.
 *
 * An absent `Link` ends the walk WITHOUT claiming the collection was exhausted,
 * and says which of those two happened: a page that ended the walk and a page
 * that stopped short of it are different answers, and a panel that cannot tell
 * them apart renders a truncated list exactly like a complete one.
 *
 * `readSentryEventProjection` is the fourth, and the only one that touches a whole
 * event body. It is the sole HTTP, parser and projection owner for both the
 * representative occurrence and an exact selected one, and what leaves it is only the
 * allow-listed projection (§7.2a, §8.3).
 */

import type {
  SentryApiClientV1,
  SentryApiResponseV1,
} from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { parseSentryLinkHeader } from '../api/sentryLinkHeader.js';
import {
  buildSentryIssueEventUrl,
  buildSentryIssueEventsUrl,
  buildSentryIssueUrl,
  buildSentryTagValuesUrl,
  type SentryEventSelectorV1,
} from '../api/sentryRoutes.js';
import { mapSentryIssueState } from '../entries/sentryIssueMapping.js';
import type { SentryInvokedInstanceV1 } from '../instances/sentryCollisionScope.js';
import {
  projectSentryEventForDisplay,
  type SentryEventProjectionV1,
} from '../privacy/sentryEventProjection.js';
import {
  SENTRY_FAILURE_CODES,
  type SentryFailureV1,
  type SentryOperationV1,
} from '../sentryContracts.js';
import type { SentryDetailIncompleteReasonV1 } from '../ui/detail/panelState.js';

import {
  SENTRY_DETAIL_BOUNDS_V1,
  projectSentryActivity,
  projectSentryEventRows,
  projectSentryIssueTags,
  projectSentryReleaseAssociation,
  projectSentryTagValueRows,
  type SentryActivityProjectionV1,
  type SentryProjectedEventRowV1,
  type SentryProjectedReleaseV1,
  type SentryProjectedTagV1,
  type SentryProjectedTagValueV1,
} from './detailProjection.js';

export type SentryDetailReadResultV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: SentryFailureV1 }>;

function failed<T>(failure: SentryFailureV1): SentryDetailReadResultV1<T> {
  return Object.freeze({ ok: false as const, failure });
}

function requestInvalid<T>(): SentryDetailReadResultV1<T> {
  return failed(Object.freeze({
    class: 'unsupportedContract' as const,
    code: SENTRY_FAILURE_CODES.responseUnparseable,
  }));
}

/**
 * Settles one response into a decoded body, or into the failure that response
 * actually is. A non-200 and an unreadable body are different facts and stay
 * different codes.
 */
function decodeBody(
  response: SentryApiResponseV1,
  operation: SentryOperationV1,
  nowMs: number,
): Readonly<{ ok: true; body: unknown }> | Readonly<{ ok: false; failure: SentryFailureV1 }> {
  if (response.status !== 200) {
    return Object.freeze({
      ok: false as const,
      failure: classifySentryFailure({ kind: 'status', operation, nowMs, response }),
    });
  }
  try {
    return Object.freeze({ ok: true as const, body: JSON.parse(response.bodyText) as unknown });
  } catch {
    return Object.freeze({
      ok: false as const,
      failure: classifySentryFailure({ kind: 'unparseable', operation }),
    });
  }
}

/**
 * Where a detail walk stands after one page: continuing, genuinely finished, or
 * stopped short of the collection with the reason it stopped.
 *
 * The three outcomes were one `string | null` until it was measured: five
 * distinct situations — including an absent `Link` header, which is NOT a
 * finished walk — all collapsed into "no next cursor", and the panel then
 * rendered a truncated list exactly like a complete one. The reason names are
 * the SCAN plane's own (`scan/scanIssuesPage.ts`), because the same cursor means
 * the same thing on both planes.
 */
export type SentryNextPageV1 =
  | Readonly<{ kind: 'next'; cursor: string }>
  | Readonly<{ kind: 'end' }>
  | Readonly<{ kind: 'stoppedShort'; reason: SentryDetailIncompleteReasonV1 }>;

const WALK_END: SentryNextPageV1 = Object.freeze({ kind: 'end' as const });

function stoppedShort(reason: SentryDetailIncompleteReasonV1): SentryNextPageV1 {
  return Object.freeze({ kind: 'stoppedShort' as const, reason });
}

/**
 * Reads the provider's advertised next cursor, or states why this source will
 * not follow it.
 */
function verifyNextCursor(
  headers: Readonly<Record<string, string>>,
  expectedPath: string,
  requestedCursor: string | null,
): SentryNextPageV1 {
  const link = parseSentryLinkHeader(headers);
  // An absent header is not a finished walk, and it is also not a reason to
  // discard the rows already read. The walk stops and the panel says so.
  if (!link.present) return stoppedShort('paginationHeaderAbsent');
  const { next } = link;
  // No `next` relation, or one Sentry itself marks as carrying no further
  // results, is the provider stating the collection ended.
  if (next === null || !next.hasResults) return WALK_END;
  if (next.cursor === null || next.cursor === '') {
    return stoppedShort('paginationCursorMalformed');
  }
  // A next cursor equal to the one just requested does not advance; following
  // it would walk the same page forever.
  if (next.cursor === requestedCursor) return stoppedShort('paginationCursorNotAdvancing');
  let url: URL;
  try {
    url = new URL(next.url);
  } catch {
    return stoppedShort('paginationCursorMalformed');
  }
  return url.pathname === expectedPath
    ? Object.freeze({ kind: 'next' as const, cursor: next.cursor })
    : stoppedShort('paginationCursorMalformed');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCountText(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function readUserCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------ issue read */

/** The Tier-A live summary the detail root holds for every panel that needs it. */
export type SentryIssueOverviewProjectionV1 = Readonly<{
  kind: 'overview';
  nativeStateLabel?: string;
  statePresentation: 'active' | 'resolved' | 'suppressed' | 'closed' | 'unknown';
  eventCount?: string;
  userCount?: number;
  firstSeenAtMs?: number;
  lastSeenAtMs?: number;
  firstRelease?: SentryProjectedReleaseV1;
  lastRelease?: SentryProjectedReleaseV1;
}>;

export type SentryIssueTagsProjectionResultV1 = Readonly<{
  kind: 'tags';
  tags: readonly SentryProjectedTagV1[];
  omittedTagCount: number;
  projectionTruncated: boolean;
}>;

export type SentryIssueActivityProjectionResultV1 = Readonly<{
  kind: 'activity';
  activity: SentryActivityProjectionV1;
}>;

export type SentryIssueProjectionV1 =
  | SentryIssueOverviewProjectionV1
  | SentryIssueTagsProjectionResultV1
  | SentryIssueActivityProjectionResultV1;

export type SentryIssueProjectionKindV1 = SentryIssueProjectionV1['kind'];

export type SentryIssueReadInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  entryId: string;
  projection: SentryIssueProjectionKindV1;
  nowMs: number;
}>;

function projectIssueOverview(body: Readonly<Record<string, unknown>>): SentryIssueOverviewProjectionV1 {
  const state = mapSentryIssueState(body['status'], body['substatus']);
  const eventCount = readCountText(body['count']);
  const userCount = readUserCount(body['userCount']);
  const firstSeenAtMs = readTimestampMs(body['firstSeen']);
  const lastSeenAtMs = readTimestampMs(body['lastSeen']);
  const firstRelease = projectSentryReleaseAssociation(
    body['firstRelease'],
    SENTRY_DETAIL_BOUNDS_V1,
  );
  const lastRelease = projectSentryReleaseAssociation(
    body['lastRelease'],
    SENTRY_DETAIL_BOUNDS_V1,
  );
  return Object.freeze({
    kind: 'overview' as const,
    ...(state.nativeLabel === '' ? {} : { nativeStateLabel: state.nativeLabel }),
    statePresentation: state.presentation,
    ...(eventCount === null ? {} : { eventCount }),
    ...(userCount === null ? {} : { userCount }),
    ...(firstSeenAtMs === null ? {} : { firstSeenAtMs }),
    ...(lastSeenAtMs === null ? {} : { lastSeenAtMs }),
    ...(firstRelease === null ? {} : { firstRelease }),
    ...(lastRelease === null ? {} : { lastRelease }),
  });
}

export async function readSentryIssueProjection(
  client: SentryApiClientV1,
  input: SentryIssueReadInputV1,
): Promise<SentryDetailReadResultV1<SentryIssueProjectionV1>> {
  let url: string;
  try {
    url = buildSentryIssueUrl({ instance: input.instance, entryId: input.entryId });
  } catch {
    return requestInvalid();
  }

  const outcome = await client.request({ url, operation: 'issue' });
  if (outcome.kind === 'failed') return failed(outcome.failure);
  const decoded = decodeBody(outcome.response, 'issue', input.nowMs);
  if (!decoded.ok) return failed(decoded.failure);
  if (!isRecord(decoded.body)) {
    return failed(classifySentryFailure({ kind: 'unparseable', operation: 'issue' }));
  }
  const body = decoded.body;

  switch (input.projection) {
    case 'overview':
      return Object.freeze({ ok: true as const, value: projectIssueOverview(body) });
    case 'tags': {
      const tags = projectSentryIssueTags(body['tags'], SENTRY_DETAIL_BOUNDS_V1);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          kind: 'tags' as const,
          tags: tags.tags,
          omittedTagCount: tags.omittedTagCount,
          projectionTruncated: tags.projectionTruncated,
        }),
      });
    }
    case 'activity':
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          kind: 'activity' as const,
          activity: projectSentryActivity(body['activity'], SENTRY_DETAIL_BOUNDS_V1),
        }),
      });
  }
}

/* --------------------------------------------------------------- event page */

export type SentryEventsPageV1 = Readonly<{
  rows: readonly SentryProjectedEventRowV1[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  /** Where the walk stands: continuing, ended, or stopped short with its reason. */
  nextPage: SentryNextPageV1;
}>;

export type SentryEventsPageInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  entryId: string;
  limit: number;
  cursor: string | null;
  nowMs: number;
}>;

export async function readSentryIssueEventsPage(
  client: SentryApiClientV1,
  input: SentryEventsPageInputV1,
): Promise<SentryDetailReadResultV1<SentryEventsPageV1>> {
  let url: string;
  try {
    url = buildSentryIssueEventsUrl({
      instance: input.instance,
      entryId: input.entryId,
      perPage: input.limit,
      ...(input.cursor === null ? {} : { cursor: input.cursor }),
    });
  } catch {
    return requestInvalid();
  }

  const outcome = await client.request({ url, operation: 'issueEvents' });
  if (outcome.kind === 'failed') return failed(outcome.failure);
  const decoded = decodeBody(outcome.response, 'issueEvents', input.nowMs);
  if (!decoded.ok) return failed(decoded.failure);
  if (!Array.isArray(decoded.body)) {
    return failed(classifySentryFailure({ kind: 'unparseable', operation: 'issueEvents' }));
  }

  const projected = projectSentryEventRows(decoded.body, SENTRY_DETAIL_BOUNDS_V1);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      rows: projected.rows,
      omittedRowCount: projected.omittedRowCount,
      projectionTruncated: projected.projectionTruncated,
      nextPage: verifyNextCursor(outcome.response.headers, new URL(url).pathname, input.cursor),
    }),
  });
}

/* ----------------------------------------------------------- tag value page */

export type SentryTagValuesPageV1 = Readonly<{
  rows: readonly SentryProjectedTagValueV1[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  /** Where the walk stands: continuing, ended, or stopped short with its reason. */
  nextPage: SentryNextPageV1;
}>;

export type SentryTagValuesPageInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  entryId: string;
  tagKey: string;
  limit: number;
  cursor: string | null;
  nowMs: number;
}>;

export async function readSentryTagValuesPage(
  client: SentryApiClientV1,
  input: SentryTagValuesPageInputV1,
): Promise<SentryDetailReadResultV1<SentryTagValuesPageV1>> {
  let url: string;
  try {
    url = buildSentryTagValuesUrl({
      instance: input.instance,
      entryId: input.entryId,
      tagKey: input.tagKey,
      perPage: input.limit,
      ...(input.cursor === null ? {} : { cursor: input.cursor }),
    });
  } catch {
    return requestInvalid();
  }

  const outcome = await client.request({ url, operation: 'tagValues' });
  if (outcome.kind === 'failed') return failed(outcome.failure);
  const decoded = decodeBody(outcome.response, 'tagValues', input.nowMs);
  if (!decoded.ok) return failed(decoded.failure);
  if (!Array.isArray(decoded.body)) {
    return failed(classifySentryFailure({ kind: 'unparseable', operation: 'tagValues' }));
  }

  const projected = projectSentryTagValueRows(decoded.body, SENTRY_DETAIL_BOUNDS_V1);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      rows: projected.rows,
      omittedRowCount: projected.omittedRowCount,
      projectionTruncated: projected.projectionTruncated,
      nextPage: verifyNextCursor(outcome.response.headers, new URL(url).pathname, input.cursor),
    }),
  });
}

/* ------------------------------------------------------------ selected event */

export type SentryEventReadInputV1 = Readonly<{
  instance: SentryInvokedInstanceV1;
  entryId: string;
  selector: SentryEventSelectorV1;
  nowMs: number;
}>;

/**
 * The sole owner of the selected-event request, parse and projection.
 *
 * The raw body never leaves this call frame. It is decoded here, handed straight to
 * `projectSentryEventForDisplay`, and only the allow-listed projection is returned — so
 * a controller, a panel, a log line and an Action result all see the same bounded value
 * and none of them can reach past it (`SENTRY.md` §7.2a, §8.3).
 *
 * `llmFormat` is unrepresentable on this path: the route builds no query string at all,
 * so the additive prose rendering §8.5 refuses cannot be requested even by mistake.
 */
export async function readSentryEventProjection(
  client: SentryApiClientV1,
  input: SentryEventReadInputV1,
): Promise<SentryDetailReadResultV1<SentryEventProjectionV1>> {
  let url: string;
  try {
    url = buildSentryIssueEventUrl({
      instance: input.instance,
      entryId: input.entryId,
      selector: input.selector,
    });
  } catch {
    return requestInvalid();
  }

  const outcome = await client.request({ url, operation: 'event' });
  if (outcome.kind === 'failed') return failed(outcome.failure);
  const decoded = decodeBody(outcome.response, 'event', input.nowMs);
  if (!decoded.ok) return failed(decoded.failure);

  return Object.freeze({
    ok: true as const,
    value: projectSentryEventForDisplay(decoded.body),
  });
}
