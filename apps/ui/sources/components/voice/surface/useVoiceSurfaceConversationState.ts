import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';

import { useStoreSnapshot } from './useStoreSnapshot';

const EMPTY_ENTRIES: ReadonlyArray<Readonly<{ id: string; createdAt: number; kind: 'user' | 'assistant' | 'note'; text: string }>> = [];

export function useVoiceSurfaceConversationState(params: Readonly<{
    providerId: string;
    localConversationMode: string | null;
    activeControlSessionId: string | null;
    surfaceSessionId: string | null;
    sessionMessages: Record<string, unknown>;
}>) {
    const bindingSnapshot = useStoreSnapshot(voiceSessionBindingStore);
    const storageSnapshot = useStoreSnapshot(storage as any);
    const persistedSessions = (storageSnapshot as any).sessions ?? {};
    const controlSessionCandidates = React.useMemo(
        () =>
            [
                typeof params.activeControlSessionId === 'string' ? params.activeControlSessionId.trim() : '',
                params.providerId === 'realtime_elevenlabs'
                || (params.providerId === 'local_conversation' && params.localConversationMode === 'agent')
                    ? VOICE_AGENT_GLOBAL_SESSION_ID
                    : '',
                typeof params.surfaceSessionId === 'string' ? params.surfaceSessionId.trim() : '',
            ].filter(Boolean),
        [
            params.activeControlSessionId,
            params.localConversationMode,
            params.providerId,
            params.surfaceSessionId,
        ],
    );
    const openConversationSessionId = React.useMemo(() => {
        for (const sessionId of controlSessionCandidates) {
            const binding =
                resolveVoiceBindingBySessionId({
                    sessionId,
                    adapterId: params.providerId,
                })
                ?? resolveVoiceBindingBySessionId({ sessionId });
            if (binding) {
                return binding.conversationSessionId;
            }
        }

        return null;
    }, [
        bindingSnapshot,
        persistedSessions,
        params.providerId,
        controlSessionCandidates,
    ]);
    const fallbackOpenConversationControlSessionId = React.useMemo(
        () => controlSessionCandidates[0] ?? null,
        [controlSessionCandidates],
    );
    const transcriptEntries = React.useMemo(() => {
        if (!openConversationSessionId) return EMPTY_ENTRIES;
        return selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: params.sessionMessages },
            openConversationSessionId,
        );
    }, [openConversationSessionId, params.sessionMessages]);
    const visibleTranscriptEntries = React.useMemo(() => {
        if (transcriptEntries.length === 0) return EMPTY_ENTRIES;
        const tail = transcriptEntries.length > 50
            ? transcriptEntries.slice(transcriptEntries.length - 50)
            : transcriptEntries;
        return [...tail].reverse();
    }, [transcriptEntries]);

    return {
        openConversationSessionId,
        fallbackOpenConversationControlSessionId,
        transcriptEntries,
        visibleTranscriptEntries,
    };
}
