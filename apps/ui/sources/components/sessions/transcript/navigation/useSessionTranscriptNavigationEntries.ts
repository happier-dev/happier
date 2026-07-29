import * as React from 'react';
import {
    buildTranscriptNavigationLoadedMessages,
    buildTranscriptNavigationRemoteMessages,
    createTranscriptNavigationLoadedMessagesCache,
    deriveTranscriptNavigationEntriesWithLoadedMessageCache,
    resolveTranscriptNavigationRemoteHistoryBeforeSeq,
} from '@/components/sessions/transcript/navigation/buildTranscriptNavigationLoadedMessages';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { useTranscriptRootMessages } from '@/components/sessions/transcript/items/useTranscriptRootMessages';
import { useUserMessageHistoryRemoteEntries } from '@/hooks/session/useUserMessageHistory';
import {
    readPersistedSessionMessagePins,
    readSessionMessagePinsRevision,
    savePersistedSessionMessagePins,
    subscribeSessionMessagePinsChanges,
} from '@/sync/domains/state/sessionMessagePinsPersistence';
import {
    toggleSessionMessagePin,
    type PersistedSessionMessagePinV1,
} from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

export type TranscriptNavigationServerAccountScope = Readonly<{
    serverId: string;
    accountId: string;
}> | null;

export type SessionTranscriptNavigationEntriesState = Readonly<{
    sessionMessagePins: readonly PersistedSessionMessagePinV1[];
    togglePersistedSessionMessagePin: (pin: PersistedSessionMessagePinV1) => void;
    transcriptNavigationEntries: readonly TranscriptNavigationEntry[];
}>;

/** Enough prior anchors for the rail/panel to feel complete without downloading whole sessions. */
const TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET = 60;
/** Hard stop so a session whose pages are dominated by agent rows cannot page indefinitely. */
const TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES = 12;

/**
 * The ONE transcript-navigation derivation implementation.
 *
 * Two entry points mount it, and they differ only in where the transcript rows come from:
 * the transcript host already holds them (`useTranscriptRootNavigationState`), while the
 * navigation pane reads them from the session store itself
 * ({@link useSessionTranscriptNavigationEntries}). Nothing here requires a mounted transcript,
 * which is what lets the mobile right-panel route — a separate screen from the transcript —
 * render a complete list instead of whatever the frozen host last published.
 *
 * Cache ownership: the loaded-message/derivation cache is per hook instance (a ref), because
 * two concurrently mounted consumers have per-instance input identities (the pins array, the
 * remote-row projection). A single module-level slot would be invalidated by whichever
 * consumer rendered last and re-derive on every pass for both.
 */
