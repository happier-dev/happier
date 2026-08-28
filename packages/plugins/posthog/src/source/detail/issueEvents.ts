/**
 * The bounded sampled-occurrence read.
 *
 * PostHog cannot enumerate an issue's events: `query/issue_events/` returns a provider
 * *sample* capped at twenty rows per page, so every consumer of this module must present
 * its rows as a sample and never as the issue's events.
 *
 * Like the scan request, this builder sends every narrowing input explicitly. Two
 * provider defaults would otherwise change what a reader sees without saying so:
 * `include` defaults to a set that omits `stacktrace` (so frames would silently be
 * absent), and `onlyAppFrames` defaults to `true` (so the vendor frames the Stack Trace
 * panel lets a reader disclose would silently be dropped). Neither `code_variables` nor
 * `environment`, `release`, or `diagnostics` is ever requested here: code variables are
 * Tier-3 data with their own explicit, confirmed, single-row path, and the other three
 * carry content no view in this source reads.
 *
 * The returned page carries the exact request that produced it. That frozen geometry —
 * not the response bytes — is what a later selected-occurrence reread reproduces before
 * its exact-UUID equality gate.
 */

import type { PosthogApiClient, PosthogRequestOptions, PosthogResult } from '../../api/client.js';
import { errorTrackingIssueEventsQueryPath, resolvePosthogTeamRouteId } from '../../api/paths.js';
import {
    POSTHOG_WALK_EXHAUSTED,
    POSTHOG_WALK_STOPPED_SHORT,
    type PosthogPageWalkV1,
} from './pageWalk.js';
import {
    POSTHOG_ISSUE_EVENTS_INCLUDE,
    POSTHOG_ISSUE_EVENTS_MAX_LIMIT,
    parsePosthogIssueEventsEnvelope,
} from '../../api/types/events.js';
import {
    projectPosthogIssueEvents,
    type PosthogProjectedIssueEvent,
} from '../../ui/detail/issueEventProjection.js';
import type { PosthogResolvedWindow } from '../scan/request.js';

/** The exact body this source sends; every field is stated, none is left to a default. */
export type PosthogIssueEventsQueryBody = Readonly<{
    issueId: string;
    dateRange: Readonly<{ date_from: string; date_to: string | null }>;
    filterTestAccounts: false;
    onlyAppFrames: false;
    include: typeof POSTHOG_ISSUE_EVENTS_INCLUDE;
    limit: number;
    offset: number;
}>;

export type PosthogSampledEventsInput = Readonly<{
    teamRouteId: number;
    issueId: string;
    /** The configured detail window, already resolved by the caller. */
    detailWindow: PosthogResolvedWindow;
    limit: number;
    offset: number;
}>;

export type PosthogSampledEventsPage = Readonly<{
    /** Sampled rows, already reduced to the published allowlist. */
    events: readonly PosthogProjectedIssueEvent[];
    /**
     * Provider rows this page could not read independently. They consumed the same page
     * budget an accepted row would have, so `events.length + omittedRowCount` is the
     * number of rows the provider actually returned.
     */
    omittedRowCount: number;
    /**
     * Where the sample walk stands. A provider that claims more rows without moving its
     * offset cannot be paged, so this page is the last one requested — but it is
     * `stoppedShort`, not `exhausted`: the provider said there was more.
     */
    walk: PosthogPageWalkV1;
    /** The exact request that produced this page. */
    request: PosthogIssueEventsQueryBody;
}>;

export function buildPosthogIssueEventsQueryBody(
    issueId: string,
    window: PosthogResolvedWindow,
    limit: number,
    offset: number,
): PosthogIssueEventsQueryBody {
    return {
        issueId,
        dateRange: { date_from: window.from, date_to: window.to },
        filterTestAccounts: false,
        onlyAppFrames: false,
        include: POSTHOG_ISSUE_EVENTS_INCLUDE,
        limit,
        offset,
    };
}

/** Clamps a requested page to the provider sample ceiling; `null` rejects the request. */
export function resolvePosthogSampledEventsLimit(requested: number): number | null {
    if (!Number.isSafeInteger(requested) || requested <= 0) {
        return null;
    }
    return Math.min(requested, POSTHOG_ISSUE_EVENTS_MAX_LIMIT);
}

export async function readPosthogSampledIssueEvents(
    client: PosthogApiClient,
    input: PosthogSampledEventsInput,
    options: PosthogRequestOptions,
): Promise<PosthogResult<PosthogSampledEventsPage>> {
    const route = resolvePosthogTeamRouteId(input.teamRouteId);
    if (!route.ok) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'teamRouteId' } };
    }
    const limit = resolvePosthogSampledEventsLimit(input.limit);
    if (limit === null) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'sampledEventsLimit' } };
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
        return { ok: false, failure: { kind: 'requestInvalid', at: 'sampledEventsOffset' } };
    }

    const request = buildPosthogIssueEventsQueryBody(
        input.issueId,
        input.detailWindow,
        limit,
        input.offset,
    );
    const page = await client.requestJson(
        {
            method: 'POST',
            path: errorTrackingIssueEventsQueryPath(route.teamRouteId),
            body: request,
        },
        parsePosthogIssueEventsEnvelope,
        options,
    );
    if (!page.ok) {
        return { ok: false, failure: page.failure };
    }

    const envelope = page.value;
    const acceptedRowCount = envelope.rawEvents.length;
    // Only the provider's own `hasMore: false` ends the sample. Everything else it
    // advertised is a position: usable when it strictly advances, and a stated gap when
    // it does not, because a stuck offset is a provider that still has rows this source
    // will not reach.
    const nextOffsetCandidate = envelope.hasMore
        ? envelope.nextOffset ?? input.offset + acceptedRowCount + envelope.skippedRowCount
        : null;
    const walk: PosthogPageWalkV1 = nextOffsetCandidate === null
        ? POSTHOG_WALK_EXHAUSTED
        : Number.isSafeInteger(nextOffsetCandidate) && nextOffsetCandidate > input.offset
            ? { kind: 'continues', position: nextOffsetCandidate }
            : POSTHOG_WALK_STOPPED_SHORT;

    return {
        ok: true,
        value: {
            events: projectPosthogIssueEvents(envelope.rawEvents),
            omittedRowCount: envelope.skippedRowCount,
            walk,
            request,
        },
    };
}
