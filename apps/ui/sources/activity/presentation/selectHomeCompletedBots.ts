import type { InboxSessionPresentation } from './buildInboxSessionPresentation';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { readSessionListPresentationDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { ALL_SESSIONS_RECORDING_VISIBLE, type SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';

export type HomeCompletedBots = Pick<InboxSessionPresentation, 'readySessions' | 'markAllReadTargets'>;

export function isHomeCompletedBotCandidate(candidate: SessionActivityAttention, isSessionVisible: SessionRecordingVisibility): boolean {
    if (!isSessionVisible({ sessionId: candidate.sessionId, serverId: candidate.address?.serverId ?? candidate.serverId })) return false;
    const display = candidate.presentationSource
        ? readSessionListPresentationDisplay(candidate.presentationSource) : candidate.session;
    return readSessionBotV1(display.metadata?.bot) !== null;
}

export function selectHomeCompletedBots(presentation: InboxSessionPresentation, isSessionVisible: SessionRecordingVisibility = ALL_SESSIONS_RECORDING_VISIBLE): HomeCompletedBots {
    const readySessions = presentation.readySessions.filter(candidate => isHomeCompletedBotCandidate(candidate, isSessionVisible));
    const keys = new Set(readySessions.map(candidate => buildServerScopedSessionKey(candidate.sessionId,
        candidate.address?.serverId ?? candidate.serverId ?? null)));
    return { readySessions, markAllReadTargets: presentation.markAllReadTargets.filter(target => keys.has(target.key)) };
}
