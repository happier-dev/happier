import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';

import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';

type VoiceSurfacePrivacySettings = Readonly<{
    shareFilePaths: boolean;
    shareSessionSummary: boolean;
}>;

export function useVoiceSurfaceStoreState(params: Readonly<{
    activeControlSessionId: string | null;
    providerId: string;
    surfaceSessionId: string | null;
    transcriptEnabled: boolean;
    voiceSettings: unknown;
    voicePrivacy: VoiceSurfacePrivacySettings;
}>) {
    const activeControlSessionId =
        typeof params.activeControlSessionId === 'string' ? params.activeControlSessionId.trim() : '';
    const surfaceSessionId = typeof params.surfaceSessionId === 'string' ? params.surfaceSessionId.trim() : '';
    const selectActiveControlSession = React.useCallback(
        (state: ReturnType<typeof storage.getState>) => (activeControlSessionId ? state.sessions[activeControlSessionId] ?? null : null),
        [activeControlSessionId],
    );
    const selectCurrentSession = React.useCallback(
        (state: ReturnType<typeof storage.getState>) => (surfaceSessionId ? state.sessions[surfaceSessionId] ?? null : null),
        [surfaceSessionId],
    );
    const activeControlSession = storage(selectActiveControlSession, { sessions: activeControlSessionId ? [activeControlSessionId] : [] });
    const currentSession = storage(selectCurrentSession, { sessions: surfaceSessionId ? [surfaceSessionId] : [] });
    const {
        openConversationSessionId,
        fallbackOpenConversationControlSessionId,
        transcriptEntries,
        visibleTranscriptEntries,
    } = useVoiceSurfaceConversationState({
        providerId: params.providerId,
        activeControlSessionId: params.activeControlSessionId,
        surfaceSessionId: params.surfaceSessionId,
        transcriptEnabled: params.transcriptEnabled,
        voiceSettings: params.voiceSettings,
    });

    return {
        activeControlSession,
        currentSession,
        fallbackOpenConversationControlSessionId,
        openConversationSessionId,
        transcriptEntries,
        visibleTranscriptEntries,
    };
}
