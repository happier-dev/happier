import { shouldRequestTranscriptNavigationRemotePage } from './resolveTranscriptNavigationRemoteBackfill';
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
/** Hard stop so a session whose pages are dominated by agent rows cannot page indefinitely. */

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
    /**
     * Whether a surface can display these entries. Defaults to true so the demand-opened
     * navigation pane is unchanged; the always-mounted transcript host passes the rail's
     * own platform rule, because on native the rail never appears.
     */
    remoteBackfillEnabled?: boolean;
}>): SessionTranscriptNavigationEntriesState {
    const remoteBackfillEnabled = params.remoteBackfillEnabled !== false;
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
    /**
     * Cursor for the backfill: the oldest seq the loaded window already holds, so paging resumes
     * below it instead of re-downloading it.
     *
     * A forked transcript deliberately starts from the newest page instead. Its loaded rows are a
     * CONCATENATION of segments — read-only ancestor context plus this session's own turns — and
     * each segment is numbered in its own session's seq space, which can sit far above or below
     * this one (observed live: ancestor max seq 417_565 against a fork's 15_038). The minimum over
     * that mixture is not a position in this session's history, so using it as a cursor pages from
     * a meaningless offset. Starting at the newest page costs one overlapping page and is always
     * a real position.
     */
    const transcriptNavigationRemoteBeforeSeq = React.useMemo(
        () => (forkedTranscriptEnabled
            ? null
            : resolveTranscriptNavigationRemoteHistoryBeforeSeq(transcriptNavigationLoadedMessages)),
        [forkedTranscriptEnabled, transcriptNavigationLoadedMessages],
    );
    // A missing cursor is not a reason to fetch nothing: it is the newest page, which is exactly
    // what a surface with no transcript loaded needs. Gating enablement on it also detached this
    // consumer from the shared history record, so it could not even read rows another consumer
    // had already downloaded.
    //
    // Every session owns its own seq range, forked or not, so its own prior turns are always
    // pageable — a fork that stood down entirely left the trail holding only whatever turns the
    // window happened to have materialized (observed live: 3 markers, and 0 on a sibling, where
    // the rail needs 2 to appear at all). Ancestor segments stay unpaged: they are read-only
    // context rendered above the fork divider, not turns of this session.
    const transcriptNavigationRemoteHistory = useUserMessageHistoryRemoteEntries({
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
    const loadedUserTurnCount = React.useMemo(
        () => transcriptNavigationLoadedMessages.reduce(
            (count, message) => (message.role === 'user' ? count + 1 : count),
            0,
        ),
        [transcriptNavigationLoadedMessages],
    );
    const requestRemoteHistoryNextPage = transcriptNavigationRemoteHistory.requestNextPage;
    const remoteHistoryHasMore = transcriptNavigationRemoteHistory.hasMore;
    const remoteHistoryPagesLoaded = transcriptNavigationRemoteHistory.pagesLoaded;

    // Bounded continuation: keep pulling older pages until navigation holds enough prior turns,
    // never until the whole session is downloaded. Re-running on `transcriptNavigationLoadedMessages`
    // is also what re-drives a page that could not decrypt yet, once session keys arrive.
    //
    // "Holds" counts the loaded window too — see `shouldRequestTranscriptNavigationRemotePage`,
    // which owns the policy. This used to weigh remote rows alone, so a transcript already
    // showing plenty of prior turns still downloaded a full target's worth of history behind
    // it; measured on remote-dev 2026-08-18 this ran to its 12-page ceiling during session open
    // and decrypted hundreds of messages the transcript never needed.
    React.useEffect(() => {
        if (!shouldRequestTranscriptNavigationRemotePage({
            hasMore: remoteHistoryHasMore,
            pagesLoaded: remoteHistoryPagesLoaded,
            loadedUserTurnCount: loadedUserTurnCount,
            remoteUserTurnCount: remoteUserRowCount,
            hasVisibleConsumer: remoteBackfillEnabled,
        })) return;
        requestRemoteHistoryNextPage();
    }, [
        loadedUserTurnCount,
        remoteHistoryHasMore,
        remoteBackfillEnabled,
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
