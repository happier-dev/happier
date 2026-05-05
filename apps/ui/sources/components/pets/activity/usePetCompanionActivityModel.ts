import * as React from 'react';

import {
    useAllSessions,
    useHasUnreadMessages,
    useSessionMessages,
    useSessionLatestThinkingMessageActivityAtMs,
    useSessionListMeaningfulActivityAt,
    useSessionPendingMessages,
} from '@/sync/domains/state/storage';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { buildPetCompanionActivityModel } from './buildPetCompanionActivityModel';
import type {
    PetCompanionActivityModel,
    PetCompanionSessionSignals,
} from './petCompanionActivityTypes';

function selectCompanionSessionId(sessions: readonly Session[]): string | null {
    return sessions.find((session) => session.active)?.id ?? sessions[0]?.id ?? null;
}

function hasMessageFailure(message: Message): boolean {
    if (message.kind !== 'tool-call') return false;
    if (message.tool.state === 'error') return true;
    return message.children.some(hasMessageFailure);
}

export function usePetCompanionActivityModel(input?: Readonly<{
    dismissedTrayItemKeys?: ReadonlySet<string>;
}>): PetCompanionActivityModel {
    const sessions = useAllSessions();
    const selectedSessionId = React.useMemo(() => selectCompanionSessionId(sessions), [sessions]);
    const signalSessionId = selectedSessionId ?? '';
    const hasUnreadMessages = useHasUnreadMessages(signalSessionId);
    const latestThinkingActivityAtMs = useSessionLatestThinkingMessageActivityAtMs(signalSessionId);
    const latestMeaningfulActivityAtMs = useSessionListMeaningfulActivityAt(signalSessionId);
    const pendingMessages = useSessionPendingMessages(signalSessionId);
    const sessionMessages = useSessionMessages(signalSessionId);
    const dismissedTrayItemKeys = input?.dismissedTrayItemKeys;
    const hasFailure = React.useMemo(
        () => sessionMessages.messages.some(hasMessageFailure),
        [sessionMessages.messages],
    );
    const signalsBySessionId = React.useMemo(() => {
        if (!selectedSessionId) return {};
        const signals: PetCompanionSessionSignals = {
            hasFailure,
            hasUnreadMessages,
            latestThinkingActivityAtMs,
            latestMeaningfulActivityAtMs,
            pendingMessageCount: pendingMessages.messages.length,
        };
        return { [selectedSessionId]: signals };
    }, [
        hasFailure,
        hasUnreadMessages,
        latestMeaningfulActivityAtMs,
        latestThinkingActivityAtMs,
        pendingMessages.messages.length,
        selectedSessionId,
    ]);

    return React.useMemo(() => buildPetCompanionActivityModel({
        sessions,
        selectedSessionId,
        signalsBySessionId,
        dismissedTrayItemKeys,
    }), [dismissedTrayItemKeys, selectedSessionId, sessions, signalsBySessionId]);
}
