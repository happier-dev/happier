/**
 * The three sampled-data views, as pure projections of one detail-instance sample.
 *
 * Occurrences, Stack Trace and Affected Sessions read the same rows. Keeping their
 * projections here — rather than inside three panels — is what makes "one loader, three
 * consumers" enforceable instead of aspirational: none of these functions can fetch,
 * cache, or hold anything, so a panel that wants different rows has to ask the
 * controller rather than quietly opening its own read.
 *
 * Affected Sessions is deliberately the most conservative of the three. PostHog's
 * session-replay permalink template is not characterized for a self-hosted deployment,
 * and a session id is not evidence that a recording exists. A row therefore offers a
 * replay link only when the issue's own verified link proves the same-origin project
 * base, and otherwise says the link is unavailable rather than guessing one.
 */

import type { PosthogProjectedIssueEvent } from './issueEventProjection.js';

export type PosthogOccurrenceRowV1 = Readonly<{
    uuid: string;
    atMs: number | null;
    /** The exception this occurrence carried, or a stated absence. */
    headline: string;
    /** The page the exception was thrown on, when the sample named one. */
    detail: string | null;
    truncated: boolean;
}>;

export type PosthogStackFrameRowV1 = Readonly<{
    /** Stable within one occurrence: exception index and frame index. */
    id: string;
    label: string;
    location: string | null;
    inApp: boolean;
}>;

export type PosthogStackTraceV1 = Readonly<{
    exceptionLabel: string | null;
    frames: readonly PosthogStackFrameRowV1[];
    appFrameCount: number;
    otherFrameCount: number;
    truncated: boolean;
}>;

export type PosthogSessionReplayV1 =
    | Readonly<{ kind: 'candidate'; href: string }>
    | Readonly<{ kind: 'unavailable'; reason: 'noVerifiedPermalink' }>;

export type PosthogAffectedSessionRowV1 = Readonly<{
    sessionId: string;
    occurrenceCount: number;
    firstAtMs: number | null;
    lastAtMs: number | null;
    url: string | null;
    replay: PosthogSessionReplayV1;
}>;

const NO_EXCEPTION_LABEL = 'Exception details unavailable';

function exceptionLabel(event: PosthogProjectedIssueEvent): string | null {
    const first = event.exceptions[0];
    if (first === undefined) {
        return null;
    }
    if (first.type !== undefined && first.value !== undefined) {
        return `${first.type}: ${first.value}`;
    }
    return first.type ?? first.value ?? null;
}

export function posthogOccurrenceRows(
    events: readonly PosthogProjectedIssueEvent[],
): readonly PosthogOccurrenceRowV1[] {
    // Provider order is preserved: this sample carries no ranking, and reordering it
    // here would invent one.
    return events.map((event) => ({
        uuid: event.uuid,
        atMs: event.timestampMs ?? null,
        headline: exceptionLabel(event) ?? NO_EXCEPTION_LABEL,
        detail: event.url ?? null,
        truncated: event.truncated === true,
    }));
}

function frameLocation(
    source: string | undefined,
    line: number | undefined,
    column: number | undefined,
): string | null {
    if (source === undefined) {
        return null;
    }
    if (line === undefined) {
        return source;
    }
    return column === undefined ? `${source}:${String(line)}` : `${source}:${String(line)}:${String(column)}`;
}

export function posthogStackTrace(
    event: PosthogProjectedIssueEvent | undefined,
): PosthogStackTraceV1 {
    if (event === undefined) {
        return {
            exceptionLabel: null,
            frames: [],
            appFrameCount: 0,
            otherFrameCount: 0,
            truncated: false,
        };
    }
    const frames: PosthogStackFrameRowV1[] = [];
    let appFrameCount = 0;
    event.exceptions.forEach((exception, exceptionIndex) => {
        exception.frames.forEach((frame, frameIndex) => {
            const inApp = frame.inApp === true;
            if (inApp) {
                appFrameCount += 1;
            }
            frames.push({
                id: `${String(exceptionIndex)}:${String(frameIndex)}`,
                label: frame.function ?? frame.source ?? 'Unnamed frame',
                location: frameLocation(frame.source, frame.line, frame.column),
                inApp,
            });
        });
    });
    return {
        exceptionLabel: exceptionLabel(event),
        frames,
        appFrameCount,
        otherFrameCount: frames.length - appFrameCount,
        truncated: event.truncated === true,
    };
}

/**
 * Reads the same-origin project base out of the issue's own verified link.
 *
 * Only an HTTPS PostHog Error Tracking issue link proves a base. Anything else — another
 * path shape, a cleartext scheme, an empty project segment, an unparsable value — proves
 * nothing, and this source does not construct a link it has not seen the provider use.
 */
function projectReplayBase(issueWebUrl: string | null): string | null {
    if (issueWebUrl === null) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(issueWebUrl);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') {
        return null;
    }
    // Positions are read exactly, not compacted: compacting `/project//error_tracking`
    // would read the next segment as a project id and build a link to nowhere.
    const segments = url.pathname.split('/');
    const projectId = segments[2];
    if (
        segments[1] !== 'project'
        || projectId === undefined
        || projectId.length === 0
        || segments[3] !== 'error_tracking'
    ) {
        return null;
    }
    return `${url.origin}/project/${encodeURIComponent(projectId)}/replay`;
}

export function posthogAffectedSessionRows(
    events: readonly PosthogProjectedIssueEvent[],
    options: Readonly<{ issueWebUrl: string | null }>,
): readonly PosthogAffectedSessionRowV1[] {
    const replayBase = projectReplayBase(options.issueWebUrl);
    const bySession = new Map<string, {
        occurrenceCount: number;
        firstAtMs: number | null;
        lastAtMs: number | null;
        url: string | null;
    }>();

    for (const event of events) {
        const sessionId = event.sessionId;
        if (sessionId === undefined) {
            continue;
        }
        const atMs = event.timestampMs ?? null;
        const existing = bySession.get(sessionId);
        if (existing === undefined) {
            bySession.set(sessionId, {
                occurrenceCount: 1,
                firstAtMs: atMs,
                lastAtMs: atMs,
                url: event.url ?? null,
            });
            continue;
        }
        existing.occurrenceCount += 1;
        if (atMs !== null) {
            existing.firstAtMs = existing.firstAtMs === null
                ? atMs
                : Math.min(existing.firstAtMs, atMs);
            existing.lastAtMs = existing.lastAtMs === null
                ? atMs
                : Math.max(existing.lastAtMs, atMs);
        }
        if (existing.url === null && event.url !== undefined) {
            existing.url = event.url;
        }
    }

    return [...bySession.entries()].map(([sessionId, aggregate]) => ({
        sessionId,
        occurrenceCount: aggregate.occurrenceCount,
        firstAtMs: aggregate.firstAtMs,
        lastAtMs: aggregate.lastAtMs,
        url: aggregate.url,
        replay: replayBase === null
            ? { kind: 'unavailable' as const, reason: 'noVerifiedPermalink' as const }
            : { kind: 'candidate' as const, href: `${replayBase}/${encodeURIComponent(sessionId)}` },
    }));
}
