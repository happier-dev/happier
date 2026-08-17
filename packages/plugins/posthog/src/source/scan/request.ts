/**
 * Scan request construction.
 *
 * PostHog's `query/issues/` request applies server-side defaults to omitted body
 * fields: an omitted `dateRange` becomes the last 7 days, an omitted `status` becomes
 * `active`, and an omitted `filterTestAccounts` becomes `true`. A caller that sends
 * `{}` therefore receives a silently narrowed result that still looks like a plain
 * list, so this builder always sends every narrowing input explicitly and the source
 * can state what its walk actually covered.
 *
 * `first_seen ASC` is the least-moving documented ordering: the aggregate sort keys
 * (`occurrences`, `users`, `sessions`) and `last_seen` all move while a client is
 * paging, and offset pagination over a moving key drops and duplicates rows. It reduces
 * avoidable offset churn; it does not prove that nothing moved.
 */

/** Provider page-size ceiling for `query/issues/`, from the published schema. */
export const POSTHOG_ISSUES_QUERY_MAX_LIMIT = 100;

export type PosthogResolvedWindow = Readonly<{
    /** ISO timestamp or a relative expression such as `-30d`. */
    from: string;
    /** ISO timestamp, or `null` for "now" as the provider spells it. */
    to: string | null;
}>;

export type PosthogIssuesQueryBody = Readonly<{
    dateRange: Readonly<{ date_from: string; date_to: string | null }>;
    status: 'all';
    filterTestAccounts: false;
    orderBy: 'first_seen';
    orderDirection: 'ASC';
    limit: number;
    offset: number;
    volumeResolution: 0;
}>;

/**
 * Resolves the native page size for a whole pass. It is fixed once and never shrunk to
 * a remainder on a later page: a changing page size across a moving offset walk makes
 * the geometry unreadable for no benefit.
 */
export function resolvePosthogNativeLimit(scanLimit: number): number {
    if (!Number.isSafeInteger(scanLimit) || scanLimit <= 0) {
        return 1;
    }
    return Math.min(scanLimit, POSTHOG_ISSUES_QUERY_MAX_LIMIT);
}

export function buildPosthogIssuesQueryBody(
    window: PosthogResolvedWindow,
    nativeLimit: number,
    offset: number,
): PosthogIssuesQueryBody {
    return {
        dateRange: { date_from: window.from, date_to: window.to },
        status: 'all',
        filterTestAccounts: false,
        orderBy: 'first_seen',
        orderDirection: 'ASC',
        limit: nativeLimit,
        offset,
        volumeResolution: 0,
    };
}

export type PosthogIssueQueryBody = Readonly<{
    issueId: string;
    dateRange: Readonly<{ date_from: string; date_to: string | null }>;
    filterTestAccounts: false;
    volumeResolution: 0;
    includeSparkline: false;
}>;

export function buildPosthogIssueQueryBody(
    issueId: string,
    window: PosthogResolvedWindow,
): PosthogIssueQueryBody {
    return {
        issueId,
        dateRange: { date_from: window.from, date_to: window.to },
        filterTestAccounts: false,
        volumeResolution: 0,
        includeSparkline: false,
    };
}
