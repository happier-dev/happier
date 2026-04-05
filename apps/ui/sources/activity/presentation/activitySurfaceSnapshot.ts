import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy, type ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import { buildActivitySurfaceViewModels } from '@/activity/presentation/buildActivitySurfaceViewModel';
import type {
    ActivitySurfaceCountsViewModel,
    ActivitySurfaceSessionViewModel,
} from '@/activity/presentation/activitySurfaceViewModels';
import {
    createWidgetSelectionSpec,
} from '@/activity/selection/activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import { resolvePrimaryActivitySurfaceTarget } from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

export type ActivitySurfaceSnapshotLabels = Readonly<{
    focusTitle: string;
    sessionsTitle: string;
    emptyTitle: string;
    openLabel: string;
    inboxLabel: string;
    attentionLabel: string;
    runningLabel: string;
    permissionLabel: string;
}>;

export type ActivitySurfaceSnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    counts: ReturnType<typeof buildActivityOverviewSnapshot>['counts'];
    summaryCounts: ActivitySurfaceCountsViewModel;
    primary: ActivitySurfaceSessionViewModel | null;
    sessions: readonly ActivitySurfaceSessionViewModel[];
    defaultTarget: string;
    labels: ActivitySurfaceSnapshotLabels;
}>;

function buildActivitySurfaceSnapshotLabels(policy: ActivitySurfacePolicy): ActivitySurfaceSnapshotLabels {
    const sessionsTitle = (() => {
        switch (policy.widgets.mode) {
            case 'attention':
                return t('settingsNotifications.activitySurfaces.widgets.attentionTitle');
            case 'running':
                return t('settingsNotifications.activitySurfaces.widgets.runningTitle');
            case 'summary':
            default:
                return t('settingsNotifications.activitySurfaces.widgets.summaryTitle');
        }
    })();

    return {
        focusTitle: t('settingsNotifications.activitySurfaces.liveActivities.focusedTitle'),
        sessionsTitle,
        emptyTitle: t('tabs.sessions'),
        openLabel: t('common.open'),
        inboxLabel: t('tabs.inbox'),
        attentionLabel: t('settingsNotifications.activitySurfaces.widgets.attentionTitle'),
        runningLabel: t('settingsNotifications.activitySurfaces.widgets.runningTitle'),
        permissionLabel: t('settingsNotifications.badges.permissionRequestsTitle'),
    };
}

export function buildActivitySurfaceSnapshot(params: Readonly<{
    sessions: readonly Session[];
    policy?: ActivitySurfacePolicy;
    nowMs?: number;
}>): ActivitySurfaceSnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const policy = params.policy ?? resolveActivitySurfacePolicy({});
    const overview = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: createWidgetSelectionSpec(policy),
    });
    const sessions = buildActivitySurfaceViewModels({
        candidates: slots.selectedSessions,
        policy,
        showMachinePath: policy.widgets.showMachinePath,
        showPreviewText: policy.widgets.showPreviewText,
        nowMs,
    });

    return {
        version: 1,
        generatedAt: nowMs,
        counts: overview.counts,
        summaryCounts: buildActivitySurfaceCountsViewModel(overview.counts),
        primary: sessions[0] ?? null,
        sessions,
        defaultTarget: resolvePrimaryActivitySurfaceTarget(policy, sessions[0]?.sessionId ?? null),
        labels: buildActivitySurfaceSnapshotLabels(policy),
    };
}
