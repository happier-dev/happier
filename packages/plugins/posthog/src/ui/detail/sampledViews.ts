/**
 * The three sampled-data views, as pure projections of one detail-instance sample.
 *
 * Occurrences, Stack Trace and Affected Sessions read the same rows. Keeping their
 * projections here — rather than inside three panels — is what makes "one loader, three
 * consumers" enforceable instead of aspirational: none of these functions can fetch,
 * cache, or hold anything, so a panel that wants different rows has to ask the
 * controller rather than quietly opening its own read.
 *
 * Affected Sessions is deliberately conservative: a sampled session id is not evidence
 * that a recording exists, and this source has no characterized replay permalink
 * producer. It therefore publishes the sampled session evidence and no replay claim.
 */

import type { PosthogProjectedIssueEvent } from './issueEventProjection.js';

export type PosthogOccurrenceRowV1 = Readonly<{
    uuid: string;
    atMs: number | null;
    /** The exception this occurrence carried, or a stated absence. */
    headline: string;
    /** The page the exception was thrown on, when the sample named one. */
    detail: string | null;
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
}>;

export type PosthogAffectedSessionRowV1 = Readonly<{
    sessionId: string;
    occurrenceCount: number;
    firstAtMs: number | null;
    lastAtMs: number | null;
    url: string | null;
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
    };
}

export function posthogAffectedSessionRows(
    events: readonly PosthogProjectedIssueEvent[],
): readonly PosthogAffectedSessionRowV1[] {
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
    }));
}
