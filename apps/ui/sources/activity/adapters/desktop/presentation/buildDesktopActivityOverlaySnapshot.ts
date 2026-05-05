import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import {
    buildActivitySurfaceViewModels,
    resolvePrimaryActivitySurfaceTarget,
} from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import { t } from '@/text';

import type { DesktopActivityOverlaySource } from '../runtime/useDesktopActivityOverlaySource';
import type { DesktopOverlayPolicy } from '../runtime/resolveDesktopOverlayPolicy';
import { buildDesktopActivityOverlayCompanionSnapshot } from './snapshot/buildDesktopActivityOverlayCompanionSnapshot';
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';
import { buildDesktopActivityOverlayCompletionSnapshots } from './snapshot/buildDesktopActivityOverlayCompletionSnapshots';
import { buildDesktopActivityOverlayOverviewFromSource } from './snapshot/buildDesktopActivityOverlayOverviewFromSource';
import { buildDesktopActivityOverlayQuotaSummarySnapshots } from './snapshot/buildDesktopActivityOverlayQuotaSummarySnapshots';
import { buildDesktopActivityOverlayRequestSnapshots } from './snapshot/buildDesktopActivityOverlayRequestSnapshots';
import type {
    DesktopActivityOverlayCompanionSnapshot,
    DesktopActivityOverlaySnapshot,
    DesktopActivityOverlaySnapshotLabels,
    DesktopActivityOverlaySessionSnapshot,
} from './snapshot/desktopActivityOverlaySnapshotTypes';
import type { DesktopActivityOverlayCompanionSnapshotInput } from './snapshot/buildDesktopActivityOverlayCompanionSnapshot';

export type {
    DesktopActivityOverlayCompanionSnapshot,
    DesktopActivityOverlayCompletionStateSnapshot,
    DesktopActivityOverlayQuotaSummarySnapshot,
    DesktopActivityOverlayRequestSnapshot,
    DesktopActivityOverlaySnapshot,
    DesktopActivityOverlaySnapshotLabels,
    DesktopActivityOverlaySnapshotState,
    DesktopActivityOverlaySessionSnapshot,
} from './snapshot/desktopActivityOverlaySnapshotTypes';

function buildDesktopActivityOverlaySnapshotLabels(): DesktopActivityOverlaySnapshotLabels {
    return {
        sessionsTitle: t('tabs.sessions'),
        emptyTitle: t('tabs.sessions'),
    };
}

function buildServerIdBySessionId(
    source: DesktopActivityOverlaySource,
): ReadonlyMap<string, string> {
    const serverIdBySessionId = new Map<string, string>();
    for (const [ownerServerId, items] of Object.entries(source.sessionListIndexByServerId)) {
        const trimmedOwnerServerId = ownerServerId.trim();
        if (!trimmedOwnerServerId || !Array.isArray(items)) {
            continue;
        }
        for (const item of items) {
            if (item.type !== 'session') {
                continue;
            }
            const sessionId = item.sessionId.trim();
            const rawItemServerId = typeof item.serverId === 'string' ? item.serverId : '';
            const serverId = rawItemServerId.trim() || trimmedOwnerServerId;
            if (sessionId && serverId && !serverIdBySessionId.has(sessionId)) {
                serverIdBySessionId.set(sessionId, serverId);
            }
        }
    }
    return serverIdBySessionId;
}

function resolveSessionServerId(
    sessionId: string,
    fallbackServerId: string | null,
    serverIdBySessionId: ReadonlyMap<string, string>,
): string | null {
    const fallback = typeof fallbackServerId === 'string' && fallbackServerId.trim().length > 0
        ? fallbackServerId.trim()
        : null;
    return fallback ?? serverIdBySessionId.get(sessionId) ?? null;
}

