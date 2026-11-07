import * as React from 'react';

import { retainDeep, retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { isHomeCompletedBotCandidate, selectHomeCompletedBots, type HomeCompletedBots } from '@/activity/presentation/selectHomeCompletedBots';
import { ALL_SESSIONS_RECORDING_VISIBLE, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import { readSessionPersonalAttentionExpirationsForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { useActivityBoundaryRefresh } from './useActivityBoundaryRefresh';
import {
    areActivitySummaryFactsEqual,
    buildActivityOverviewFromSource,
    forEachActivitySummaryCandidate,
    readActivitySourceAttentionMessages,
    readActivitySummaryFacts,
    type ActivityOverviewSummary,
    type ActivitySummaryFacts,
} from './buildActivityOverviewFromSource';
import { useActivityAttentionSource } from './useActivityAttentionSource';
import { createActivitySourceAddressTable } from './activitySourceSessionAddresses';
import {
    useSharedActivitySourceProjection,
    type ActivitySourceProjectionInput,
    type ActivitySourceProjector,
    type ActivitySourceProjectorFactory,
} from './sharedActivitySourceProjection';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

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
    candidates: ActivityOverviewSnapshot['candidates'],
    nowMs: number,
): number | null {
    let nextMs: number | null = null;
    for (const candidate of candidates) {
        const expirations = readSessionPersonalAttentionExpirationsForViewer(
            candidate.session,
            nowMs,
            readActivitySourceAttentionMessages(source, candidate.address),
            candidate.presentationSource,
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

    const nextBoundaryMs = readNextAttentionBoundaryMs(source, overview.candidates, nowMs);
    useActivityBoundaryRefresh(nextBoundaryMs, advanceBoundary);

    return React.useMemo(() => ({ source, overview }), [overview, source]);
}

export type { ActivitySourceProjectionInput } from './sharedActivitySourceProjection';

/**
 * One projection of the summary attention source for a consumer-specific `project` (it must be
 * stable): the shared projection owner selects and projects once per publication for every mounted
 * reader of the same `project`, `retain` keeps the previous value while it reads the same, and a
 * freshness boundary re-projects at the new instant.
 */
export function useActivitySourceProjection<T extends Readonly<{ nextAttentionBoundaryMs: number | null }>>(
    project: (input: ActivitySourceProjectionInput) => T,
    retain: (previous: T | undefined, next: T) => T,
): T {
    const createProjector = React.useMemo<ActivitySourceProjectorFactory<T>>(() => () => ({ project }), [project]);
    return useSharedActivitySourceProjection(createProjector, retain);
}

/**
 * The summary's per-address table: a Session row write re-classifies that address and moves the
 * totals by its difference, so the work follows the changed rows rather than the corpus.
 */
function createActivityOverviewSummaryProjector(): ActivitySourceProjector<ActivityOverviewSummary> {
    let totalAttentionCount = 0;
    let inboxContentCount = 0;
    let workingCount = 0;
    let needsYouCount = 0;
    // Entries holding the current soonest boundary; only losing one of them needs a rescan.
    let boundary: { ms: number | null; holders: number } = { ms: null, holders: 0 };
    let nowMs = Date.now();
    const count = (facts: ActivitySummaryFacts, sign: 1 | -1) => {
        if (facts.attention) totalAttentionCount += sign;
        if (facts.inbox) inboxContentCount += sign;
        if (facts.working) workingCount += sign;
        if (facts.needsYou) needsYouCount += sign;
    };
    let boundaryStale = false;
    const table = createActivitySourceAddressTable<ActivitySummaryFacts>({
        includeWarmSourceWhenNotReady: true,
        classify: (source, addresses) => {
            const facts = new Map<string, ActivitySummaryFacts>();
            forEachActivitySummaryCandidate({ source, nowMs, includeWarmSourceWhenNotReady: true, addresses }, (visited) => {
                facts.set(sessionAddressKey(visited.entry.address), readActivitySummaryFacts(visited, nowMs));
            });
            return facts;
        },
        isSame: areActivitySummaryFactsEqual,
        onChange: (_key, previous, next) => {
            if (previous) {
                count(previous, -1);
                if (previous.nextAttentionBoundaryMs !== null && previous.nextAttentionBoundaryMs === boundary.ms) {
                    boundary.holders -= 1;
                    if (boundary.holders === 0) boundaryStale = true;
                }
            }
            if (next) {
                count(next, 1);
                const ms = next.nextAttentionBoundaryMs;
                if (ms !== null && !boundaryStale) {
                    if (boundary.ms === null || ms < boundary.ms) boundary = { ms, holders: 1 };
                    else if (ms === boundary.ms) boundary.holders += 1;
                }
            }
        },
    });
    let published: ActivityOverviewSummary | undefined;
    return {
        project: ({ source, nowMs: projectedAtMs, state }) => {
            nowMs = projectedAtMs;
            const changed = table.update(source, state);
            if (boundaryStale) {
                boundaryStale = false;
                boundary = { ms: null, holders: 0 };
                for (const facts of table.entries().values()) {
                    const ms = facts.nextAttentionBoundaryMs;
                    if (ms === null) continue;
                    if (boundary.ms === null || ms < boundary.ms) boundary = { ms, holders: 1 };
                    else if (ms === boundary.ms) boundary.holders += 1;
                }
            }
            if (published && !changed && published.isDataReady === source.isDataReady) return published;
            published = { isDataReady: source.isDataReady, totalAttentionCount, inboxContentCount,
                nextAttentionBoundaryMs: boundary.ms, workingCount, needsYouCount };
            return published;
        },
        observeUnchangedSource: state => table.observeUnchangedSource(state),
    };
}

/** Count-only chrome (rail badge, dots, status lines) subscribes to the summary itself. */
export function useActivityOverviewSummary(): ActivityOverviewSummary {
    return useSharedActivitySourceProjection(createActivityOverviewSummaryProjector, retainIfEqual, { changeDetection: 'identity' });
}

export type MountedHomeCompletedBots = HomeCompletedBots & Readonly<{
    source: Pick<ActivityAttentionSource, 'sessionListHomeObservationByServerId' | 'personalSessionListQueryStatesByServerId'>;
    nextAttentionBoundaryMs: number | null;
}>;

/** Completed Bots subscribe to their selected rows and read availability before publication. */
export function useHomeCompletedBots(
    isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE,
): MountedHomeCompletedBots {
    const project = React.useCallback(({ source, nowMs }: ActivitySourceProjectionInput): MountedHomeCompletedBots => {
        const overview = buildActivityOverviewFromSource({ source, nowMs, includeWarmSourceWhenNotReady: true });
        return {
            ...selectHomeCompletedBots(buildInboxSessionPresentation({ overview }), isSessionVisible),
            source: {
                sessionListHomeObservationByServerId: source.sessionListHomeObservationByServerId,
                personalSessionListQueryStatesByServerId: source.personalSessionListQueryStatesByServerId,
            },
            nextAttentionBoundaryMs: readNextAttentionBoundaryMs(source,
                overview.candidates.filter(candidate => isHomeCompletedBotCandidate(candidate, isSessionVisible)), nowMs),
        };
    }, [isSessionVisible]);
    return useActivitySourceProjection(project, retainDeep);
}
