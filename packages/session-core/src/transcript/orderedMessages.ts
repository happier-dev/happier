import type { Message } from "../messages/messageTypes.js";
import { compareTranscriptMessagesOldestFirst, hasTranscriptMessageOrderChanged, mergeTranscriptMessageIdsOldestFirst } from "../messages/transcriptOrdering.js";
import {patchMessageRecord} from './messageRecord.js';

export type OrderedTranscript = {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
};

/**
 * Apply reducer output without changing any previously published transcript.
 * Unchanged Message objects and unchanged order keep their references.
 */
export function applyReducedMessages<T extends OrderedTranscript>(prev: T, changed: readonly Message[]): T {
    const idsToRemove = new Set<string>();
    const idsToInsert: string[] = [];
    const messagesById = patchMessageRecord(prev.messagesById, changed);
    if (messagesById === prev.messagesById) return prev;
    for (const message of changed) {
        const previous = prev.messagesById[message.id];
        if (previous === message) continue;
        if (!previous) {
            idsToInsert.push(message.id);
        } else if (hasTranscriptMessageOrderChanged(previous, message)) {
            idsToRemove.add(message.id);
            idsToInsert.push(message.id);
        }
    }
    if (idsToInsert.length === 0) return { ...prev, messagesById };

    const uniqueInsertIds = Array.from(new Set(idsToInsert));
    uniqueInsertIds.sort((a, b) => compareTranscriptMessagesOldestFirst(messagesById[a]!, messagesById[b]!));
    const existingIds = prev.messageIdsOldestFirst;
    const nextIds = mergeTranscriptMessageIdsOldestFirst(
        idsToRemove.size > 0 ? existingIds.filter((id) => !idsToRemove.has(id)) : existingIds,
        uniqueInsertIds,
        messagesById,
    ).messageIdsOldestFirst;
    return { ...prev, messagesById, messageIdsOldestFirst: nextIds };
}
