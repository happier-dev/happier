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
/** Stable stand-in for "no slice to project", so the snapshot never churns. */
const NO_SESSION_MESSAGES_SLICE: unknown = Object.freeze({});

export function useVoiceSurfaceConversationState(params: Readonly<{
    providerId: string;
    activeControlSessionId: string | null;
    surfaceSessionId: string | null;
    transcriptEnabled: boolean;
    voiceSettings: unknown;
}>) {
    const transcriptEnabled = params.transcriptEnabled;
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
     *  - the whole `voiceSessionBindingStore` state — which re-derives its
     *    persisted layer from *every* registered storage change and always
     *    allocates a new state object, even when the bindings are unchanged
     *    (`voiceConversationBindingStore.ts:179-190,226-230`).
     *
     * Both are replaced by the same derived selector, so `useStoreSnapshot`'s
     * `Object.is` bail-out ends the write: an unrelated session recomputes a
     * string and stops there. Both stores stay subscribed because either can
     * change the answer on its own — a runtime `bind()` never touches storage.
     *
     * The resolver reads both stores itself (`resolveVoiceBindingBySessionId` →
     * `VoiceConversationBindingResolver.ts:38-84`) and walks every persisted
     * session, so the read is cached on both store identities — a write that
     * cannot change the answer costs one reference comparison.
     */
    const subscribeBindingSources = React.useCallback((notify: () => void) => {
        const unsubscribeSessions = (storage as any).subscribe(notify);
        const unsubscribeBindings = voiceSessionBindingStore.subscribe(notify);
        return () => {
            unsubscribeSessions();
            unsubscribeBindings();
        };
    }, []);
    const resolvedBindingCache = React.useRef<
        { sessions: unknown; bindings: unknown; value: string | null } | null
    >(null);
    const readOpenConversationSessionId = React.useCallback((): string | null => {
        const sessions = (storage as any).getState()?.sessions ?? EMPTY_SESSIONS;
        const bindings = voiceSessionBindingStore.getState();
        const cached = resolvedBindingCache.current;
        if (cached && cached.sessions === sessions && cached.bindings === bindings) {
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

        resolvedBindingCache.current = { sessions, bindings, value };
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
    /*
     * Subscribe to the bound conversation's own message slice, not to the whole
     * `sessionMessages` map.
     *
     * The map's identity is replaced by an append in *any* session, so selecting
     * it re-rendered the entire surface — planet, meter and transcript — once per
     * unrelated write while the feed was open (M3: five writes, five renders).
     * The per-session slice is the store's own subscription unit: an unrelated
     * write leaves it untouched, so `useStoreSnapshot`'s `Object.is` bail-out
     * ends the write there. When the feed is off, or nothing is bound yet, a
     * stable constant keeps even that comparison out of the projection path.
     */
    const selectConversationMessagesSlice = React.useCallback(
        (state: any): unknown => (
            transcriptEnabled && openConversationSessionId
                ? state?.sessionMessages?.[openConversationSessionId] ?? NO_SESSION_MESSAGES_SLICE
                : NO_SESSION_MESSAGES_SLICE
        ),
        [openConversationSessionId, transcriptEnabled],
    );
    const conversationMessagesSlice = useStoreSnapshot(
        storage as any,
        selectConversationMessagesSlice,
    );
    const transcriptEntries = React.useMemo(() => {
        if (!transcriptEnabled || !openConversationSessionId) return EMPTY_ENTRIES;
        return selectVoiceTranscriptEntriesForConversationSession(
            { sessionMessages: { [openConversationSessionId]: conversationMessagesSlice } },
            openConversationSessionId,
        );
    }, [transcriptEnabled, openConversationSessionId, conversationMessagesSlice]);
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
