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
import { getPreferredLanguage } from '@/text';

import {
    mergeVoiceSurfaceTranscriptEntries,
    resolveVoiceSurfaceLatestTranscriptText,
    type VoiceSurfaceTranscriptEntry,
} from './mergeVoiceSurfaceTranscriptEntries';

const EMPTY_ENTRIES: ReadonlyArray<Readonly<{ id: string; createdAt: number; kind: 'user' | 'assistant' | 'note'; text: string }>> = [];
const EMPTY_CANONICAL_ENTRIES: readonly CanonicalVoiceTranscriptItem[] = Object.freeze([]);
const EMPTY_SURFACE_ENTRIES: readonly VoiceSurfaceTranscriptEntry[] = Object.freeze([]);
const EMPTY_SESSIONS: Record<string, unknown> = {};
/** Stable stand-in for "no slice to project", so the snapshot never churns. */
const NO_SESSION_MESSAGES_SLICE: unknown = Object.freeze({});

type VoiceSurfaceConversationParams = Readonly<{
    providerId: string;
    activeControlSessionId: string | null;
    surfaceSessionId: string | null;
    transcriptEnabled: boolean;
    voiceSettings: unknown;
}>;

function useVoiceSurfaceConversationBinding(params: VoiceSurfaceConversationParams) {
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
    /*
     * The surface depends on the **resolved** conversation session id, not on the
     * shape of either store behind it.
     *
     * Two subscriptions were publishing raw store identity here, and each one
     * re-rendered the whole surface on every unrelated session write (M3 measured
     * one render per write, from each):
     *
     *  - `state.sessions` by identity — a new map on every append, presence flip
     *    or metadata patch anywhere in the app;
     *  - the whole `voiceSessionBindingStore` state. The store now retains
     *    equivalent bindings across registered storage refreshes; real binding
     *    changes still need this reader's resolved-session selector.
     *
     * Both are replaced by the same derived selector, so the external-store
     * equality check ends the write: an unrelated session recomputes a
     * string and stops there. Both stores stay subscribed because either can
     * change the answer on its own — a runtime `bind()` never touches storage.
     *
     * The resolver reads both stores itself (`resolveVoiceBindingBySessionId` →
     * `VoiceConversationBindingResolver.ts:38-84`) and walks every persisted
     * session, so the read is cached on both store identities — a write that
     * cannot change the answer costs one reference comparison.
     */
    const subscribeBindingSources = React.useCallback((notify: () => void) => {
        const unsubscribeSessions = storage.subscribe(notify, { sessions: true, sessionListRowsByServerId: true });
        const unsubscribeBindings = voiceSessionBindingStore.subscribe(notify);
        return () => {
            unsubscribeSessions();
            unsubscribeBindings();
        };
    }, []);
    const resolvedBindingCache = React.useRef<
        { sessions: unknown; bindings: unknown; candidates: readonly string[]; providerId: string; value: string | null } | null
    >(null);
    const readOpenConversationSessionId = React.useCallback((): string | null => {
        const sessions = storage.getState().sessions ?? EMPTY_SESSIONS;
        const bindings = voiceSessionBindingStore.getState();
        const cached = resolvedBindingCache.current;
        if (cached && cached.sessions === sessions && cached.bindings === bindings
            && cached.candidates === controlSessionCandidates && cached.providerId === params.providerId) {
            return cached.value;
        }

        let value: string | null = null;
        for (const sessionId of controlSessionCandidates) {
            const binding =
                resolveVoiceBindingBySessionId({
                    sessionId,
                    adapterId: params.providerId,
                })
                ?? resolveVoiceBindingBySessionId({ sessionId });
            if (binding) {
                value = binding.conversationSessionId;
                break;
            }
        }

        resolvedBindingCache.current = { sessions, bindings, candidates: controlSessionCandidates, providerId: params.providerId, value };
        return value;
    }, [
        controlSessionCandidates,
        params.providerId,
    ]);
    const openConversationSessionId = React.useSyncExternalStore(
        subscribeBindingSources,
        readOpenConversationSessionId,
        readOpenConversationSessionId,
    );
    const fallbackOpenConversationControlSessionId = React.useMemo(
        () => controlSessionCandidates[0] ?? null,
        [controlSessionCandidates],
    );
    return { openConversationSessionId, fallbackOpenConversationControlSessionId };
}

