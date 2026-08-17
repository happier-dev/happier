/**
 * One PostHog issues page.
 *
 * This module owns exactly one decision: what a single `query/issues/` page means. One
 * requested scan invocation issues one provider request and returns one bounded page;
 * the walk across the selected environments and their offsets belongs to the bound scan
 * operation in `../operations.ts`, which carries the frozen geometry back inside its
 * opaque, process-local continuation. There is deliberately no second whole-window walk
 * beside this function: two implementations of the same paging decision are how a source
 * drifts into two answers for the same question.
 *
 * Nothing here is serialized, persisted, or treated as a watermark. PostHog exposes no
 * issue change-watermark, so a retained offset would be a position in a result set that
 * has already moved. The page owner never waits, retries, or sleeps.
 */

import type { PosthogApiClient, PosthogRequestOptions } from '../../api/client.js';
import type { PosthogFailure } from '../../api/errors.js';
import { errorTrackingIssuesQueryPath, resolvePosthogTeamRouteId } from '../../api/paths.js';
import {
    parsePosthogIssueRow,
    parsePosthogQueryEnvelope,
    type PosthogIssueRow,
} from '../../api/types/issues.js';
import type { PosthogApiOrigin } from '../../connect/origin.js';
import { buildPosthogEntryLocator, type PosthogEntryLocator } from '../identity.js';
import {
    buildPosthogIssuesQueryBody,
    type PosthogResolvedWindow,
} from './request.js';

export type PosthogScanEnvironment = Readonly<{
    teamRouteId: number;
    teamUuid: string;
}>;

export type PosthogIssueObservation = Readonly<{
    locator: PosthogEntryLocator;
    row: PosthogIssueRow;
}>;

/** One accepted provider page: its parsed rows plus the geometry of what follows. */
export type PosthogScanPageOutcome =
    | Readonly<{
        ok: true;
        observations: readonly PosthogIssueObservation[];
        /** Rows the provider returned that could not be parsed independently. */
        malformedRowCount: number;
        /** The provider's own claim that more rows exist behind this page. */
        hasMore: boolean;
        /**
         * The offset the provider says comes next, or the accepted-row fallback.
         * It is a candidate, not a validated advance: the caller decides whether it
         * actually moves forward.
         */
        nextOffsetCandidate: number | null;
    }>
    | Readonly<{
        ok: false;
        failure: PosthogFailure;
        /** The paging geometry itself was unreadable, so no walk claim is possible. */
        uninterpretable: boolean;
    }>;

export type PosthogScanPageInput = Readonly<{
    origin: PosthogApiOrigin;
    environment: PosthogScanEnvironment;
    /** Already resolved and frozen for the whole pass. */
    window: PosthogResolvedWindow;
    /** Fixed for the pass; never shrunk to a remainder on a later page. */
    nativeLimit: number;
    offset: number;
}>;

/**
 * Requests, parses, and identity-maps exactly one provider page.
 *
 * This is the single owner of what one PostHog issues page means, and the one function
 * the bound scan operation drives, so neither can drift into a second interpretation of
 * the same request, the same tolerant row decoding, or the same paging geometry.
 * Cross-page concerns — duplicate detection, environment iteration, coverage health —
 * stay with the caller, because only the caller knows what it has already accepted.
 */
export async function scanPosthogIssuePage(
    client: PosthogApiClient,
    input: PosthogScanPageInput,
    options: PosthogRequestOptions,
): Promise<PosthogScanPageOutcome> {
    const route = resolvePosthogTeamRouteId(input.environment.teamRouteId);
    if (!route.ok) {
        return {
            ok: false,
            failure: { kind: 'requestInvalid', at: 'teamRouteId' },
            uninterpretable: true,
        };
    }

    const page = await client.requestJson(
        {
            method: 'POST',
            path: errorTrackingIssuesQueryPath(route.teamRouteId),
            body: buildPosthogIssuesQueryBody(input.window, input.nativeLimit, input.offset),
        },
        parsePosthogQueryEnvelope,
        options,
    );
    if (!page.ok) {
        return {
            ok: false,
            failure: page.failure,
            uninterpretable: page.failure.kind === 'malformedResponse',
        };
    }

    const envelope = page.value;
    const observations: PosthogIssueObservation[] = [];
    let malformedRowCount = 0;
    for (const rawRow of envelope.rawResults) {
        const row = parsePosthogIssueRow(rawRow);
        if (row === null) {
            malformedRowCount += 1;
            continue;
        }
        const locator = buildPosthogEntryLocator(
            input.origin,
            input.environment.teamUuid,
            row.id,
        );
        if (!locator.ok) {
            malformedRowCount += 1;
            continue;
        }
        observations.push({ locator: locator.value, row });
    }

    return {
        ok: true,
        observations,
        malformedRowCount,
        hasMore: envelope.hasMore,
        nextOffsetCandidate: envelope.hasMore
            ? envelope.nextOffset ?? (input.offset + envelope.rawResults.length)
            : null,
    };
}
