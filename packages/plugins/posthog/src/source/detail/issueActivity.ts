/**
 * The item-scoped issue activity read.
 *
 * PostHog's activity route is page-numbered rather than offset- or cursor-paged, and it
 * needs a scope no other route in this source needs: `activity_log:read`. An account
 * that reads every issue here can still be refused this page, so a failure from this
 * module is a first-class visible outcome rather than something to fold into an empty
 * result.
 *
 * Paging follows the provider's own `next`, but only after this module has verified it.
 * `next` is a provider-controlled absolute URL: it can name another issue, another
 * route, or the page just read. This module therefore never treats it as a position to
 * request. It reads a page number out of it only when the URL still addresses this exact
 * route and strictly advances, and the caller then constructs the next request itself, so
 * no provider-supplied URL is ever requested under this issue's name.
 */

import type { PosthogApiClient, PosthogRequestOptions, PosthogResult } from '../../api/client.js';
import { errorTrackingIssueActivityPath, resolvePosthogTeamRouteId } from '../../api/paths.js';
import { parsePosthogIssueActivityEnvelope } from '../../api/types/activity.js';
import {
    POSTHOG_ACTIVITY_BOUNDS_V1,
    POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT,
    projectPosthogActivityRecords,
    type PosthogProjectedActivityRecord,
} from '../../ui/detail/activityProjection.js';

export type PosthogIssueActivityInput = Readonly<{
    teamRouteId: number;
    issueId: string;
    limit: number;
    /** One-based, exactly as the provider's own paging states it. */
    page: number;
}>;

export type PosthogIssueActivityPage = Readonly<{
    /** Activity rows, already reduced to the published allowlist. */
    records: readonly PosthogProjectedActivityRecord[];
    /**
     * Provider rows this page returned but could not be read. They consumed the same page
     * budget an accepted row would have, so a reader can state what the page covered.
     */
    omittedRowCount: number;
    /** The provider's stated total, or `null` when it stated none. */
    totalCount: number | null;
    /** The verified next page, or `null` when this source will not walk further. */
    nextPage: number | null;
}>;

/** `null` rejects a page size this source will not ask the provider for. */
export function resolvePosthogIssueActivityLimit(requested: number): number | null {
    if (!Number.isSafeInteger(requested)
        || requested <= 0
        || requested > POSTHOG_ISSUE_ACTIVITY_MAX_LIMIT) {
        return null;
    }
    return requested;
}

/**
 * Reads the provider's advertised next page number, or `null` when this source will not
 * follow it.
 */
function verifyNextPage(next: string | null, path: string, page: number): number | null {
    if (next === null || next.trim().length === 0) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(next);
    } catch {
        return null;
    }
    if (url.pathname !== path) {
        return null;
    }
    const raw = url.searchParams.get('page');
    if (raw === null || !/^\d+$/u.test(raw)) {
        return null;
    }
    const nextPage = Number.parseInt(raw, 10);
    return Number.isSafeInteger(nextPage) && nextPage > page ? nextPage : null;
}

export async function readPosthogIssueActivity(
    client: PosthogApiClient,
    input: PosthogIssueActivityInput,
    options: PosthogRequestOptions,
): Promise<PosthogResult<PosthogIssueActivityPage>> {
    const route = resolvePosthogTeamRouteId(input.teamRouteId);
    if (!route.ok) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'teamRouteId' } };
    }
    const limit = resolvePosthogIssueActivityLimit(input.limit);
    if (limit === null) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'issueActivityLimit' } };
    }
    if (!Number.isSafeInteger(input.page) || input.page < 1) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'issueActivityPage' } };
    }

    const path = errorTrackingIssueActivityPath(route.teamRouteId, input.issueId);
    const page = await client.requestJson(
        {
            method: 'GET',
            path,
            query: { limit: String(limit), page: String(input.page) },
        },
        parsePosthogIssueActivityEnvelope,
        options,
    );
    if (!page.ok) {
        return { ok: false, failure: page.failure };
    }

    const envelope = page.value;
    return {
        ok: true,
        value: {
            records: projectPosthogActivityRecords(
                envelope.rawRecords,
                POSTHOG_ACTIVITY_BOUNDS_V1,
            ),
            omittedRowCount: envelope.skippedRowCount,
            totalCount: envelope.totalCount,
            nextPage: verifyNextPage(envelope.next, path, input.page),
        },
    };
}
