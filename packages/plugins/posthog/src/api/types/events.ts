/**
 * Strict parser for PostHog's sampled exception events.
 *
 * `ErrorTrackingEvent.properties` is an open, customer-controlled bag: the published
 * schema declares it `additionalProperties: true`, so it can contain arbitrary personal
 * data. This parser therefore reads the envelope and hands each raw row to the boundary
 * projector, which is the only code allowed to decide what leaves this module. Nothing
 * here retains a raw properties bag.
 *
 * These events are explicitly sampled by the provider (page size caps at 20) and cannot
 * be enumerated. Callers must present them as a sample, never as an issue's events.
 */

import { readObject, readString, readTimestampMs } from './primitives.js';

/** Provider page-size ceiling for `query/issue_events/`, from the published schema. */
export const POSTHOG_ISSUE_EVENTS_MAX_LIMIT = 20;

/**
 * The exact context groups the source requests. It is the union required by the
 * Occurrences, Stack Trace, and Affected Sessions consumers: exception values, frames,
 * URL/permalink inputs, and `$session_id`.
 *
 * The provider's own default is `exception, environment, navigation, correlation` — it
 * does NOT include `stacktrace`, so relying on the default would silently yield no
 * frames. The source sends this set explicitly and asks for neither `environment`,
 * `release`, `diagnostics`, nor `code_variables`.
 */
export const POSTHOG_ISSUE_EVENTS_INCLUDE = [
    'exception',
    'stacktrace',
    'navigation',
    'correlation',
] as const;

/** True only for the one explicit include policy this source ships. */
export function isPosthogIssueEventsInclude(
    value: readonly string[],
): value is typeof POSTHOG_ISSUE_EVENTS_INCLUDE {
    return value.length === POSTHOG_ISSUE_EVENTS_INCLUDE.length
        && value.every((entry, index) => entry === POSTHOG_ISSUE_EVENTS_INCLUDE[index]);
}

/** One raw sampled event, still carrying its unbounded provider properties bag. */
export type PosthogRawIssueEvent = Readonly<{
    uuid: string;
    timestampMs?: number;
    rawProperties: Readonly<Record<string, unknown>>;
}>;

export type PosthogIssueEventsEnvelope = Readonly<{
    rawEvents: readonly PosthogRawIssueEvent[];
    skippedRowCount: number;
    hasMore: boolean;
    limit: number;
    offset: number;
    nextOffset?: number;
}>;

function parseRawEvent(value: unknown): PosthogRawIssueEvent | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const uuid = readString(raw['uuid']);
    if (uuid === null || uuid.trim().length === 0) {
        return null;
    }
    const timestampMs = readTimestampMs(raw['timestamp']);
    const rawProperties = readObject(raw['properties']) ?? {};
    return {
        uuid: uuid.trim(),
        ...(timestampMs === null ? {} : { timestampMs }),
        rawProperties,
    };
}

export function parsePosthogIssueEventsEnvelope(
    value: unknown,
): PosthogIssueEventsEnvelope | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const results = raw['results'];
    const hasMore = raw['hasMore'];
    const limit = raw['limit'];
    const offset = raw['offset'];
    if (
        !Array.isArray(results)
        || typeof hasMore !== 'boolean'
        || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0
        || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    ) {
        return null;
    }
    const rawEvents: PosthogRawIssueEvent[] = [];
    let skippedRowCount = 0;
    for (const rawRow of results) {
        const event = parseRawEvent(rawRow);
        if (event === null) {
            skippedRowCount += 1;
            continue;
        }
        rawEvents.push(event);
    }
    const nextOffsetRaw = raw['nextOffset'];
    const nextOffset = typeof nextOffsetRaw === 'number' && Number.isSafeInteger(nextOffsetRaw)
        ? nextOffsetRaw
        : null;
    if (nextOffsetRaw !== undefined && nextOffsetRaw !== null && nextOffset === null) {
        return null;
    }
    return {
        rawEvents,
        skippedRowCount,
        hasMore,
        limit,
        offset,
        ...(nextOffset === null ? {} : { nextOffset }),
    };
}
