import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';

export function sortNormalizedMessagesOldestFirst(messages: NormalizedMessage[]): void {
    messages.sort(compareTranscriptMessagesOldestFirst);
}