export function useSessionTranscriptNavigationEntriesFromMessages(params: Readonly<{
    activeServerAccountScope: TranscriptNavigationServerAccountScope;
    forkedTranscriptEnabled: boolean;
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    sessionId: string;
}>): SessionTranscriptNavigationEntriesState {
    const {
        activeServerAccountScope,
        forkedTranscriptEnabled,
        messageIdsOldestFirst,
        messagesById,
        sessionId,
    } = params;
    // The canonical pin-change seam: the out-of-band route-id reconcile writer (fired while
    // messages apply) notifies here too, so every mounted consumer agrees on the same revision.
    // A hook-local revision counter would only ever see this hook's own toggle.
    const messagePinsRevision = React.useSyncExternalStore(
        subscribeSessionMessagePinsChanges,
        readSessionMessagePinsRevision,
        readSessionMessagePinsRevision,
    );
    const sessionMessagePins = React.useMemo(
        () => readPersistedSessionMessagePins(sessionId, activeServerAccountScope),
        [activeServerAccountScope, messagePinsRevision, sessionId],
    );
    const transcriptNavigationLoadedMessagesCacheRef = React.useRef<ReturnType<typeof createTranscriptNavigationLoadedMessagesCache> | null>(null);
    if (!transcriptNavigationLoadedMessagesCacheRef.current) {
        transcriptNavigationLoadedMessagesCacheRef.current = createTranscriptNavigationLoadedMessagesCache();
    }
    const transcriptNavigationLoadedMessagesCache = transcriptNavigationLoadedMessagesCacheRef.current;
    const togglePersistedSessionMessagePin = React.useCallback((pin: PersistedSessionMessagePinV1) => {
        const currentPins = readPersistedSessionMessagePins(sessionId, activeServerAccountScope);
        const nextPins = toggleSessionMessagePin(currentPins, pin);
        savePersistedSessionMessagePins(sessionId, nextPins, activeServerAccountScope);
    }, [activeServerAccountScope, sessionId]);
    const transcriptNavigationLoadedMessages = React.useMemo(() => (
        buildTranscriptNavigationLoadedMessages({
            cache: transcriptNavigationLoadedMessagesCache,
            messageIdsOldestFirst,
            messagesById,
            sessionId,
        })
    ), [messageIdsOldestFirst, messagesById, sessionId, transcriptNavigationLoadedMessagesCache]);
    const transcriptNavigationRemoteBeforeSeq = React.useMemo(
        () => resolveTranscriptNavigationRemoteHistoryBeforeSeq(transcriptNavigationLoadedMessages),
        [transcriptNavigationLoadedMessages],
    );
    const remoteHistoryEnabled = !forkedTranscriptEnabled && transcriptNavigationRemoteBeforeSeq !== null;
    const transcriptNavigationRemoteHistory = useUserMessageHistoryRemoteEntries({
        enabled: remoteHistoryEnabled,
        initialBeforeSeq: transcriptNavigationRemoteBeforeSeq,
        sessionId,
    });
    const transcriptNavigationRemoteMessages = React.useMemo(() => (
        buildTranscriptNavigationRemoteMessages({
            sessionId,
            rows: transcriptNavigationRemoteHistory.rows,
        })
    ), [sessionId, transcriptNavigationRemoteHistory.rows]);
    const remoteUserRowCount = React.useMemo(
        () => transcriptNavigationRemoteMessages.reduce((count, message) => (message.role === 'user' ? count + 1 : count), 0),
        [transcriptNavigationRemoteMessages],
    );
    const requestRemoteHistoryNextPage = transcriptNavigationRemoteHistory.requestNextPage;
    const remoteHistoryHasMore = transcriptNavigationRemoteHistory.hasMore;
    const remoteHistoryPagesLoaded = transcriptNavigationRemoteHistory.pagesLoaded;

    // Bounded continuation: keep pulling older pages until navigation holds enough prior turns,
    // never until the whole session is downloaded. Re-running on `transcriptNavigationLoadedMessages`
    // is also what re-drives a page that could not decrypt yet, once session keys arrive.
    React.useEffect(() => {
        if (!remoteHistoryEnabled) return;
        if (!remoteHistoryHasMore) return;
        if (remoteHistoryPagesLoaded >= TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_MAX_PAGES) return;
        if (remoteUserRowCount >= TRANSCRIPT_NAVIGATION_REMOTE_HISTORY_USER_TURN_TARGET) return;
        requestRemoteHistoryNextPage();
    }, [
        remoteHistoryEnabled,
        remoteHistoryHasMore,
        remoteHistoryPagesLoaded,
        remoteUserRowCount,
        requestRemoteHistoryNextPage,
        transcriptNavigationLoadedMessages,
    ]);

    const transcriptNavigationEntries = React.useMemo<TranscriptNavigationEntry[]>(() => {
        return deriveTranscriptNavigationEntriesWithLoadedMessageCache({
            cache: transcriptNavigationLoadedMessagesCache,
            sessionId,
            mode: 'all',
            loadedMessages: transcriptNavigationLoadedMessages,
            remoteMessages: transcriptNavigationRemoteMessages,
            pins: sessionMessagePins,
        });
    }, [sessionId, sessionMessagePins, transcriptNavigationLoadedMessages, transcriptNavigationLoadedMessagesCache, transcriptNavigationRemoteMessages]);

    return {
        sessionMessagePins,
        togglePersistedSessionMessagePin,
        transcriptNavigationEntries,
    };
}

export type SessionTranscriptNavigationEntriesResult = SessionTranscriptNavigationEntriesState & Readonly<{
    /** False while the session transcript has not produced its first page yet. */
    isLoaded: boolean;
}>;

/**
 * Session-scoped entry point: reads the transcript rows and the account scope from the stores,
 * so the navigation pane can render a complete timeline on a surface where the transcript
 * itself is not mounted (the mobile right-panel route) or is frozen behind it.
 */
export function useSessionTranscriptNavigationEntries(sessionId: string): SessionTranscriptNavigationEntriesResult {
    const {
        forkedTranscriptEnabled,
        isLoaded,
        messageIdsOldestFirst,
        messagesById,
    } = useTranscriptRootMessages(sessionId);
    const activeServerAccountScope = useActiveServerAccountScope();
    const state = useSessionTranscriptNavigationEntriesFromMessages({
        activeServerAccountScope,
        forkedTranscriptEnabled,
        messageIdsOldestFirst,
        messagesById,
        sessionId,
    });
    return {
        ...state,
        isLoaded,
    };
}
