/**
 * The canonical single-entry read.
 *
 * The sequence is fixed and CRUD-first. PostHog's two planes are disjoint: `severity`,
 * external references, and cohort exist only on the CRUD plane, while `last_seen`,
 * aggregations, the top frame, and the latest release exist only on the query plane.
 * The CRUD read is also the authoritative existence answer, so the query enrichment is
 * issued only after CRUD returns 200 — never in parallel and never as an existence
 * probe of its own, because a query-plane 404 is window-scoped rather than row-scoped.
 *
 * An enrichment failure degrades the snapshot; it never downgrades a present entry.
 */

import type { PosthogApiClient, PosthogRequestOptions } from '../api/client.js';
import type { PosthogFailure } from '../api/errors.js';
import {
    errorTrackingIssueCrudPath,
    errorTrackingIssueQueryPath,
    resolvePosthogTeamRouteId,
} from '../api/paths.js';
import {
    parsePosthogIssueCrudRead,
    parsePosthogIssueQueryDetail,
    type PosthogIssueCrudRead,
    type PosthogIssueQueryDetail,
} from '../api/types/issues.js';
import { resolvePosthogCrudFailure, type PosthogIssueResolution } from './issueResolution.js';
import { buildPosthogIssueQueryBody, type PosthogResolvedWindow } from './scan/request.js';

export type PosthogGetInput = Readonly<{
    teamRouteId: number;
    issueId: string;
    /** The configured detail window, already resolved by the caller. */
    detailWindow: PosthogResolvedWindow;
}>;

export type PosthogGetOutcome =
    | Readonly<{
        kind: 'present';
        crud: PosthogIssueCrudRead;
        /** Absent when the query plane failed; the entry stays present regardless. */
        queryDetail?: PosthogIssueQueryDetail;
        /** Ephemeral detail-state diagnostic for a failed enrichment. */
        enrichmentFailure?: PosthogFailure;
    }>
    | Readonly<{ kind: 'unresolved'; resolution: PosthogIssueResolution }>;

export async function getPosthogIssue(
    client: PosthogApiClient,
    input: PosthogGetInput,
    options: PosthogRequestOptions,
): Promise<PosthogGetOutcome> {
    const route = resolvePosthogTeamRouteId(input.teamRouteId);
    if (!route.ok) {
        return {
            kind: 'unresolved',
            resolution: resolvePosthogCrudFailure({ kind: 'requestInvalid', at: 'teamRouteId' }),
        };
    }

    const crud = await client.requestJson(
        {
            method: 'GET',
            path: errorTrackingIssueCrudPath(route.teamRouteId, input.issueId),
        },
        parsePosthogIssueCrudRead,
        options,
    );
    if (!crud.ok) {
        return { kind: 'unresolved', resolution: resolvePosthogCrudFailure(crud.failure) };
    }

    const enrichment = await client.requestJson(
        {
            method: 'POST',
            path: errorTrackingIssueQueryPath(route.teamRouteId),
            body: buildPosthogIssueQueryBody(crud.value.id, input.detailWindow),
        },
        parsePosthogIssueQueryDetail,
        options,
    );
    if (!enrichment.ok) {
        return { kind: 'present', crud: crud.value, enrichmentFailure: enrichment.failure };
    }
    return { kind: 'present', crud: crud.value, queryDetail: enrichment.value };
}
