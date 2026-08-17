/**
 * Strict parsers for PostHog's two disjoint issue planes.
 *
 * PostHog's query plane (`query/issues/`, `query/issue/`) and CRUD plane
 * (`issues/{id}/`) are disjoint, not nested: `severity`, `external_issues`, and
 * `cohort` exist only on CRUD, while `last_seen` and every occurrence count exist only
 * on the query plane. These parsers keep that split visible instead of pretending one
 * model is a projection of the other.
 *
 * Tolerance is asymmetric by design. The response envelope and its paging geometry are
 * strict, because a walk whose geometry is unreadable can no longer be interpreted. An
 * individual issue row is parsed independently, so one malformed row is skipped with a
 * diagnostic while every other valid row on the same page still becomes an observation.
 */

import {
    readArray,
    readFiniteNumber,
    readLowercaseUuid,
    readNullableString,
    readObject,
    readSafeInteger,
    readString,
    readTimestampMs,
} from './primitives.js';

/** The five native issue states PostHog can put on a row. `all` is filter-only. */
export const POSTHOG_NATIVE_ISSUE_STATUSES = [
    'archived',
    'active',
    'resolved',
    'pending_release',
    'suppressed',
] as const;
export type PosthogNativeIssueStatus = typeof POSTHOG_NATIVE_ISSUE_STATUSES[number];

export const POSTHOG_NATIVE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type PosthogNativeSeverity = typeof POSTHOG_NATIVE_SEVERITIES[number];

export type PosthogAggregations = Readonly<{
    occurrences?: number;
    users?: number;
    sessions?: number;
}>;

export type PosthogAssignee = Readonly<{
    id: string | number | null;
    type: string | null;
}>;

/** One row of `POST error_tracking/query/issues/` — the scan plane. */
export type PosthogIssueRow = Readonly<{
    id: string;
    name: string | null;
    description: string | null;
    /**
     * The provider declares this as a bare string, not an enum, so an unrecognized
     * value is retained verbatim and presented through the shared neutral arm.
     */
    nativeStatus: string;
    firstSeenMs?: number;
    lastSeenMs?: number;
    library: string | null;
    source: string | null;
    assignee: PosthogAssignee | null;
    aggregations: PosthogAggregations | null;
}>;

export type PosthogTopFrame = Readonly<{
    function?: string;
    source?: string;
    line?: number;
    column?: number;
    inApp?: boolean;
}>;

export type PosthogLatestRelease = Readonly<{
    version?: string;
    project?: string;
    timestamp?: string;
    commitId?: string;
    branch?: string;
    repoName?: string;
}>;

/** `POST error_tracking/query/issue/` — query-plane enrichment for one issue. */
export type PosthogIssueQueryDetail = PosthogIssueRow & Readonly<{
    function: string | null;
    topInAppFrame: PosthogTopFrame | null;
    latestRelease: PosthogLatestRelease | null;
    impact: PosthogAggregations | null;
}>;

/** `GET error_tracking/issues/{id}/` — the authoritative CRUD metadata plane. */
export type PosthogIssueCrudRead = Readonly<{
    id: string;
    nativeStatus: string;
    severity: PosthogNativeSeverity | null;
    name: string | null;
    description: string | null;
    firstSeenMs?: number;
    assignee: PosthogAssignee | null;
    externalIssueCount: number;
    cohortName: string | null;
}>;

/** The shared query-plane paging envelope used by both query list routes. */
export type PosthogQueryEnvelope = Readonly<{
    rawResults: readonly unknown[];
    hasMore: boolean;
    limit: number;
    offset: number;
    /** `nextOffset` is not required by the provider; absence is normal. */
    nextOffset?: number;
}>;

function parseAggregations(value: unknown): PosthogAggregations | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const occurrences = readFiniteNumber(raw['occurrences']);
    const users = readFiniteNumber(raw['users']);
    const sessions = readFiniteNumber(raw['sessions']);
    return {
        ...(occurrences === null ? {} : { occurrences }),
        ...(users === null ? {} : { users }),
        ...(sessions === null ? {} : { sessions }),
    };
}

function parseAssignee(value: unknown): PosthogAssignee | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const id = raw['id'];
    const identity = typeof id === 'string' || typeof id === 'number' ? id : null;
    return { id: identity, type: readNullableString(raw['type']) };
}

function parseTopFrame(value: unknown): PosthogTopFrame | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const fn = readString(raw['function']);
    const source = readString(raw['source']);
    const line = readSafeInteger(raw['line']);
    const column = readSafeInteger(raw['column']);
    const inApp = typeof raw['in_app'] === 'boolean' ? raw['in_app'] : null;
    return {
        ...(fn === null ? {} : { function: fn }),
        ...(source === null ? {} : { source }),
        ...(line === null ? {} : { line }),
        ...(column === null ? {} : { column }),
        ...(inApp === null ? {} : { inApp }),
    };
}

