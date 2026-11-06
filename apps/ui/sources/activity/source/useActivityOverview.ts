import * as React from 'react';

import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';

import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import { readSessionPersonalAttentionExpirationsForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { useActivityBoundaryRefresh } from './useActivityBoundaryRefresh';
import {
    buildActivityOverviewSummaryFromSource,
    buildActivityOverviewFromSource,
    readActivitySourceAttentionMessages,
    type ActivityOverviewSummary,
} from './buildActivityOverviewFromSource';
import {
    useActivityAttentionSource,
    useActivityAttentionSummarySource,
    useActivityAttentionStoreSelector,
} from './useActivityAttentionSource';

export type MountedActivityOverview = Readonly<{
    source: ActivityAttentionSource;
    overview: ActivityOverviewSnapshot;
}>;

/**
 * The soonest instant at which this projection stops being true on its own.
 *
 * Only pre-viewer candidates have one; the attention owner decides which, and
 * returns nothing for the rest. Each candidate is asked with the same stored
 * messages the overview decided it with, because a message-backed pending
 * request is what carries the expiring `user_action_required` in the first
 * place.
 */
function readNextAttentionBoundaryMs(
    source: ActivityAttentionSource,
    overview: ActivityOverviewSnapshot,
    nowMs: number,
): number | null {
    let nextMs: number | null = null;
    for (const candidate of overview.candidates) {
        const expirations = readSessionPersonalAttentionExpirationsForViewer(
            candidate.session,
            nowMs,
            readActivitySourceAttentionMessages(source, candidate.address),
        );
        for (const expiresAtMs of expirations) {
            if (expiresAtMs <= nowMs) continue;
            if (nextMs === null || expiresAtMs < nextMs) nextMs = expiresAtMs;
        }
    }
    return nextMs;
}

/**
 * The mounted Activity projection: one canonical overview plus the clock that
 * keeps it honest while nothing arrives.
 *
 * A store change is a render, so a source-keyed projection is correct for every
 * fact the server pushes. Pre-viewer pending-request attention is the exception —
 * it retires on a freshness budget rather than on an event — so a surface that
 * only re-projects on source identity keeps a retired row and an uncleanable
 * dot indefinitely. The boundary timer is local to the mounted consumer (the
 * `FaviconPermissionIndicator` pattern): no global scheduler, and no second
 * opinion about what attention means, only about when to look again.
 */
export function useActivityOverview(): MountedActivityOverview {
    const source = useActivityAttentionSource();
    const [boundaryVersion, advanceBoundary] = React.useReducer((value: number) => value + 1, 0);
    // Both inputs matter: the store moved, or a freshness budget elapsed.
    const nowMs = React.useMemo(() => Date.now(), [boundaryVersion, source]);
    const overview = React.useMemo(
        () => buildActivityOverviewFromSource({
            source,
            nowMs,
            includeWarmSourceWhenNotReady: true,
        }),
        [nowMs, source],
    );

    const nextBoundaryMs = readNextAttentionBoundaryMs(source, overview, nowMs);
    useActivityBoundaryRefresh(nextBoundaryMs, advanceBoundary);

    return React.useMemo(() => ({ source, overview }), [overview, source]);
}

export type MountedActivityOverviewSummary = Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    summary: ActivityOverviewSummary;
}>;

/** Summary consumers share the canonical attention boundary clock, without messages. */
export function useMountedActivityOverviewSummary(): MountedActivityOverviewSummary {
    const source = useActivityAttentionSummarySource();
    const [boundaryVersion, advanceBoundary] = React.useReducer((value: number) => value + 1, 0);
    const nowMs = React.useMemo(() => Date.now(), [boundaryVersion, source]);
    const summary = React.useMemo(
        () => buildActivityOverviewSummaryFromSource({
            source,
            nowMs,
            includeWarmSourceWhenNotReady: true,
        }),
        [nowMs, source],
    );

    useActivityBoundaryRefresh(summary.nextAttentionBoundaryMs, advanceBoundary);

    return React.useMemo(() => ({ source, nowMs, summary }), [source, nowMs, summary]);
}

/** A projection of the summary attention source, with the facts it needs to project. */
export type ActivitySourceProjectionInput = Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    state: StorageState;
}>;

/**
 * One store-selector projection of the summary attention source on the canonical boundary clock: the
 * selector projects only when the source moves, `retain` keeps the previous value while it reads the
 * same (so a Session row write that changes nothing projected renders no consumer), and a freshness
 * boundary re-creates the selector so an expiry re-projects at the new instant. `project` must be stable.
 */
export function useActivitySourceProjection<T extends Readonly<{ nextAttentionBoundaryMs: number | null }>>(
    project: (input: ActivitySourceProjectionInput) => T,
    retain: (previous: T | undefined, next: T) => T,
): T {
    const [boundaryVersion, advanceBoundary] = React.useReducer((value: number) => value + 1, 0);
    const selectSource = useActivityAttentionStoreSelector(false);
    // The selector is re-created when membership changes; the published value outlives it.
    const published = React.useRef<T | undefined>(undefined);
    const select = React.useMemo(() => {
        let previousSource: ReturnType<typeof selectSource> | undefined;
        return (state: StorageState) => {
            const selected = selectSource(state);
            if (published.current && previousSource === selected) return published.current;
            previousSource = selected;
            published.current = retain(published.current,
                project({ source: selected, nowMs: Date.now(), state }));
            return published.current;
        };
    }, [boundaryVersion, project, retain, selectSource]);
    const value = storage(select);
    useActivityBoundaryRefresh(value.nextAttentionBoundaryMs, advanceBoundary);
    return value;
}

function projectActivityOverviewSummary(input: ActivitySourceProjectionInput): ActivityOverviewSummary {
    return buildActivityOverviewSummaryFromSource({ source: input.source, nowMs: input.nowMs, includeWarmSourceWhenNotReady: true });
}

/** Count-only chrome (rail badge, dots, status lines) subscribes to the summary itself. */
export function useActivityOverviewSummary(): ActivityOverviewSummary {
    return useActivitySourceProjection(projectActivityOverviewSummary, retainIfEqual);
}
