import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
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
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';
import { buildDesktopActivityOverlayCompletionSnapshots } from './snapshot/buildDesktopActivityOverlayCompletionSnapshots';
import { buildDesktopActivityOverlayOverviewFromSource } from './snapshot/buildDesktopActivityOverlayOverviewFromSource';
import { buildDesktopActivityOverlayQuotaSummarySnapshots } from './snapshot/buildDesktopActivityOverlayQuotaSummarySnapshots';
import { buildDesktopActivityOverlayRequestSnapshots } from './snapshot/buildDesktopActivityOverlayRequestSnapshots';
import type {
    DesktopActivityOverlaySnapshot,
    DesktopActivityOverlaySnapshotLabels,
    DesktopActivityOverlaySessionSnapshot,
} from './snapshot/desktopActivityOverlaySnapshotTypes';

export type {
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

function buildDesktopActivityOverlaySessionSnapshots(
    sessionViewModels: readonly ActivitySurfaceSessionViewModel[],
    candidates: readonly SessionActivityAttention[],
): readonly DesktopActivityOverlaySessionSnapshot[] {
    const candidateById = new Map<string, SessionActivityAttention>();
    for (const candidate of candidates) {
        candidateById.set(candidate.sessionId, candidate);
    }

    return sessionViewModels.map((viewModel) => {
        const candidate = candidateById.get(viewModel.sessionId);
        return {
            sessionId: viewModel.sessionId,
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
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    nowMs?: number;
}>): DesktopActivityOverlaySnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const overview = buildDesktopActivityOverlayOverviewFromSource({
        source: params.source,
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
    const desktopSessions = buildDesktopActivityOverlaySessionSnapshots(selectedSessions, slots.selectedSessions);
    const requestSnapshots = buildDesktopActivityOverlayRequestSnapshots({
        candidates: slots.selectedSessions,
    });
    const quotaSummaries = buildDesktopActivityOverlayQuotaSummarySnapshots(params.source.quotaSummaries);
    const completionStates = buildDesktopActivityOverlayCompletionSnapshots({
        candidates: slots.selectedSessions,
        sessionViewModels: selectedSessions,
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
        defaultTarget: resolvePrimaryActivitySurfaceTarget(
            params.activityPolicy,
            desktopSessions[0]?.sessionId ?? null,
        ),
        labels: buildDesktopActivityOverlaySnapshotLabels(),
    };
}
