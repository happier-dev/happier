import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { t } from '@/text';

import type { DesktopActivityOverlayCompletionStateSnapshot } from './desktopActivityOverlaySnapshotTypes';

function createOpenActionIdentifier(sessionId: string): string {
    return `open-session:${sessionId}`;
}

export function buildDesktopActivityOverlayCompletionSnapshots(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    sessionViewModels: readonly ActivitySurfaceSessionViewModel[];
}>): readonly DesktopActivityOverlayCompletionStateSnapshot[] {
    const candidateById = new Map<string, SessionActivityAttention>();
    for (const candidate of params.candidates) {
        candidateById.set(candidate.sessionId, candidate);
    }

    return params.sessionViewModels
        .filter((viewModel) => candidateById.get(viewModel.sessionId)?.attentionState === 'pending')
        .map((viewModel) => ({
            sessionId: viewModel.sessionId,
            title: viewModel.title,
            summary: t('notifications.activity.readyFallbackBody'),
            openActionIdentifier: createOpenActionIdentifier(viewModel.sessionId),
        }));
}
