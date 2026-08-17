/**
 * PostHog provider route templates.
 *
 * PostHog's Error Tracking surface is project-scoped under the backward-compatible
 * `/api/projects/{project_id}/` spelling, where that path segment is the Team /
 * environment route id — not the separately exposed parent `project_id` field. Callers
 * pass the Team route id; substituting a parent project id here would silently read a
 * different environment.
 *
 * There is deliberately no template for `error_tracking/issues/exists/`: the published
 * contract gives it no item selector and no response body, so it cannot answer an
 * item-level presence question and the source never probes it.
 */

export type PosthogTeamRouteId = number & { readonly __posthogTeamRouteId: unique symbol };

export type PosthogRouteIdRejection = Readonly<{ ok: false; reason: 'invalidTeamRouteId' }>;

export type PosthogTeamRouteIdResolution =
    | Readonly<{ ok: true; teamRouteId: PosthogTeamRouteId }>
    | PosthogRouteIdRejection;

/** PostHog Team ids are positive integers; anything else cannot address a route. */
export function resolvePosthogTeamRouteId(value: number): PosthogTeamRouteIdResolution {
    if (!Number.isSafeInteger(value) || value <= 0) {
        return { ok: false, reason: 'invalidTeamRouteId' };
    }
    return { ok: true, teamRouteId: value as PosthogTeamRouteId };
}

function errorTrackingBase(teamRouteId: PosthogTeamRouteId): string {
    return `/api/projects/${String(teamRouteId)}/error_tracking`;
}

/** POST — the one scan plane. Body carries every narrowing input explicitly. */
export function errorTrackingIssuesQueryPath(teamRouteId: PosthogTeamRouteId): string {
    return `${errorTrackingBase(teamRouteId)}/query/issues/`;
}

/** POST — query-plane enrichment for one issue (last seen, aggregations, release). */
export function errorTrackingIssueQueryPath(teamRouteId: PosthogTeamRouteId): string {
    return `${errorTrackingBase(teamRouteId)}/query/issue/`;
}

/** POST — bounded sampled exception events for one issue. */
export function errorTrackingIssueEventsQueryPath(teamRouteId: PosthogTeamRouteId): string {
    return `${errorTrackingBase(teamRouteId)}/query/issue_events/`;
}

/** GET — authoritative CRUD metadata for one issue, including severity. */
export function errorTrackingIssueCrudPath(
    teamRouteId: PosthogTeamRouteId,
    issueId: string,
): string {
    return `${errorTrackingBase(teamRouteId)}/issues/${encodeURIComponent(issueId)}/`;
}

/**
 * GET — one page of the item-scoped activity log for a single issue.
 *
 * It lives on the CRUD plane beside `issues/{id}/`, but it is not covered by
 * `error_tracking:read`: the published contract guards both activity routes with the
 * separate `activity_log:read` scope, so an account that reads every other route here
 * can still be refused this one. The page is addressed with explicit `limit` and `page`
 * query values supplied by the caller.
 */
export function errorTrackingIssueActivityPath(
    teamRouteId: PosthogTeamRouteId,
    issueId: string,
): string {
    return `${errorTrackingBase(teamRouteId)}/issues/${encodeURIComponent(issueId)}/activity/`;
}

/** GET — user-directed organization browsing during explicit configuration. */
export function organizationsListPath(): string {
    return '/api/organizations/';
}

/** GET — user-directed Team/environment browsing under one chosen organization. */
export function organizationProjectsPath(organizationUuid: string): string {
    return `/api/organizations/${encodeURIComponent(organizationUuid)}/projects/`;
}
