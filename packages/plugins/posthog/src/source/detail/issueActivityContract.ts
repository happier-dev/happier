/**
 * The source-native issue-activity Action contract.
 *
 * The Activity panel runs in a UI artifact that holds no credential and speaks no HTTP,
 * while `src/api/client.ts` is this source's sole credential reader. The bridge between
 * them is one source-owned Action, declared with the same public schema builders the
 * shared Triage contract uses. It carries no Triage role: an activity record is
 * PostHog-native content the detail body reads, not a Triage entry the aggregate can
 * hold.
 *
 * Its continuation is a page position this source mints, exactly like the sampled read's
 * frozen geometry. The provider's own `next` URL never crosses this boundary: it is
 * verified and reduced to a page number by `issueActivity.ts`, so the panel can neither
 * request a provider-chosen URL nor carry one in state. The token lives only inside one
 * mounted Activity panel, is never persisted, and is never a watermark.
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

const definePosthogActivityString = (
    options: Parameters<typeof defineProtocolString>[0],
) => defineProtocolString({
    ...options,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

import { POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT } from '../../ui/detail/activityProjection.js';

/**
 * Why an Activity walk stopped without reaching the end of the collection.
 *
 * It is one value because the provider deviations that produce it are one fact for a
 * reader: PostHog stated another page of activity, and this build would not request it —
 * because the `next` it named does not address this exact route, does not parse, or does
 * not strictly advance. Naming each deviation separately would publish provider
 * internals a reader cannot act on, and it is not a failure: the rows on screen are
 * real and the page succeeded.
 *
 * Exhaustion has NO value here. A page with neither a continuation nor this field is the
 * provider's own statement that there is nothing further.
 */
export const POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1 = 'posthog/activity-next-unverifiable';

export type PosthogActivityIncompleteV1 = typeof POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1;

const CONTINUATION_VERSION = 1;

const PosthogActivityBooleanSchema = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);

/**
 * One published activity record.
 *
 * Provider text is normalized to the shared single-line rule before publication. No
 * source-local byte or changed-field count limit is invented here.
 */
export const PosthogProjectedActivityRecordV1Schema = defineProtocolObject({
    id: definePosthogActivityString({ minLength: 1 }),
    activity: definePosthogActivityString({ minLength: 1 }),
    scope: definePosthogActivityString({ minLength: 1 }).optional(),
    atMs: defineProtocolNumber({ integer: true }).optional(),
    actor: definePosthogActivityString({ minLength: 1 }).optional(),
    isSystem: PosthogActivityBooleanSchema,
    changedFields: defineProtocolArray(definePosthogActivityString({ minLength: 1 })),
}, { policy: 'closed' });

export const PosthogIssueActivityInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
    limit: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT,
    }),
    /** Present only for a following page, and only as this source minted it. */
    continuation: defineProtocolString({ minLength: 1 }).optional(),
}, { policy: 'closed' });
export type PosthogIssueActivityInputV1 = ReturnType<
    typeof PosthogIssueActivityInputV1Schema.parse
>;

export const PosthogIssueActivityResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('activity'),
        records: defineProtocolArray(PosthogProjectedActivityRecordV1Schema, {
            maxItems: POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT,
        }),
        /**
         * Provider rows this page could not read. They consumed the same page budget an
         * accepted row would have, so a reader can state what the page covered.
         */
        omittedRowCount: defineProtocolNumber({ integer: true, minimum: 0 }),
        /** The provider's stated total, absent when it stated none. */
        totalCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
        /** Absent when this page ends the walk. */
        continuation: defineProtocolString({ minLength: 1 }).optional(),
        /**
         * Present only when the walk stopped short of the whole collection. Absent
         * together with `continuation` is exhaustion; present without one is a list
         * that stops here and says why.
         */
        incomplete: defineProtocolLiteral(POSTHOG_ACTIVITY_WALK_STOPPED_SHORT_V1).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type PosthogIssueActivityResultV1 = ReturnType<
    typeof PosthogIssueActivityResultV1Schema.parse
>;

/** The invocation-local paging position of one mounted Activity panel. */
export type PosthogIssueActivityFrontier = Readonly<{
    v: 1;
    page: number;
    limit: number;
}>;

export function encodePosthogIssueActivityContinuation(
    frontier: PosthogIssueActivityFrontier,
): string | null {
    return JSON.stringify({
        v: CONTINUATION_VERSION,
        page: frontier.page,
        limit: frontier.limit,
    });
}

/**
 * Decodes a continuation this source minted. Anything else — another version, a page
 * before the first, a page size the source will not request — is rejected, and the
 * caller starts the walk again from page one rather than guessing a position.
 */
export function decodePosthogIssueActivityContinuation(
    token: string,
): PosthogIssueActivityFrontier | null {
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
    const page = raw['page'];
    const limit = raw['limit'];
    if (
        raw['v'] !== CONTINUATION_VERSION
        || typeof page !== 'number'
        || !Number.isSafeInteger(page)
        || page < 1
        || typeof limit !== 'number'
        || !Number.isSafeInteger(limit)
        || limit <= 0
        || limit > POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT
    ) {
        return null;
    }
    return { v: 1, page, limit };
}
