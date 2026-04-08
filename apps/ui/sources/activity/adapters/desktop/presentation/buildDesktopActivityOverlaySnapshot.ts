import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import {
    buildActivitySurfaceViewModels,
    resolvePrimaryActivitySurfaceTarget,
} from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import type { DesktopOverlayPolicy } from '../runtime/resolveDesktopOverlayPolicy';
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';

export type DesktopActivityOverlaySessionSnapshot = Pick<
    ActivitySurfaceSessionViewModel,
    'sessionId' | 'title' | 'subtitle' | 'statusText' | 'previewText'
>;

export type DesktopActivityOverlaySnapshotLabels = Readonly<{
    sessionsTitle: string;
    emptyTitle: string;
}>;

export type DesktopActivityOverlaySnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    counts: ReturnType<typeof buildActivityOverviewSnapshot>['counts'];
    summaryCounts: ReturnType<typeof buildActivitySurfaceCountsViewModel>;
    primary: DesktopActivityOverlaySessionSnapshot | null;
    sessions: readonly DesktopActivityOverlaySessionSnapshot[];
    defaultTarget: string;
    labels: DesktopActivityOverlaySnapshotLabels;
}>;

function buildDesktopActivityOverlaySnapshotLabels(): DesktopActivityOverlaySnapshotLabels {
    return {
        sessionsTitle: t('tabs.sessions'),
        emptyTitle: t('tabs.sessions'),
    };
}

function resolveDesktopOverlaySessions(params: Readonly<{
    overview: ReturnType<typeof buildActivityOverviewSnapshot>;
    selectedSessions: readonly ActivitySurfaceSessionViewModel[];
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    nowMs: number;
}>): readonly DesktopActivityOverlaySessionSnapshot[] {
    if (params.selectedSessions.length > 0) {
        return params.selectedSessions;
    }
    if (params.desktopPolicy.visibilityMode !== 'always_when_enabled') {
        return [];
    }
    if (params.overview.candidates.length === 0) {
        return [];
    }

    return buildActivitySurfaceViewModels({
        candidates: params.overview.candidates,
        policy: params.activityPolicy,
        showMachinePath: true,
        showPreviewText: params.desktopPolicy.showPreviewText,
        nowMs: params.nowMs,
    });
}

export function buildDesktopActivityOverlaySnapshot(params: Readonly<{
    sessions: readonly Session[];
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    nowMs?: number;
}>): DesktopActivityOverlaySnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const overview = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: resolveDesktopOverlaySelectionSpec(params.desktopPolicy),
    });
    const selectedSessions = buildActivitySurfaceViewModels({
        candidates: slots.selectedSessions,
        policy: params.activityPolicy,
        showMachinePath: true,
        showPreviewText: params.desktopPolicy.showPreviewText,
        nowMs,
    });
    const desktopSessions = resolveDesktopOverlaySessions({
        overview,
        selectedSessions,
        activityPolicy: params.activityPolicy,
        desktopPolicy: params.desktopPolicy,
        nowMs,
    });

    return {
        version: 1,
        generatedAt: nowMs,
        counts: overview.counts,
        summaryCounts: buildActivitySurfaceCountsViewModel(overview.counts),
        primary: desktopSessions[0] ?? null,
        sessions: desktopSessions,
        defaultTarget: resolvePrimaryActivitySurfaceTarget(
            params.activityPolicy,
            desktopSessions[0]?.sessionId ?? null,
        ),
        labels: buildDesktopActivityOverlaySnapshotLabels(),
    };
}
