/**
 * The source-native sampled-occurrence Action contract.
 *
 * The three sampled-data detail views run in a UI artifact that holds no credential and
 * speaks no HTTP, while `src/api/client.ts` is this source's sole credential reader. The
 * bridge between them is one source-owned Action, declared with the same public schema
 * builders the shared Triage contract uses. It carries no Triage role: it is a
 * PostHog-native read of PostHog-native content, and binding it to a shared role would
 * make the aggregate believe a sampled exception event is a Triage entry.
 *
 * Paging cannot be expressed as an offset alone. A relative configured detail window
 * resolves to absolute timestamps at read time, so a second page resolved afresh would
 * address a different result set than the offset was measured in. The frozen window
 * therefore travels with the page as an opaque source-minted continuation, exactly like
 * the scan's geometry: it lives only inside one detail session, is never persisted, is
 * never a watermark, and is discarded whenever the detail instance changes or the
 * surface unmounts.
 */

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageSourceEntryLocalRefV1Schema,
    TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

const definePosthogSampleString = (
    options: Parameters<typeof defineProtocolString>[0],
) => defineProtocolString({
    ...options,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

import {
    POSTHOG_ISSUE_EVENTS_INCLUDE,
    POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
} from '../../api/types/events.js';

/**
 * Why a sample walk stopped without reaching the end of what the provider offered.
 *
 * PostHog said `hasMore` and then named an offset this source will not request, because
 * it does not strictly advance. Reading it again would loop on the same rows, so the
 * walk stops — and this is the value that keeps stopping from reading as finishing.
 *
 * Exhaustion has no value here: a page with neither a continuation nor this field is
 * the provider's own `hasMore: false`.
 */
export const POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1 = 'posthog/sampled-offset-non-advancing';

export type PosthogSampleIncompleteV1 = typeof POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1;

const CONTINUATION_VERSION = 1;

const PosthogSampledBooleanSchema = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);

const PosthogProjectedFrameV1Schema = defineProtocolObject({
    function: definePosthogSampleString({ minLength: 1 }).optional(),
    source: definePosthogSampleString({ minLength: 1 }).optional(),
    line: defineProtocolNumber({ integer: true }).optional(),
    column: defineProtocolNumber({ integer: true }).optional(),
    inApp: PosthogSampledBooleanSchema.optional(),
}, { policy: 'closed' });

const PosthogProjectedExceptionV1Schema = defineProtocolObject({
    type: definePosthogSampleString({ minLength: 1 }).optional(),
    value: definePosthogSampleString({ minLength: 1 }).optional(),
    frames: defineProtocolArray(PosthogProjectedFrameV1Schema),
}, { policy: 'closed' });

/**
 * One published sampled event.
 *
 * Nested fields intentionally have no provider-invented size ledger. The final result
 * owner fits whole rows against the canonical serialized Action envelope.
 */
export const PosthogProjectedIssueEventV1Schema = defineProtocolObject({
    uuid: definePosthogSampleString({ minLength: 1 }),
    timestampMs: defineProtocolNumber({ integer: true }).optional(),
    sessionId: definePosthogSampleString({ minLength: 1 }).optional(),
    url: definePosthogSampleString({ minLength: 1 }).optional(),
    exceptions: defineProtocolArray(PosthogProjectedExceptionV1Schema),
}, { policy: 'closed' });

export const PosthogSampledEventsInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
    limit: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
    }),
    /** Present only for a following page, and only as this source minted it. */
    continuation: defineProtocolString({ minLength: 1 }).optional(),
}, { policy: 'closed' });
export type PosthogSampledEventsInputV1 = ReturnType<
    typeof PosthogSampledEventsInputV1Schema.parse
>;

/**
 * The non-sensitive geometry that produced one mounted sample page.
 *
 * The detail controller retains it only beside the rows that page produced, so a later
 * disclosure can name the exact frozen query without retaining provider response bytes.
 * Its explicit privacy filters travel with the dynamic request geometry; the bounded
 * Composer candidate compacts that known fixed profile and the canonical issue-events
 * builder remains the only code that reconstructs the provider body at resolution.
 */
