import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceViewModels, resolvePrimaryActivitySurfaceTarget } from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { createLiveActivitySelectionSpec } from '@/activity/selection/activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

export type LiveActivitySnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    sessionId: string;
    title: string;
    subtitle: string | null;
    previewText: string | null;
    statusText: string | null;
    attentionState: ActivitySurfaceSessionViewModel['attentionState'];
    defaultTarget: string;
    sessionTarget: string;
    overflowCount: number;
    totalAttentionCount: number;
    allowActionButtons: boolean;
    labels: Readonly<{
        title: string;
        openLabel: string;
        inboxLabel: string;
        attentionLabel: string;
    }>;
}>;

export function buildLiveActivitySnapshots(params: Readonly<{
    sessions: readonly Session[];
    policy: ActivitySurfacePolicy;
    nowMs?: number;
    preferredPrimarySessionId?: string | null;
}>): readonly LiveActivitySnapshot[] {
    const nowMs = params.nowMs ?? Date.now();
    const overview = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: createLiveActivitySelectionSpec(params.policy),
        preferredPrimarySessionId: params.preferredPrimarySessionId ?? null,
    });
    const cards = buildActivitySurfaceViewModels({
        candidates: slots.selectedSessions,
        policy: params.policy,
        showMachinePath: true,
        showPreviewText: params.policy.liveActivities.showPreviewText,
        nowMs,
    });

    return cards.map((card) => {
        return {
            version: 1,
            generatedAt: nowMs,
            sessionId: card.sessionId,
            title: card.title,
            subtitle: card.subtitle,
            previewText: card.previewText,
            statusText: card.statusText,
            attentionState: card.attentionState,
            defaultTarget: resolvePrimaryActivitySurfaceTarget(params.policy, card.sessionId),
            sessionTarget: card.target,
            overflowCount: slots.overflowCount,
            totalAttentionCount: overview.counts.totalAttention,
            allowActionButtons: params.policy.liveActivities.allowActionButtons,
            labels: {
                title: t('settingsNotifications.activitySurfaces.liveActivities.title'),
                openLabel: t('common.open'),
                inboxLabel: t('tabs.inbox'),
                attentionLabel: t('settingsNotifications.activitySurfaces.widgets.attentionTitle'),
            },
        };
    });
}
