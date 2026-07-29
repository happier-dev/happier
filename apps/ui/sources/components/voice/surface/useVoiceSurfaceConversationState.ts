import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';
import {
    readCanonicalVoiceTranscriptSnapshot,
    subscribeCanonicalVoiceTranscript,
} from '@/voice/transcript/voiceConversationTranscript';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import type { CanonicalVoiceTranscriptItem } from '@/voice/transcript/canonicalProjector';

import { useStoreSnapshot } from './useStoreSnapshot';
import {
    mergeVoiceSurfaceTranscriptEntries,
    type VoiceSurfaceTranscriptEntry,
} from './mergeVoiceSurfaceTranscriptEntries';

const EMPTY_ENTRIES: ReadonlyArray<Readonly<{ id: string; createdAt: number; kind: 'user' | 'assistant' | 'note'; text: string }>> = [];
const EMPTY_CANONICAL_ENTRIES: readonly CanonicalVoiceTranscriptItem[] = Object.freeze([]);
const EMPTY_SURFACE_ENTRIES: readonly VoiceSurfaceTranscriptEntry[] = Object.freeze([]);
const EMPTY_SESSIONS: Record<string, unknown> = {};
const EMPTY_SESSION_MESSAGES: Record<string, unknown> = {};

function selectPersistedSessions(state: any): Record<string, unknown> {
    return state?.sessions ?? EMPTY_SESSIONS;
}

export function useVoiceSurfaceConversationState(params: Readonly<{
    providerId: string;
    activeControlSessionId: string | null;
    surfaceSessionId: string | null;
    transcriptEnabled: boolean;
    voiceSettings: unknown;
}>) {
    const transcriptEnabled = params.transcriptEnabled;
    const bindingSnapshot = useStoreSnapshot(voiceSessionBindingStore);
    const persistedSessions = useStoreSnapshot(storage as any, selectPersistedSessions);
    const surfaceCapabilities = resolveVoiceAdapterSurfaceCapabilities(
        params.providerId,
        params.voiceSettings,
    );
    const controlSessionCandidates = React.useMemo(
        () =>
            [
                typeof params.activeControlSessionId === 'string' ? params.activeControlSessionId.trim() : '',
                surfaceCapabilities?.controlSessionScope === 'global' ? VOICE_AGENT_GLOBAL_SESSION_ID : '',
                typeof params.surfaceSessionId === 'string' ? params.surfaceSessionId.trim() : '',
            ].filter(Boolean),
        [
            params.activeControlSessionId,
            params.providerId,
            params.surfaceSessionId,
            surfaceCapabilities?.controlSessionScope,
            params.voiceSettings,
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
    // Only subscribe to the (potentially large) sessionMessages map and recompute
    // the transcript projection when the activity feed is actually shown. When the
    // feed is disabled we read a stable empty constant so message appends in any
    // session never re-run the projection or re-render the surface.
    const sessionMessages = useStoreSnapshot(
        storage as any,
        transcriptEnabled ? selectSessionMessages : selectNoSessionMessages,
    );
    const transcriptEntries = React.useMemo(() => {
        if (!transcriptEnabled || !openConversationSessionId) return EMPTY_ENTRIES;
        return selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages },
            openConversationSessionId,
        );
    }, [transcriptEnabled, openConversationSessionId, sessionMessages]);
    const subscribeCanonical = React.useCallback(
        (listener: () => void) => openConversationSessionId
            ? subscribeCanonicalVoiceTranscript(openConversationSessionId, listener)
            : () => {},
        [openConversationSessionId],
    );
    const readCanonical = React.useCallback(
        () => openConversationSessionId
            ? readCanonicalVoiceTranscriptSnapshot(openConversationSessionId)
            : EMPTY_CANONICAL_ENTRIES,
        [openConversationSessionId],
    );
    const canonicalEntries = React.useSyncExternalStore(subscribeCanonical, readCanonical, readCanonical);
    const mergedTranscriptEntries: readonly VoiceSurfaceTranscriptEntry[] = React.useMemo(
        () => transcriptEnabled
            ? mergeVoiceSurfaceTranscriptEntries(transcriptEntries, canonicalEntries)
            : EMPTY_SURFACE_ENTRIES,
        [canonicalEntries, transcriptEnabled, transcriptEntries],
    );
    const visibleTranscriptEntries: readonly VoiceSurfaceTranscriptEntry[] = React.useMemo(() => {
        if (mergedTranscriptEntries.length === 0) return EMPTY_SURFACE_ENTRIES;
        const tail = mergedTranscriptEntries.length > 50
            ? mergedTranscriptEntries.slice(mergedTranscriptEntries.length - 50)
            : mergedTranscriptEntries;
        return [...tail].reverse();
    }, [mergedTranscriptEntries]);

    return {
        openConversationSessionId,
        fallbackOpenConversationControlSessionId,
        transcriptEntries: mergedTranscriptEntries,
        visibleTranscriptEntries,
    };
}

function selectSessionMessages(state: any): Record<string, unknown> {
    return state?.sessionMessages ?? EMPTY_SESSION_MESSAGES;
}

function selectNoSessionMessages(): Record<string, unknown> {
    return EMPTY_SESSION_MESSAGES;
}
