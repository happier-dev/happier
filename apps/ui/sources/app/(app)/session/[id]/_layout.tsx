import { Slot, useLocalSearchParams } from 'expo-router';

import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession } from '@/sync/domains/state/storage';
import { isVoiceTranscriptHistorySession } from '@/voice/persistence/voiceTranscriptHistorySession';

export default function OrdinarySessionRouteLayout() {
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const sessionId = normalizeSessionId(params.id);
    const session = useSession(sessionId);
    const isVoiceTranscriptHistory = isVoiceTranscriptHistorySession(session
        ? {
            active: session.active,
            metadata: readSessionOwnerMetadataView(session),
        }
        : null);

    if (isVoiceTranscriptHistory) {
        return <SessionInvalidLinkFallback />;
    }

    return <Slot />;
}
