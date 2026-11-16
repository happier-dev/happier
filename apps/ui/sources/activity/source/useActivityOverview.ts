import * as React from 'react';

import { areSnapshotProjectionsEquivalent, retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { isHomeCompletedBotCandidate, type HomeCompletedBots } from '@/activity/presentation/selectHomeCompletedBots';
import { ALL_SESSIONS_RECORDING_VISIBLE, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

import type { ActivityOverviewSnapshot } from '@/activity/attention/activityAttentionTypes';
import { readSessionPersonalAttentionExpirationsForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import {
    buildActivityOverviewFromSource,
    readActivitySourceAttentionMessages,
    type ActivityOverviewSummary,
} from './buildActivityOverviewFromSource';
import { createActivitySourceAddressTable } from './activitySourceSessionAddresses';
import { createActivityOverviewSummaryProjector } from './activityOverviewSummaryProjector';
import {
    useSharedActivitySourceDetailProjection,
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
/**
 * How a mounted overview classifies. Inbox reads a warm source before data is ready; device surfaces
 * (Live Activities, widgets) present nothing until it is, name their activity and gate direct actions.
 * Every option must be stable (a module value or a store-published value).
 */
export type MountedActivityOverviewOptions = Readonly<{
    includeWarmSourceWhenNotReady?: boolean;
    activityName?: string | null;
    directActionsEnabled?: boolean;
    isSessionVisible?: SessionRecordingVisibility;
}>;

const INBOX_OVERVIEW_OPTIONS: MountedActivityOverviewOptions = { includeWarmSourceWhenNotReady: true };

type MountedActivityOverviewProjection = MountedActivityOverview & Readonly<{ nextAttentionBoundaryMs: number | null }>;

/** The mounted projector keeps its published value while nothing moved, so the shared owner retains by identity. */
const keepProjectedOverview = (_previous: MountedActivityOverviewProjection | undefined, next: MountedActivityOverviewProjection) => next;

/**
 * The full overview, projected inside the store subscription by the shared projection owner: a
 * publication that moves no candidate (each streamed transcript delta) renders no consumer. `source`
 * is the source the published overview was projected from; a reader that needs the live source (for
 * example to show a transcript's request details) subscribes to it itself.
 */
export function useActivityOverview(options: MountedActivityOverviewOptions = INBOX_OVERVIEW_OPTIONS): MountedActivityOverview {
    const { includeWarmSourceWhenNotReady = false, activityName, directActionsEnabled, isSessionVisible } = options;
    const createProjector = React.useMemo<ActivitySourceProjectorFactory<MountedActivityOverviewProjection>>(
        () => () => createMountedActivityOverviewProjector({ includeWarmSourceWhenNotReady, activityName, directActionsEnabled, isSessionVisible }),
        [activityName, directActionsEnabled, includeWarmSourceWhenNotReady, isSessionVisible],
    );
    // This projector follows the changed-address publication itself. Signing every Session first
    // would repeat a full-corpus read before the exact projection.
    return useSharedActivitySourceDetailProjection(createProjector, keepProjectedOverview, { changeDetection: 'identity' });
}

function createMountedActivityOverviewProjector(options: MountedActivityOverviewOptions): ActivitySourceProjector<MountedActivityOverviewProjection> {
    let nowMs = Date.now();
    const includeWarmSourceWhenNotReady = options.includeWarmSourceWhenNotReady === true;
    const isSessionVisible = options.isSessionVisible;
    const table = createActivitySourceAddressTable<ActivityOverviewSnapshot['candidates'][number]>({
        includeWarmSourceWhenNotReady,
        classify: (source, addresses) => new Map(buildActivityOverviewFromSource({
            source, nowMs, includeWarmSourceWhenNotReady, addresses,
            activityName: options.activityName, directActionsEnabled: options.directActionsEnabled,
        }).candidates.filter(candidate => !isSessionVisible || isSessionVisible(candidate.address ?? candidate))
            .map(candidate => [sessionAddressKey(candidate.address!), candidate])),
        // A re-classified candidate equal to the one held keeps its identity, so an arrival that moves no
        // Activity fact (each streamed delta of a viewed Session) publishes no new overview.
        isSame: areSnapshotProjectionsEquivalent,
    });
    let published: MountedActivityOverviewProjection | undefined;
    return {
        // A freshness boundary makes the shared owner create a fresh projector, so it re-projects completely.
        project: ({ source, state, nowMs: projectedAtMs }) => {
            nowMs = projectedAtMs;
            const changed = table.update(source, state);
            // A publication that moves no candidate keeps the overview, so its readers re-derive nothing.
            if (published && !changed && published.source.isDataReady === source.isDataReady) return published;
            const overview = changed || !published ? buildActivityOverviewFromCandidates([...table.entries().values()]) : published.overview;
            published = { source, overview, nextAttentionBoundaryMs: readNextAttentionBoundaryMs(source, overview.candidates, nowMs) };
            return published;
        },
        observeUnchangedSource: state => table.observeUnchangedSource(state),
    };
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

/** Count-only chrome (rail badge, dots, status lines) subscribes to the summary itself. */
export function useActivityOverviewSummary(): ActivityOverviewSummary {
    return useSharedActivitySourceProjection(createActivityOverviewSummaryProjector, retainIfEqual, { changeDetection: 'identity' });
}

export type MountedHomeCompletedBots = HomeCompletedBots & Readonly<{
    source: Pick<ActivityAttentionSource, 'sessionListHomeObservationByServerId' | 'personalSessionListQueryStatesByServerId'>;
    nextAttentionBoundaryMs: number | null;
}>;

function createHomeCompletedBotsProjector(isSessionVisible: SessionRecordingVisibility): ActivitySourceProjector<MountedHomeCompletedBots> {
    let nowMs = Date.now();
    const table = createActivitySourceAddressTable<ActivityOverviewSnapshot['candidates'][number]>({
        includeWarmSourceWhenNotReady: true,
        classify: (source, addresses) => {
            const overview = buildActivityOverviewFromSource({ source, nowMs, includeWarmSourceWhenNotReady: true, addresses });
            return new Map(overview.candidates.filter(candidate => isHomeCompletedBotCandidate(candidate, isSessionVisible))
                // The source builder attaches the exact address it admitted to every candidate.
                .map(candidate => [sessionAddressKey(candidate.address!), candidate]));
        },
    });
    let published: MountedHomeCompletedBots | undefined;
    return {
        project: ({ source, nowMs: projectedAtMs, state }) => {
            nowMs = projectedAtMs;
            const changed = table.update(source, state);
            if (published && !changed
                && published.source.sessionListHomeObservationByServerId === source.sessionListHomeObservationByServerId
                && published.source.personalSessionListQueryStatesByServerId === source.personalSessionListQueryStatesByServerId) return published;
            const overview = buildActivityOverviewFromCandidates([...table.entries().values()]);
            const { readySessions, markAllReadTargets } = buildInboxSessionPresentation({ overview });
            published = {
                readySessions,
                markAllReadTargets,
                source: {
                    sessionListHomeObservationByServerId: source.sessionListHomeObservationByServerId,
                    personalSessionListQueryStatesByServerId: source.personalSessionListQueryStatesByServerId,
                },
                nextAttentionBoundaryMs: readNextAttentionBoundaryMs(source, overview.candidates, nowMs),
            };
            return published;
        },
        observeUnchangedSource: state => table.observeUnchangedSource(state),
    };
}

/** Completed Bots classify changed addresses and publish only their selected rows or availability. */
export function useHomeCompletedBots(
    isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE,
): MountedHomeCompletedBots {
    const createProjector = React.useMemo(() => () => createHomeCompletedBotsProjector(isSessionVisible), [isSessionVisible]);
    return useSharedActivitySourceProjection(createProjector, retainIfEqual, { changeDetection: 'identity' });
}
