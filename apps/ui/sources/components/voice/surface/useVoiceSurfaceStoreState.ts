import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { useAllSessions } from '@/sync/store/hooks';
import { resolveVoiceSessionLabel } from '@/voice/context/resolveVoiceSessionLabel';

import { useStoreSnapshot } from './useStoreSnapshot';
import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';

type VoiceSurfacePrivacySettings = Readonly<{
    shareFilePaths: boolean;
    shareSessionSummary: boolean;
}>;

export function useVoiceSurfaceStoreState(params: Readonly<{
    activeControlSessionId: string | null;
    localConversationMode: string | null;
    providerId: string;
    surfaceSessionId: string | null;
    voicePrivacy: VoiceSurfacePrivacySettings;
}>) {
    const allSessions = useAllSessions();
    const currentSession = React.useMemo(() => {
        const sessionId = typeof params.surfaceSessionId === 'string' ? params.surfaceSessionId.trim() : '';
        if (!sessionId) return null;
        return (allSessions as any[]).find((session) => session?.id === sessionId) ?? null;
    }, [allSessions, params.surfaceSessionId]);

    const sessionLabelById = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const session of allSessions as any[]) {
            if (!session || typeof session.id !== 'string') continue;
            const label = resolveVoiceSessionLabel(
                session.id,
                {
                    voiceShareSessionSummary: params.voicePrivacy.shareSessionSummary,
                    voiceShareFilePaths: params.voicePrivacy.shareFilePaths,
                },
                { metadata: session.metadata },
            );
            if (label) {
                labels.set(session.id, label);
            }
        }
        return labels;
    }, [allSessions, params.voicePrivacy.shareFilePaths, params.voicePrivacy.shareSessionSummary]);

    const storageState = useStoreSnapshot(storage as any);
    const sessionMessages = (storageState as any).sessionMessages ?? {};
    const {
        openConversationSessionId,
        fallbackOpenConversationControlSessionId,
        transcriptEntries,
        visibleTranscriptEntries,
    } = useVoiceSurfaceConversationState({
        providerId: params.providerId,
        localConversationMode: params.localConversationMode,
        activeControlSessionId: params.activeControlSessionId,
        surfaceSessionId: params.surfaceSessionId,
        sessionMessages,
    });

    return {
        currentSession,
        fallbackOpenConversationControlSessionId,
        openConversationSessionId,
        sessionLabelById,
        transcriptEntries,
        visibleTranscriptEntries,
    };
}
