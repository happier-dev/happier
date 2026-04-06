import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import {
    buildActivitySurfaceViewModels,
    resolvePrimaryActivitySurfaceTarget,
} from '@/activity/presentation/buildActivitySurfaceViewModel';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import type { DesktopOverlayPolicy } from '../runtime/resolveDesktopOverlayPolicy';
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';

export type DesktopActivityOverlaySessionSnapshot = Readonly<{
    sessionId: string;
    title: string;
    subtitle: string | null;
    statusText: string | null;
}>;

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

function buildDesktopActivityOverlaySessionSnapshots(params: Readonly<{
    sessions: readonly {
        sessionId: string;
        title: string;
        subtitle: string | null;
        statusText: string | null;
    }[];
}>): readonly DesktopActivityOverlaySessionSnapshot[] {
    return params.sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        subtitle: session.subtitle ?? null,
        statusText: session.statusText ?? null,
    }));
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
        showPreviewText: false,
        nowMs,
    });
    const desktopSessions = buildDesktopActivityOverlaySessionSnapshots({
        sessions: selectedSessions,
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
