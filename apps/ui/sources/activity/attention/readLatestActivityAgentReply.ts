import type { Message } from '@happier-dev/session-core/messages';
import { isActivityAgentText, normalizeActivityPreviewText } from './buildActivityPreviewText';

/** Read only the newest reply; do not materialize or sort the transcript. */
export function readLatestActivityAgentReply(transcript: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}> | undefined): string | null {
    if (!transcript) return null;
    for (let index = transcript.messageIdsOldestFirst.length - 1; index >= 0; index--) {
        const message = transcript.messagesById[transcript.messageIdsOldestFirst[index]!];
        if (isActivityAgentText(message)) return normalizeActivityPreviewText(message.text) || null;
    }
    return null;
}
