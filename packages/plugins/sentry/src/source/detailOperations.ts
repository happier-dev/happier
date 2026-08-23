/**
 * The four bound source-native detail operations.
 *
 * Each is the whole vertical for one Action invocation: it validates the
 * published input, admits the ref against the exact configured instance through
 * the same rule `get` uses, materializes that exact account inside one request
 * closure, and shapes the result into the published contract. It owns no
 * registry, cache or second route authority, and it writes no configured state.
 *
 * The detail body invokes these; it never holds a credential, constructs a URL,
 * or sees a raw provider body. What crosses back is only what the boundary
 * projector copied.
 *
 * Every failure is a **stated** outcome rather than an empty result. A tags read
 * refused for permission, an activity field that could not be parsed, and an
 * issue with no activity at all are three different answers, and each panel is
 * given the one that is true.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { createSentryApiClient } from '../api/sentryApiClient.js';
import type { SentryCursorWalkV1 } from '../api/sentryCursorCycle.js';
import { boundSentryInvocation } from '../api/sentryInvocationDeadline.js';
import { SENTRY_FAILURE_CODES } from '../sentryContracts.js';
import {
  SentryIssueEventsInputV1Schema,
  SentryReadEventInputV1Schema,
  SentryReadIssueInputV1Schema,
  SentryTagValuesInputV1Schema,
  decodeSentryDetailContinuation,
  encodeSentryDetailContinuation,
  type SentryIssueEventsResultV1,
  type SentryReadEventResultV1,
  type SentryReadIssueResultV1,
  type SentryTagValuesResultV1,
} from '../detail/detailContracts.js';
import {
  readSentryEventProjection,
  readSentryIssueEventsPage,
  readSentryIssueProjection,
  readSentryTagValuesPage,
  type SentryNextPageV1,
} from '../detail/detailReads.js';
import type { SentryDetailIncompleteReasonV1 } from '../ui/detail/panelState.js';

import { toTriageFailure } from './observation.js';
import { admitSentryEntryInvocation } from './operations.js';

const CONTINUATION_UNREADABLE = Object.freeze({
  class: 'unsupportedContract' as const,
  code: SENTRY_FAILURE_CODES.paginationCursorMalformed,
});

/**
 * How long one mounted detail read may take before this source stops waiting.
 *
 * The resource it protects is a panel a person is looking at. `CONTRACT.md` §5.2
 * puts that bound on the source: Triage owns deadlines only for the
 * `listInstances`, `scan` and `get` invocations it starts, and it neither
 * supplies nor decides this one. Without it a Sentry that accepts the connection
 * and never answers leaves the tab in its loading state until the mount is torn
 * down, which the reader cannot retry, report, or tell apart from a slow read.
 */
export const SENTRY_MOUNTED_DETAIL_DEADLINE_MS = 20_000;

/**
 * Resolves the position one paged detail read starts from.
 *
 * A rejected token restarts the walk at the first page rather than requesting a
 * position nobody can vouch for — and because the token carries the walk's own
 * cycle evidence, restarting also restarts that evidence rather than resuming a
 * walk with a probe it cannot vouch for either.
 */
function resolveWalkPosition(
  continuation: string | undefined,
  limit: number,
): Readonly<{ ok: true; position: SentryCursorWalkV1 | null }> | Readonly<{ ok: false }> {
  if (continuation === undefined) {
    return Object.freeze({ ok: true as const, position: null });
  }
  const frontier = decodeSentryDetailContinuation(continuation);
  if (frontier === null || frontier.limit !== limit) return Object.freeze({ ok: false as const });
  return Object.freeze({
    ok: true as const,
    position: Object.freeze({ cursor: frontier.cursor, probe: frontier.probe }),
  });
}

/**
 * Projects one walk position into the two published members the panel reads.
 *
 * They are deliberately separate: a continuation says "there is more, ask for
 * it", while `incomplete` says "this walk stopped without reaching the end". A
 * page that ends the walk carries neither. Folding the second into the absence
 * of the first is what let a truncated list render as a complete one.
 */
function projectWalkPosition(
  nextPage: SentryNextPageV1,
  limit: number,
): Readonly<{ continuation?: string; incomplete?: SentryDetailIncompleteReasonV1 }> {
  if (nextPage.kind === 'stoppedShort') return { incomplete: nextPage.reason };
  if (nextPage.kind === 'end') return {};
  const continuation = encodeSentryDetailContinuation({
    v: 1,
    cursor: nextPage.walk.cursor,
    limit,
    probe: nextPage.walk.probe,
  });
  // The walk is open and the provider's cursor is intact; the frontier simply
  // does not fit the bounded token, so this page is the last one this panel can
  // ask for. Calling that a malformed cursor would blame the provider for a
  // bound this side owns.
  return continuation === null
    ? { incomplete: 'continuationUnavailable' as const }
    : { continuation };
}

/**
 * One public issue read, projected to exactly the arm the caller named.
 *
 * The arms differ in lifetime and privacy tier, not in the request: `overview`
 * is the Tier-A summary the detail root holds, while `tags` and `activity` are
 * Tier-B content that exists only inside the panel that asked for it.
 */
