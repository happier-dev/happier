import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { selectActivitySurfaceCandidates } from '@/activity/attention/selectActivitySurfaceCandidates';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import {
    buildActivitySurfaceSessionCard,
    resolvePrimaryActivitySurfaceTarget,
    type ActivitySurfaceSessionCard,
} from '../widgets/buildActivitySurfaceSessionCard';

export type LiveActivitySnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    sessionId: string;
    title: string;
    subtitle: string | null;
    statusText: string | null;
    attentionState: ActivitySurfaceSessionCard['attentionState'];
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
}>): readonly LiveActivitySnapshot[] {
    const nowMs = params.nowMs ?? Date.now();
    const overview = buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const selected = selectActivitySurfaceCandidates({
        overview,
        surface: 'liveActivities',
        policy: params.policy,
    });
    const eligible = selectActivitySurfaceCandidates({
        overview,
        surface: 'liveActivities',
        policy: params.policy,
        applyCap: false,
    });
    const overflowCount = Math.max(0, eligible.length - selected.length);

    return selected.map((candidate) => {
        const card = buildActivitySurfaceSessionCard({
            candidate,
            policy: params.policy,
            showMachinePath: true,
            showPreviewText: params.policy.liveActivities.showPreviewText,
            isPrimary: true,
            nowMs,
        });

        return {
            version: 1,
            generatedAt: nowMs,
            sessionId: candidate.sessionId,
            title: card.title,
            subtitle: card.subtitle,
            statusText: card.statusText,
            attentionState: card.attentionState,
            defaultTarget: resolvePrimaryActivitySurfaceTarget(params.policy, candidate.sessionId),
            sessionTarget: card.target,
            overflowCount,
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
