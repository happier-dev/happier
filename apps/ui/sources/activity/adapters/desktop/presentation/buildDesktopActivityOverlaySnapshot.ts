import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import { resolvePrimaryActivitySurfaceTarget } from '@/activity/presentation/buildActivitySurfaceViewModel';
import { buildActivitySurfaceViewModels } from '@/activity/presentation/buildActivitySurfaceViewModel';
import type {
    ActivitySurfaceSnapshot,
    ActivitySurfaceSnapshotLabels,
} from '@/activity/presentation/activitySurfaceSnapshot';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import type { DesktopOverlayPolicy } from '../runtime/resolveDesktopOverlayPolicy';
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';

function buildDesktopActivityOverlaySnapshotLabels(): ActivitySurfaceSnapshotLabels {
    return {
        focusTitle: t('settingsDesktop.overlay.title'),
        sessionsTitle: t('tabs.sessions'),
        emptyTitle: t('tabs.sessions'),
        openLabel: t('common.open'),
        inboxLabel: t('tabs.inbox'),
        attentionLabel: t('settingsNotifications.activitySurfaces.widgets.attentionTitle'),
        runningLabel: t('settingsNotifications.activitySurfaces.widgets.runningTitle'),
        permissionLabel: t('settingsNotifications.badges.permissionRequestsTitle'),
    };
}

export function buildDesktopActivityOverlaySnapshot(params: Readonly<{
    sessions: readonly Session[];
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    nowMs?: number;
}>): ActivitySurfaceSnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const overview = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: resolveDesktopOverlaySelectionSpec(params.desktopPolicy),
    });
    const sessions = buildActivitySurfaceViewModels({
        candidates: slots.selectedSessions,
        policy: params.activityPolicy,
        showMachinePath: true,
        showPreviewText: true,
        nowMs,
    });

    return {
        version: 1,
        generatedAt: nowMs,
        counts: overview.counts,
        summaryCounts: buildActivitySurfaceCountsViewModel(overview.counts),
        primary: sessions[0] ?? null,
        sessions,
        defaultTarget: resolvePrimaryActivitySurfaceTarget(
            params.activityPolicy,
            sessions[0]?.sessionId ?? null,
        ),
        labels: buildDesktopActivityOverlaySnapshotLabels(),
    };
}
