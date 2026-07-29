import {
    useSessionTranscriptNavigationEntriesFromMessages,
    type SessionTranscriptNavigationEntriesState,
    type TranscriptNavigationServerAccountScope,
} from '@/components/sessions/transcript/navigation/useSessionTranscriptNavigationEntries';
import type { Message } from '@/sync/domains/messages/messageTypes';

/**
 * Transcript-host entry point into the single navigation derivation owner
 * (`useSessionTranscriptNavigationEntriesFromMessages`). The host already holds the
 * transcript rows, so it passes them in rather than re-subscribing to the session store.
 */
export function useTranscriptRootNavigationState(params: Readonly<{
    activeServerAccountScope: TranscriptNavigationServerAccountScope;
    forkedTranscriptEnabled: boolean;
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    sessionId: string;
}>): SessionTranscriptNavigationEntriesState {
    return useSessionTranscriptNavigationEntriesFromMessages(params);
}
