import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { resolveActivitySurfacePolicy, type ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { selectActivitySurfaceCandidates } from '@/activity/attention/selectActivitySurfaceCandidates';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import {
    buildActivitySurfaceSessionCard,
    resolvePrimaryActivitySurfaceTarget,
    type ActivitySurfaceSessionCard,
} from './buildActivitySurfaceSessionCard';

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
    primary: ActivitySurfaceSessionCard | null;
    sessions: readonly ActivitySurfaceSessionCard[];
    overflowCount: number;
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
    const selectedCandidates = selectActivitySurfaceCandidates({
        overview,
        surface: 'widgets',
        policy,
    });
    const eligibleCandidates = selectActivitySurfaceCandidates({
        overview,
        surface: 'widgets',
        policy,
    });

    const sessions = selectedCandidates.map((candidate, index) =>
        buildActivitySurfaceSessionCard({
            candidate,
            policy,
            showMachinePath: policy.widgets.showMachinePath,
            showPreviewText: policy.widgets.showPreviewText,
            isPrimary: index === 0,
            nowMs,
        }),
    );

    return {
        version: 1,
        generatedAt: nowMs,
        counts: overview.counts,
        primary: sessions[0] ?? null,
        sessions,
        overflowCount: Math.max(0, eligibleCandidates.length - sessions.length),
        defaultTarget: resolvePrimaryActivitySurfaceTarget(policy, sessions[0]?.sessionId ?? null),
        labels: buildActivitySurfaceSnapshotLabels(policy),
    };
}
