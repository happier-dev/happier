import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { ACTIVITY_SURFACE_TARGETS, createActivitySurfaceSessionTarget } from '@/activity/actions/activitySurfaceTargets';
import { buildActivitySurfaceViewModels } from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { createLiveActivitySelectionSpec } from '@/activity/selection/activitySurfaceSelectionTypes';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import {
    buildHappierFocusLiveActivityIdentity,
    buildLiveActivityInstanceKey,
    type LiveActivityIdentity,
} from './liveActivityIdentity';
import { resolveLiveActivityUpdateBudget } from './resolveLiveActivityUpdateBudget';

const LIVE_ACTIVITY_STALE_AFTER_MS = 30 * 60_000;

export type LiveActivitySnapshotFreshness = 'fresh' | 'stale';

export type LiveActivitySnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    staleAt: number;
    serverId: LiveActivityIdentity['serverId'];
    sessionId: string;
    activityName: LiveActivityIdentity['activityName'];
    activityInstanceKey: string;
    title: string;
    subtitle: string | null;
    previewText: string | null;
    statusText: string | null;
    attentionState: ActivitySurfaceSessionViewModel['attentionState'];
    presentationTemplate: ReturnType<typeof resolveLiveActivityUpdateBudget>['template'];
    apnsPriority: ReturnType<typeof resolveLiveActivityUpdateBudget>['apnsPriority'];
    relevanceScore: number;
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
    overview?: ActivityOverviewSnapshot;
    policy: ActivitySurfacePolicy;
    nowMs?: number;
    staleAfterMs?: number;
    preferredPrimarySessionId?: string | null;
    preferredPrimaryActivityInstanceKey?: string | null;
}>): readonly LiveActivitySnapshot[] {
    const nowMs = params.nowMs ?? Date.now();
    const staleAfterMs = typeof params.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
        ? Math.max(0, params.staleAfterMs)
        : LIVE_ACTIVITY_STALE_AFTER_MS;
    const overview = params.overview ?? buildActivityOverviewSnapshot({
        sessions: params.sessions,
        nowMs,
    });
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: createLiveActivitySelectionSpec(params.policy),
        preferredPrimarySessionId: params.preferredPrimarySessionId ?? null,
    });
    const selectedSessions = resolvePreferredPrimaryActivityInstances({
        selectedSessions: slots.selectedSessions,
        eligibleSessions: slots.eligibleSessions,
        preferredPrimaryActivityInstanceKey: params.preferredPrimaryActivityInstanceKey ?? null,
    });
    const cards = buildActivitySurfaceViewModels({
        candidates: selectedSessions,
        policy: params.policy,
        showMachinePath: true,
        showPreviewText: params.policy.liveActivities.showPreviewText,
        nowMs,
    });

    return cards.map((card) => {
        const identity = buildHappierFocusLiveActivityIdentity({
            serverId: card.serverId,
            sessionId: card.sessionId,
        });
        const budget = resolveLiveActivityUpdateBudget({
            attentionState: card.attentionState,
            runtimeVisibility: 'foreground_unlocked',
        });

        return {
            version: 1,
            generatedAt: nowMs,
            staleAt: nowMs + staleAfterMs,
            serverId: identity.serverId,
            sessionId: card.sessionId,
            activityName: identity.activityName,
            activityInstanceKey: buildLiveActivityInstanceKey(identity),
            title: card.title,
            subtitle: card.subtitle,
            previewText: card.previewText,
            statusText: card.statusText,
            attentionState: card.attentionState,
            presentationTemplate: budget.template,
            apnsPriority: budget.apnsPriority,
            relevanceScore: resolveLiveActivityRelevanceScore(card.attentionState),
            defaultTarget: resolveLiveActivityDefaultTarget(params.policy, identity),
            sessionTarget: createActivitySurfaceSessionTarget(card.sessionId, identity.serverId),
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

function resolveLiveActivityDefaultTarget(
    policy: ActivitySurfacePolicy,
    identity: LiveActivityIdentity,
): string {
    if (policy.tapTarget === 'open_sessions') {
        return ACTIVITY_SURFACE_TARGETS.openInbox;
    }

    return createActivitySurfaceSessionTarget(identity.sessionId, identity.serverId);
}

function buildSelectedCandidateActivityInstanceKey(candidate: Readonly<{
    session: Session;
    sessionId: string;
    serverId?: string | null;
}>): string {
    return buildLiveActivityInstanceKey(buildHappierFocusLiveActivityIdentity({
        serverId: candidate.serverId ?? candidate.session.serverId ?? null,
        sessionId: candidate.sessionId,
    }));
}

function resolvePreferredPrimaryActivityInstances(params: Readonly<{
    selectedSessions: readonly SessionActivityAttention[];
    eligibleSessions: readonly SessionActivityAttention[];
    preferredPrimaryActivityInstanceKey: string | null;
}>): readonly SessionActivityAttention[] {
    if (!params.preferredPrimaryActivityInstanceKey || params.selectedSessions.length === 0) {
        return params.selectedSessions;
    }

    const selectedIndex = params.selectedSessions.findIndex((candidate) =>
        buildSelectedCandidateActivityInstanceKey(candidate) === params.preferredPrimaryActivityInstanceKey
    );
    if (selectedIndex === 0) {
        return params.selectedSessions;
    }

    const preferred = selectedIndex > 0
        ? params.selectedSessions[selectedIndex]
        : params.eligibleSessions.find((candidate) =>
            buildSelectedCandidateActivityInstanceKey(candidate) === params.preferredPrimaryActivityInstanceKey
        );
    if (!preferred) return params.selectedSessions;
    return [
        preferred,
        ...params.selectedSessions.filter((candidate) =>
            buildSelectedCandidateActivityInstanceKey(candidate) !== params.preferredPrimaryActivityInstanceKey
        ),
    ].slice(0, params.selectedSessions.length);
}

function resolveLiveActivityRelevanceScore(
    attentionState: ActivitySurfaceSessionViewModel['attentionState'],
): number {
    if (attentionState === 'permission_required' || attentionState === 'action_required') {
        return 100;
    }
    if (attentionState === 'thinking') {
        return 50;
    }
    if (attentionState === 'pending' || attentionState === 'unread') {
        return 30;
    }
    return 10;
}

export function buildStableLiveActivitySnapshotFingerprint(snapshot: LiveActivitySnapshot): string {
    const { generatedAt: _generatedAt, staleAt: _staleAt, ...stableSnapshot } = snapshot;
    return JSON.stringify(stableSnapshot);
}

export function resolveLiveActivitySnapshotFreshness(
    snapshot: Pick<LiveActivitySnapshot, 'staleAt'>,
    nowMs: number = Date.now(),
): LiveActivitySnapshotFreshness {
    return nowMs >= snapshot.staleAt ? 'stale' : 'fresh';
}