export const PosthogFrozenIssueEventsRequestV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    issueId: definePosthogSampleString({ minLength: 1 }),
    from: definePosthogSampleString({ minLength: 1 }),
    to: defineProtocolUnion([
        defineProtocolLiteral(null),
        definePosthogSampleString({ minLength: 1 }),
    ]),
    filterTestAccounts: defineProtocolLiteral(false),
    onlyAppFrames: defineProtocolLiteral(false),
    include: defineProtocolArray(
        defineProtocolUnion([
            defineProtocolLiteral(POSTHOG_ISSUE_EVENTS_INCLUDE[0]),
            defineProtocolLiteral(POSTHOG_ISSUE_EVENTS_INCLUDE[1]),
            defineProtocolLiteral(POSTHOG_ISSUE_EVENTS_INCLUDE[2]),
            defineProtocolLiteral(POSTHOG_ISSUE_EVENTS_INCLUDE[3]),
        ]),
        {
            minItems: POSTHOG_ISSUE_EVENTS_INCLUDE.length,
            maxItems: POSTHOG_ISSUE_EVENTS_INCLUDE.length,
        },
    ),
    limit: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
    }),
    offset: defineProtocolNumber({ integer: true, minimum: 0 }),
}, { policy: 'closed' });
export type PosthogFrozenIssueEventsRequestV1 = ReturnType<
    typeof PosthogFrozenIssueEventsRequestV1Schema.parse
>;

export const PosthogSampledEventsResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('sampled'),
        events: defineProtocolArray(PosthogProjectedIssueEventV1Schema, {
            maxItems: POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
        }),
        /**
         * Provider rows this page could not read. They consumed the same page budget an
         * accepted row would have, so a reader can state what the page covered.
         */
        omittedRowCount: defineProtocolNumber({ integer: true, minimum: 0 }),
        /** Absent when this page ends the sample. */
        continuation: defineProtocolString({ minLength: 1 }).optional(),
        /**
         * Present only when the walk stopped short of what the provider offered. Absent
         * together with `continuation` is the provider's own end of the sample.
         */
        incomplete: defineProtocolLiteral(POSTHOG_SAMPLE_WALK_STOPPED_SHORT_V1).optional(),
        /**
         * Added as optional so a source detail paired with an older daemon still reads
         * samples normally; only the selected-evidence control stays unavailable.
         */
        frozenRequest: PosthogFrozenIssueEventsRequestV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type PosthogSampledEventsResultV1 = ReturnType<
    typeof PosthogSampledEventsResultV1Schema.parse
>;

/** The invocation-local paging frontier of one detail session's sample. */
export type PosthogSampledEventsFrontier = Readonly<{
    v: 1;
    from: string;
    to: string | null;
    offset: number;
    limit: number;
}>;

export function encodePosthogSampledEventsContinuation(
    frontier: PosthogSampledEventsFrontier,
): string | null {
    return JSON.stringify({
        v: CONTINUATION_VERSION,
        from: frontier.from,
        to: frontier.to,
        offset: frontier.offset,
        limit: frontier.limit,
    });
}

/**
 * Decodes a continuation this source minted. Anything else — another version, a missing
 * window, a negative offset, a page size the provider cannot serve — is rejected, and the
 * caller starts the sample again from its first page rather than guessing a position.
 */
export function decodePosthogSampledEventsContinuation(
    token: string,
): PosthogSampledEventsFrontier | null {
    let decoded: unknown;
    try {
        decoded = JSON.parse(token);
    } catch {
        return null;
    }
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        return null;
    }
    const raw = decoded as Readonly<Record<string, unknown>>;
    const from = raw['from'];
    const to = raw['to'];
    const offset = raw['offset'];
    const limit = raw['limit'];
    if (
        raw['v'] !== CONTINUATION_VERSION
        || typeof from !== 'string'
        || from.length === 0
        || (to !== null && typeof to !== 'string')
        || typeof offset !== 'number'
        || !Number.isSafeInteger(offset)
        || offset < 0
        || typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit <= 0
        || limit > POSTHOG_ISSUE_EVENTS_MAX_LIMIT
    ) {
        return null;
    }
    return { v: 1, from, to, offset, limit };
}
