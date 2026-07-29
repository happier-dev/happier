import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';

import { useStoreSnapshot } from './useStoreSnapshot';
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
        (state: any) => (activeControlSessionId ? state?.sessions?.[activeControlSessionId] ?? null : null),
        [activeControlSessionId],
    );
    const selectCurrentSession = React.useCallback(
        (state: any) => (surfaceSessionId ? state?.sessions?.[surfaceSessionId] ?? null : null),
        [surfaceSessionId],
    );
    const activeControlSession = useStoreSnapshot(storage as any, selectActiveControlSession);
    const currentSession = useStoreSnapshot(storage as any, selectCurrentSession);
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
