import {
    useSessionTranscriptNavigationEntriesFromMessages,
    type SessionTranscriptNavigationEntriesState,
    type TranscriptNavigationServerAccountScope,
} from '@/components/sessions/transcript/navigation/useSessionTranscriptNavigationEntries';
import { Platform } from 'react-native';

import { isTranscriptNavigationRailSupportedPlatform } from '@/components/sessions/transcript/navigation/deriveTranscriptNavigationRailLayout';
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
    // The transcript host mounts on every platform, but the rail it feeds is web-only, and
    // native reaches transcript navigation through the phone cockpit pane (which mounts its
    // own consumer on demand). So the remote backfill is enabled here only where the rail can
    // actually appear — otherwise every native session open downloaded and decrypted up to
    // twelve pages of history for a surface that never renders.
    return useSessionTranscriptNavigationEntriesFromMessages({
        ...params,
        remoteBackfillEnabled: isTranscriptNavigationRailSupportedPlatform(
            Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? 'ios' : 'android',
        ),
    });
}