function buildDesktopActivityOverlaySessionSnapshots(
    sessionViewModels: readonly ActivitySurfaceSessionViewModel[],
    candidates: readonly SessionActivityAttention[],
    serverIdBySessionId: ReadonlyMap<string, string>,
): readonly DesktopActivityOverlaySessionSnapshot[] {
    const candidateById = new Map<string, SessionActivityAttention>();
    for (const candidate of candidates) {
        candidateById.set(candidate.sessionId, candidate);
    }

    return sessionViewModels.map((viewModel) => {
        const candidate = candidateById.get(viewModel.sessionId);
        return {
            sessionId: viewModel.sessionId,
            serverId: resolveSessionServerId(
                viewModel.sessionId,
                viewModel.serverId,
                serverIdBySessionId,
            ),
            title: viewModel.title,
            subtitle: viewModel.subtitle ?? null,
            statusText: viewModel.statusText ?? null,
            previewText: viewModel.previewText ?? null,
            attentionState: viewModel.attentionState,
            active: candidate?.session.active === true,
            updatedAt: candidate?.session.updatedAt ?? viewModel.updatedAt,
        };
    });
}

export function buildDesktopActivityOverlaySnapshot(params: Readonly<{
    source: DesktopActivityOverlaySource;
    sourceOverview?: ActivityOverviewSnapshot;
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    companion?: DesktopActivityOverlayCompanionSnapshotInput;
    previousPrimarySessionId?: string | null;
    previousPrimaryChangedAtMs?: number | null;
    nowMs?: number;
}>): DesktopActivityOverlaySnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const overview = params.sourceOverview ?? buildDesktopActivityOverlayOverviewFromSource({
        source: params.source,
        nowMs,
    });
    const selectionSpec = resolveDesktopOverlaySelectionSpec(params.desktopPolicy);
    const desktopTiming = overview.candidates[0]?.surfaceTiming?.desktopOverlay;
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: {
            ...selectionSpec,
            dwellMs: desktopTiming?.dwellMs ?? selectionSpec.dwellMs,
            staleAfterMs: desktopTiming?.staleAfterMs ?? selectionSpec.staleAfterMs,
        },
        previousPrimarySessionId: params.previousPrimarySessionId ?? null,
        previousPrimaryChangedAtMs: params.previousPrimaryChangedAtMs ?? null,
        nowMs,
    });
    const selectedSessions = buildActivitySurfaceViewModels({
        candidates: slots.selectedSessions,
        policy: params.activityPolicy,
        showMachinePath: true,
        showPreviewText: params.desktopPolicy.showPreviewText,
        nowMs,
    });
    const serverIdBySessionId = buildServerIdBySessionId(params.source);
    const desktopSessions = buildDesktopActivityOverlaySessionSnapshots(
        selectedSessions,
        slots.selectedSessions,
        serverIdBySessionId,
    );
    const requestSnapshots = buildDesktopActivityOverlayRequestSnapshots({
        candidates: slots.selectedSessions,
        serverIdBySessionId,
    });
    const quotaSummaries = buildDesktopActivityOverlayQuotaSummarySnapshots(params.source.quotaSummaries);
    const completionStates = buildDesktopActivityOverlayCompletionSnapshots({
        candidates: slots.selectedSessions,
        sessionViewModels: selectedSessions,
        serverIdBySessionId,
        nowMs,
    });
    const companion = buildDesktopActivityOverlayCompanionSnapshot({
        selectedSessions: slots.selectedSessions,
        companion: params.companion,
    });
    const state = slots.selectedSessions.length > 0 ? 'content' : 'idle';

    return {
        version: 1,
        generatedAt: nowMs,
        state,
        counts: overview.counts,
        summaryCounts: buildActivitySurfaceCountsViewModel(overview.counts),
        primary: desktopSessions[0] ?? null,
        sessions: desktopSessions,
        permissionRequests: requestSnapshots.permissionRequests,
        userQuestions: requestSnapshots.userQuestions,
        quotaSummaries,
        completionStates,
        companion,
        defaultTarget: resolvePrimaryActivitySurfaceTarget(
            params.activityPolicy,
            desktopSessions[0]?.sessionId ?? null,
        ),
        labels: buildDesktopActivityOverlaySnapshotLabels(),
    };
}
