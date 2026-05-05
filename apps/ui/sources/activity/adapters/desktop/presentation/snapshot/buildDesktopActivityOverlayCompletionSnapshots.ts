import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { isRecentActivityCompletion } from '@/activity/attention/activityCompletionTiming';
import { t } from '@/text';

import { DESKTOP_ACTIVITY_OVERLAY_TURN_COMPLETE_AUTO_DISMISS_MS } from '../../desktopActivityOverlayTiming';
import type { DesktopActivityOverlayCompletionStateSnapshot } from './desktopActivityOverlaySnapshotTypes';

function createOpenActionIdentifier(sessionId: string): string {
    return `open-session:${sessionId}`;
}

export function buildDesktopActivityOverlayCompletionSnapshots(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    sessionViewModels: readonly ActivitySurfaceSessionViewModel[];
    serverIdBySessionId?: ReadonlyMap<string, string>;
    nowMs: number;
}>): readonly DesktopActivityOverlayCompletionStateSnapshot[] {
    const candidateById = new Map<string, SessionActivityAttention>();
    for (const candidate of params.candidates) {
        candidateById.set(candidate.sessionId, candidate);
    }

    return params.sessionViewModels
        .filter((viewModel) => isRecentActivityCompletion(
            candidateById.get(viewModel.sessionId)?.lastTurnCompletedAt,
            params.nowMs,
        ))
        .map((viewModel) => {
            const candidate = candidateById.get(viewModel.sessionId);
            const serverId = typeof candidate?.session.serverId === 'string'
                && candidate.session.serverId.trim().length > 0
                ? candidate.session.serverId.trim()
                : viewModel.serverId ?? params.serverIdBySessionId?.get(viewModel.sessionId) ?? null;

            return {
                sessionId: viewModel.sessionId,
                serverId,
                title: viewModel.title,
                summary: t('notifications.activity.readyFallbackBody'),
                openActionIdentifier: createOpenActionIdentifier(viewModel.sessionId),
                variant: 'turn_complete' as const,
                autoDismissMs: DESKTOP_ACTIVITY_OVERLAY_TURN_COMPLETE_AUTO_DISMISS_MS,
                sticky: false,
            };
        });
}
