import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';

import { useStoreSnapshot } from './useStoreSnapshot';
import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';

type VoiceSurfacePrivacySettings = Readonly<{
    shareFilePaths: boolean;
    shareSessionSummary: boolean;
}>;

const EMPTY_SESSION_MESSAGES: Record<string, unknown> = {};

function selectSessionMessages(state: any): Record<string, unknown> {
    return state?.sessionMessages ?? EMPTY_SESSION_MESSAGES;
}

export function useVoiceSurfaceStoreState(params: Readonly<{
    activeControlSessionId: string | null;
    localConversationMode: string | null;
    providerId: string;
    surfaceSessionId: string | null;
    voicePrivacy: VoiceSurfacePrivacySettings;
}>) {
    const surfaceSessionId = typeof params.surfaceSessionId === 'string' ? params.surfaceSessionId.trim() : '';
    const selectCurrentSession = React.useCallback(
        (state: any) => (surfaceSessionId ? state?.sessions?.[surfaceSessionId] ?? null : null),
        [surfaceSessionId],
    );
    const currentSession = useStoreSnapshot(storage as any, selectCurrentSession);
    const sessionMessages = useStoreSnapshot(storage as any, selectSessionMessages);
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
        sessionLabelById: new Map<string, string>(),
        transcriptEntries,
        visibleTranscriptEntries,
    };
}