/** Demanded by the compact line only; unchanged text is a stable external-store snapshot. */
export function useVoiceSurfaceLatestTranscriptText(params: VoiceSurfaceConversationParams): string | null {
    const { openConversationSessionId } = useVoiceSurfaceConversationBinding(params);
    const language = getPreferredLanguage();
    const subscribe = React.useCallback((notify: () => void) => {
        if (!params.transcriptEnabled || !openConversationSessionId) return () => {};
        const unsubscribeMessages = storage.subscribe(notify, { sessionMessages: [openConversationSessionId], sessions: [openConversationSessionId] });
        const unsubscribeCanonical = subscribeCanonicalVoiceTranscript(openConversationSessionId, notify);
        return () => {
            unsubscribeMessages();
            unsubscribeCanonical();
        };
    }, [openConversationSessionId, params.transcriptEnabled]);
    const read = React.useMemo(() => {
        let cached: Readonly<{ slice: unknown; canonical: readonly CanonicalVoiceTranscriptItem[]; text: string | null }> | null = null;
        return (): string | null => {
            if (!params.transcriptEnabled || !openConversationSessionId) return null;
            const state = storage.getState();
            const slice = state.sessionMessages[openConversationSessionId];
            const canonical = readCanonicalVoiceTranscriptSnapshot(openConversationSessionId);
            if (cached && cached.slice === slice && cached.canonical === canonical) return cached.text;
            const persisted = selectVoiceTranscriptEntriesForConversationSession(state, openConversationSessionId);
            const text = resolveVoiceSurfaceLatestTranscriptText(persisted, canonical);
            cached = { slice, canonical, text };
            return text;
        };
    }, [openConversationSessionId, params.transcriptEnabled, language]);
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useVoiceSurfaceConversationState(params: VoiceSurfaceConversationParams) {
    const { openConversationSessionId, fallbackOpenConversationControlSessionId } = useVoiceSurfaceConversationBinding(params);
    const transcriptEnabled = params.transcriptEnabled;
    const language = getPreferredLanguage();
    // Exact message demand avoids delivery and projection for other Sessions;
    // a closed feed or missing conversation has no storage demand.
    const selectConversationMessagesSlice = React.useCallback(
        (state: ReturnType<typeof storage.getState>): unknown => (
            transcriptEnabled && openConversationSessionId
                ? state?.sessionMessages?.[openConversationSessionId] ?? NO_SESSION_MESSAGES_SLICE
                : NO_SESSION_MESSAGES_SLICE
        ),
        [openConversationSessionId, transcriptEnabled],
    );
    const conversationMessagesSlice = storage(
        selectConversationMessagesSlice,
        { sessionMessages: transcriptEnabled && openConversationSessionId ? [openConversationSessionId] : [] },
    );
    const transcriptEntries = React.useMemo(() => {
        if (!transcriptEnabled || !openConversationSessionId) return EMPTY_ENTRIES;
        return selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { [openConversationSessionId]: conversationMessagesSlice } },
            openConversationSessionId,
        );
    }, [transcriptEnabled, openConversationSessionId, conversationMessagesSlice, language]);
    const subscribeCanonical = React.useCallback(
        (listener: () => void) => transcriptEnabled && openConversationSessionId
            ? subscribeCanonicalVoiceTranscript(openConversationSessionId, listener)
            : () => {},
        [openConversationSessionId, transcriptEnabled],
    );
    const readCanonical = React.useCallback(
        () => transcriptEnabled && openConversationSessionId
            ? readCanonicalVoiceTranscriptSnapshot(openConversationSessionId)
            : EMPTY_CANONICAL_ENTRIES,
        [openConversationSessionId, transcriptEnabled],
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
