import * as React from 'react';
import {
    buildTranscriptNavigationLoadedMessages,
    createTranscriptNavigationLoadedMessagesCache,
    deriveTranscriptNavigationEntriesWithLoadedMessageCache,
} from '@/components/sessions/transcript/navigation/buildTranscriptNavigationLoadedMessages';
import {
    deriveTranscriptNavigationRemoteUserTurns,
    resolveTranscriptNavigationRemoteUserTurnBeforeSeq,
} from '@/components/sessions/transcript/navigation/transcriptNavigationRemoteUserTurns';
import type { TranscriptNavigationEntry } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { useUserMessageHistoryRemoteEntries } from '@/hooks/session/useUserMessageHistory';
import {
    readPersistedSessionMessagePins,
    savePersistedSessionMessagePins,
} from '@/sync/domains/state/sessionMessagePinsPersistence';
import {
    toggleSessionMessagePin,
    type PersistedSessionMessagePinV1,
} from '@/sync/domains/messages/pins/sessionMessagePins';
import type { Message } from '@/sync/domains/messages/messageTypes';

type ActiveServerAccountScope = Readonly<{
    serverId: string;
    accountId: string;
}> | null;

export function useTranscriptRootNavigationState(params: Readonly<{
    activeServerAccountScope: ActiveServerAccountScope;
    forkedTranscriptEnabled: boolean;
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    sessionId: string;
}>) {
    const {
        activeServerAccountScope,
        forkedTranscriptEnabled,
        messageIdsOldestFirst,
        messagesById,
        sessionId,
    } = params;
    const [messagePinsRevision, bumpMessagePinsRevision] = React.useReducer((value: number) => value + 1, 0);
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
        bumpMessagePinsRevision();
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
        () => resolveTranscriptNavigationRemoteUserTurnBeforeSeq(transcriptNavigationLoadedMessages),
        [transcriptNavigationLoadedMessages],
    );
    const transcriptNavigationRemoteHistory = useUserMessageHistoryRemoteEntries({
        autoLoad: transcriptNavigationRemoteBeforeSeq !== null,
        enabled: !forkedTranscriptEnabled && transcriptNavigationRemoteBeforeSeq !== null,
        initialBeforeSeq: transcriptNavigationRemoteBeforeSeq,
        sessionId,
    });
    const transcriptNavigationRemoteUserTurns = React.useMemo(() => (
        deriveTranscriptNavigationRemoteUserTurns({
            sessionId,
            beforeSeq: transcriptNavigationRemoteBeforeSeq,
            entries: transcriptNavigationRemoteHistory.entries,
        })
    ), [sessionId, transcriptNavigationRemoteBeforeSeq, transcriptNavigationRemoteHistory.entries]);
    const transcriptNavigationEntries = React.useMemo<TranscriptNavigationEntry[]>(() => {
        return deriveTranscriptNavigationEntriesWithLoadedMessageCache({
            cache: transcriptNavigationLoadedMessagesCache,
            sessionId,
            mode: 'all',
            loadedMessages: transcriptNavigationLoadedMessages,
            remoteUserTurns: transcriptNavigationRemoteUserTurns,
            pins: sessionMessagePins,
        });
    }, [sessionId, sessionMessagePins, transcriptNavigationLoadedMessages, transcriptNavigationLoadedMessagesCache, transcriptNavigationRemoteUserTurns]);

    return {
        sessionMessagePins,
        togglePersistedSessionMessagePin,
        transcriptNavigationEntries,
    };
}
