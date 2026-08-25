/**
 * Fact projection for one issue.
 *
 * The three count facts keep their distinct provider meanings. `occurrences` is exact
 * for the configured bounded window, but only for exceptions PostHog actually
 * *ingested*: project-level and per-issue ingest rate limits and suppression-rule
 * sampling all reduce it, so it is never presented as every exception that occurred.
 * `users` and `sessions` are approximate aggregates.
 *
 * `severity` is deliberately absent from a scan row. It exists only on the CRUD plane,
 * which offers no filter, ordering, or bulk-by-id read, so populating it for a list
 * would cost one CRUD call per issue against a budget shared with everything else in
 * the customer's organization. It is detail-only.
 *
 * The priority order below is the source-owned part of this projection: it decides
 * which facts survive when the shared count limit binds. The limit itself is supplied
 * by the caller.
 */

import type { PosthogIssueQueryDetail, PosthogIssueRow, PosthogTopFrame } from '../../api/types/issues.js';
import { projectTriageDisplayTextV1 } from '@happier-dev/triage-protocol/v1';

import type { PosthogProjectionBounds } from './bounds.js';

export type PosthogFactId =
    | 'occurrences'
    | 'users'
    | 'sessions'
    | 'library'
    | 'source'
    | 'function'
    | 'topFrame'
    | 'release'
    | 'firstSeen'
    | 'lastSeen';

export type PosthogFact =
    | Readonly<{
        id: 'occurrences';
        kind: 'count';
        value: number;
        approximate: false;
        /** Names the bounded ingested window this count belongs to. */
        scope: 'configuredWindowIngested';
    }>
    | Readonly<{ id: 'users' | 'sessions'; kind: 'count'; value: number; approximate: true }>
    | Readonly<{
        id: 'library' | 'source' | 'function' | 'topFrame' | 'release';
        kind: 'text';
        value: string;
        truncated: boolean;
    }>
    | Readonly<{ id: 'firstSeen' | 'lastSeen'; kind: 'timestamp'; atMs: number }>;

/**
 * Stable selection order. Impact evidence outranks provenance, and provenance outranks
 * the first-seen timestamp, which the row identity already implies.
 */
export const POSTHOG_FACT_PRIORITY: readonly PosthogFactId[] = [
    'occurrences',
    'function',
    'topFrame',
    'release',
    'lastSeen',
    'users',
    'sessions',
    'source',
    'library',
    'firstSeen',
];

function factOrder(id: PosthogFactId): number {
    const index = POSTHOG_FACT_PRIORITY.indexOf(id);
    return index === -1 ? POSTHOG_FACT_PRIORITY.length : index;
}

export type PosthogProjectedFacts = Readonly<{
    facts: readonly PosthogFact[];
    truncated: boolean;
}>;

export function projectPosthogFacts(
    row: PosthogIssueRow,
    bounds: PosthogProjectionBounds,
    enrichment?: PosthogIssueQueryDetail,
): PosthogProjectedFacts {
    const candidates: PosthogFact[] = [];
    let truncated = false;

    const occurrences = row.aggregations?.occurrences;
    if (occurrences !== undefined) {
        candidates.push({
            id: 'occurrences',
            kind: 'count',
            value: occurrences,
            approximate: false,
            scope: 'configuredWindowIngested',
        });
    }
    const users = row.aggregations?.users;
    if (users !== undefined) {
        candidates.push({ id: 'users', kind: 'count', value: users, approximate: true });
    }
    const sessions = row.aggregations?.sessions;
    if (sessions !== undefined) {
        candidates.push({ id: 'sessions', kind: 'count', value: sessions, approximate: true });
    }
    if (row.source !== null && row.source.length > 0) {
        const projected = projectTriageDisplayTextV1(row.source, bounds.factValueUtf8Bytes);
        truncated = truncated || projected.truncated;
        // A fact whose whole value was control characters has no renderable text left,
        // and every published string is non-empty: omit the chip rather than the row.
        if (projected.value.length > 0) candidates.push({
            id: 'source',
            kind: 'text',
            value: projected.value,
            truncated: projected.truncated,
        });
    }
    if (row.library !== null && row.library.length > 0) {
        const projected = projectTriageDisplayTextV1(row.library, bounds.factValueUtf8Bytes);
        truncated = truncated || projected.truncated;
        // A fact whose whole value was control characters has no renderable text left,
        // and every published string is non-empty: omit the chip rather than the row.
        if (projected.value.length > 0) candidates.push({
            id: 'library',
            kind: 'text',
            value: projected.value,
            truncated: projected.truncated,
        });
    }
    if (row.firstSeenMs !== undefined) {
        candidates.push({ id: 'firstSeen', kind: 'timestamp', atMs: row.firstSeenMs });
    }
    if (row.lastSeenMs !== undefined) {
        candidates.push({ id: 'lastSeen', kind: 'timestamp', atMs: row.lastSeenMs });
    }

    const pushText = (
        id: 'function' | 'topFrame' | 'release',
        value: string | null,
    ): void => {
        if (value === null || value.length === 0) return;
        const projected = projectTriageDisplayTextV1(value, bounds.factValueUtf8Bytes);
        truncated = truncated || projected.truncated;
        if (projected.value.length > 0) {
            candidates.push({ id, kind: 'text', value: projected.value, truncated: projected.truncated });
        }
    };
    const frameLocation = (frame: PosthogTopFrame): string | null => {
        const label = frame.function ?? frame.source;
        if (label === undefined) return null;
        if (frame.source === undefined || frame.source === label) return label;
        if (frame.line === undefined) return `${label} — ${frame.source}`;
        const location = frame.column === undefined
            ? `${frame.source}:${String(frame.line)}`
            : `${frame.source}:${String(frame.line)}:${String(frame.column)}`;
        return `${label} — ${location}`;
    };
    pushText('function', enrichment?.function ?? null);
    pushText('topFrame', enrichment?.topInAppFrame === null || enrichment?.topInAppFrame === undefined
        ? null
        : frameLocation(enrichment.topInAppFrame));
    const release = enrichment?.latestRelease;
    pushText('release', release === null || release === undefined
        ? null
        : release.version ?? release.commitId ?? release.branch ?? release.repoName ?? release.project ?? null);

    candidates.sort((left, right) => factOrder(left.id) - factOrder(right.id));
    if (candidates.length > bounds.maxFacts) {
        truncated = true;
    }
    return { facts: candidates.slice(0, bounds.maxFacts), truncated };
}