export async function readSentryIssue(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryReadIssueResultV1> {
  const parsed = SentryReadIssueInputV1Schema.parse(input);

  const routed = admitSentryEntryInvocation({
    localInstanceKey: parsed.instance.localInstanceKey,
    configurationToken: parsed.instance.configuration.token,
    localRef: parsed.localRef,
  });
  if (!routed.ok) {
    return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
  }

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
    signal: boundSentryInvocation(context.signal, SENTRY_MOUNTED_DETAIL_DEADLINE_MS),
  });
  const read = await readSentryIssueProjection(client, {
    instance: routed.instance,
    entryId: parsed.localRef.entryId,
    projection: parsed.projection,
    nowMs: Date.now(),
  });
  if (!read.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(read.failure),
    });
  }
  return read.value;
}

/** One bounded page of the retained events for one issue. */
export async function listSentryIssueEvents(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryIssueEventsResultV1> {
  const parsed = SentryIssueEventsInputV1Schema.parse(input);

  const routed = admitSentryEntryInvocation({
    localInstanceKey: parsed.instance.localInstanceKey,
    configurationToken: parsed.instance.configuration.token,
    localRef: parsed.localRef,
  });
  if (!routed.ok) {
    return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
  }

  const walk = resolveWalkPosition(parsed.continuation, parsed.limit);
  if (!walk.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(CONTINUATION_UNREADABLE),
    });
  }

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
    signal: boundSentryInvocation(context.signal, SENTRY_MOUNTED_DETAIL_DEADLINE_MS),
  });
  const page = await readSentryIssueEventsPage(client, {
    instance: routed.instance,
    entryId: parsed.localRef.entryId,
    limit: parsed.limit,
    position: walk.position,
    nowMs: Date.now(),
  });
  if (!page.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(page.failure),
    });
  }

  return Object.freeze({
    kind: 'events' as const,
    rows: page.value.rows,
    omittedRowCount: page.value.omittedRowCount,
    projectionTruncated: page.value.projectionTruncated,
    ...projectWalkPosition(page.value.nextPage, parsed.limit),
  });
}

/** One bounded page of the value distribution of a single tag key. */
export async function listSentryTagValues(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryTagValuesResultV1> {
  const parsed = SentryTagValuesInputV1Schema.parse(input);

  const routed = admitSentryEntryInvocation({
    localInstanceKey: parsed.instance.localInstanceKey,
    configurationToken: parsed.instance.configuration.token,
    localRef: parsed.localRef,
  });
  if (!routed.ok) {
    return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
  }

  const walk = resolveWalkPosition(parsed.continuation, parsed.limit);
  if (!walk.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(CONTINUATION_UNREADABLE),
    });
  }

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
    signal: boundSentryInvocation(context.signal, SENTRY_MOUNTED_DETAIL_DEADLINE_MS),
  });
  const page = await readSentryTagValuesPage(client, {
    instance: routed.instance,
    entryId: parsed.localRef.entryId,
    tagKey: parsed.tagKey,
    limit: parsed.limit,
    position: walk.position,
    nowMs: Date.now(),
  });
  if (!page.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(page.failure),
    });
  }

  return Object.freeze({
    kind: 'tagValues' as const,
    tagKey: parsed.tagKey,
    rows: page.value.rows,
    omittedRowCount: page.value.omittedRowCount,
    projectionTruncated: page.value.projectionTruncated,
    ...projectWalkPosition(page.value.nextPage, parsed.limit),
  });
}

/**
 * One occurrence of one issue, projected through the redaction owner.
 *
 * It is the only operation that touches a whole event body, and the only one whose
 * result carries Tier-B/C content. Its lifetime belongs to the detail-root selected-event
 * controller, not to a panel: Overview, an explicitly revealed occurrence detail and
 * Stack Trace all read this one projection, so the exact detail instance rather than a
 * tab mount is the privacy boundary (`SENTRY.md` §7.2a).
 */
export async function readSentryEvent(
  input: unknown,
  context: PluginInvocationContext,
): Promise<SentryReadEventResultV1> {
  const parsed = SentryReadEventInputV1Schema.parse(input);

  const routed = admitSentryEntryInvocation({
    localInstanceKey: parsed.instance.localInstanceKey,
    configurationToken: parsed.instance.configuration.token,
    localRef: parsed.localRef,
  });
  if (!routed.ok) {
    return Object.freeze({ kind: 'unavailable' as const, failure: routed.failure });
  }

  const client = await createSentryApiClient(context, {
    account: parsed.instance.binding.account,
    deployment: routed.deployment,
    nowMs: () => Date.now(),
    signal: boundSentryInvocation(context.signal, SENTRY_MOUNTED_DETAIL_DEADLINE_MS),
  });
  const read = await readSentryEventProjection(client, {
    instance: routed.instance,
    entryId: parsed.localRef.entryId,
    selector: parsed.selector,
    nowMs: Date.now(),
  });
  if (!read.ok) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: toTriageFailure(read.failure),
    });
  }
  return Object.freeze({ kind: 'event' as const, projection: read.value });
}
