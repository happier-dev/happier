import type { NormalizedMessage } from '@/sync/typesRaw';
import { compareTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';

export function sortNormalizedMessagesOldestFirst(messages: NormalizedMessage[]): void {
    messages.sort(compareTranscriptMessagesOldestFirst);
}
