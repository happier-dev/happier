import type { Message } from '@happier-dev/session-core/messages';
import { isActivityAgentText, normalizeActivityPreviewText } from './buildActivityPreviewText';

export type RecentActivityMessage = Readonly<{ id: string; role: 'user' | 'agent'; text: string }>;

const NO_MESSAGES: readonly RecentActivityMessage[] = Object.freeze([]);

// The notch's pinned conversation reads the recent turns: enough to fill a tall island, which scrolls past
// its room (owner 11-19: the conversation grows to the screen's height instead of three excerpts).
const RECENT_MESSAGE_COUNT = 20;

/** Read newest-first from the stored order, then display the selected excerpts chronologically. */
export function readRecentActivityMessages(transcript: Readonly<{
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
}> | undefined, hidden: boolean): readonly RecentActivityMessage[] {
    if (hidden || !transcript) return NO_MESSAGES;
    const messages: RecentActivityMessage[] = [];
    for (let index = transcript.messageIdsOldestFirst.length - 1; index >= 0 && messages.length < RECENT_MESSAGE_COUNT; index--) {
        const message = transcript.messagesById[transcript.messageIdsOldestFirst[index]!];
        if (message?.kind !== 'user-text' && !isActivityAgentText(message)) continue;
        const text = normalizeActivityPreviewText(message.text);
        if (text) messages.push({ id: message.id, role: message.kind === 'user-text' ? 'user' : 'agent', text });
    }
    return messages.length > 0 ? messages.reverse() : NO_MESSAGES;
}