function parseLatestRelease(value: unknown): PosthogLatestRelease | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const version = readString(raw['version']);
    const project = readString(raw['project']);
    const timestamp = readString(raw['timestamp']);
    const commitId = readString(raw['commit_id']);
    const branch = readString(raw['branch']);
    const repoName = readString(raw['repo_name']);
    return {
        ...(version === null ? {} : { version }),
        ...(project === null ? {} : { project }),
        ...(timestamp === null ? {} : { timestamp }),
        ...(commitId === null ? {} : { commitId }),
        ...(branch === null ? {} : { branch }),
        ...(repoName === null ? {} : { repoName }),
    };
}

/**
 * Parses one raw issue row. Returns `null` for a row whose identity or state cannot be
 * read, which the caller records as a skipped-row diagnostic rather than discarding the
 * whole page.
 */
export function parsePosthogIssueRow(value: unknown): PosthogIssueRow | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const id = readLowercaseUuid(raw['id']);
    if (id === null) {
        return null;
    }
    const nativeStatus = readString(raw['status']);
    if (nativeStatus === null || nativeStatus.length === 0) {
        return null;
    }
    const firstSeenMs = readTimestampMs(raw['first_seen']);
    const lastSeenMs = readTimestampMs(raw['last_seen']);
    return {
        id,
        name: readNullableString(raw['name']),
        description: readNullableString(raw['description']),
        nativeStatus,
        ...(firstSeenMs === null ? {} : { firstSeenMs }),
        ...(lastSeenMs === null ? {} : { lastSeenMs }),
        library: readNullableString(raw['library']),
        source: readNullableString(raw['source']),
        assignee: parseAssignee(raw['assignee']),
        aggregations: parseAggregations(raw['aggregations']),
    };
}

export function parsePosthogIssueQueryDetail(value: unknown): PosthogIssueQueryDetail | null {
    const row = parsePosthogIssueRow(value);
    if (row === null) {
        return null;
    }
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    return {
        ...row,
        function: readNullableString(raw['function']),
        topInAppFrame: parseTopFrame(raw['top_in_app_frame']),
        latestRelease: parseLatestRelease(raw['latest_release']),
        impact: parseAggregations(raw['impact']),
    };
}

function parseSeverity(value: unknown): PosthogNativeSeverity | null {
    const raw = readNullableString(value);
    if (raw === null) {
        return null;
    }
    return (POSTHOG_NATIVE_SEVERITIES as readonly string[]).includes(raw)
        ? raw as PosthogNativeSeverity
        : null;
}

export function parsePosthogIssueCrudRead(value: unknown): PosthogIssueCrudRead | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const id = readLowercaseUuid(raw['id']);
    if (id === null) {
        return null;
    }
    const nativeStatus = readString(raw['status']);
    if (nativeStatus === null || nativeStatus.length === 0) {
        return null;
    }
    const firstSeenMs = readTimestampMs(raw['first_seen']);
    const externalIssues = readArray(raw['external_issues']);
    const cohort = readObject(raw['cohort']);
    return {
        id,
        nativeStatus,
        severity: parseSeverity(raw['severity']),
        name: readNullableString(raw['name']),
        description: readNullableString(raw['description']),
        ...(firstSeenMs === null ? {} : { firstSeenMs }),
        assignee: parseAssignee(raw['assignee']),
        externalIssueCount: externalIssues === null ? 0 : externalIssues.length,
        cohortName: cohort === null ? null : readString(cohort['name']),
    };
}

/**
 * Parses the strict query-plane envelope. Its paging geometry must be readable: a
 * missing `hasMore`, a non-integer `limit`/`offset`, or a non-array `results` makes the
 * walk uninterpretable and fails the invocation rather than silently truncating it.
 */
export function parsePosthogQueryEnvelope(value: unknown): PosthogQueryEnvelope | null {
    const raw = readObject(value);
    if (raw === null) {
        return null;
    }
    const rawResults = readArray(raw['results']);
    const hasMore = raw['hasMore'];
    const limit = readSafeInteger(raw['limit']);
    const offset = readSafeInteger(raw['offset']);
    if (
        rawResults === null
        || typeof hasMore !== 'boolean'
        || limit === null
        || limit < 0
        || offset === null
        || offset < 0
    ) {
        return null;
    }
    const nextOffsetRaw = raw['nextOffset'];
    const nextOffset = nextOffsetRaw === undefined || nextOffsetRaw === null
        ? null
        : readSafeInteger(nextOffsetRaw);
    if (nextOffsetRaw !== undefined && nextOffsetRaw !== null && nextOffset === null) {
        return null;
    }
    return {
        rawResults,
        hasMore,
        limit,
        offset,
        ...(nextOffset === null ? {} : { nextOffset }),
    };
}
