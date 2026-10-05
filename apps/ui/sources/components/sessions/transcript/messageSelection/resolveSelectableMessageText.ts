import { prepareTranscriptMessageBody } from '../messageDisplayText';
import type { Message } from "@happier-dev/session-core/messages";
import { readStreamSegmentMetaV1 } from "@happier-dev/session-core/reducer";

import type { TranscriptSelectableMessageText } from './_types';

export { stripLegacyAttachmentsBlock, unwrapLegacyThinkingWrapper } from '../messageDisplayText';

export function isAgentTextMessageActivelyStreamingForSelection(message: Message): boolean {
    if (message.kind !== 'agent-text') return false;
    const streamSegmentMeta = readStreamSegmentMetaV1(message.meta);
    if (!streamSegmentMeta) return false;
    if (streamSegmentMeta.segmentState === 'streaming') return true;
    return streamSegmentMeta.segmentKind === 'assistant' && streamSegmentMeta.segmentState === null;
}

function normalizeResolvedText(entry: TranscriptSelectableMessageText): TranscriptSelectableMessageText | null {
    if (!entry.text.trim()) return null;
    return entry;
}

export function resolveSelectableMessageText(input: {
    message: Message;
    isStructuredOnly: boolean;
    hasAttachmentBlockToStrip: boolean;
}): TranscriptSelectableMessageText | null {
    const { message } = input;

    if (message.kind === 'user-text') {
        const text = input.isStructuredOnly
            ? message.text
            : prepareTranscriptMessageBody(message, input).text;
        if (text == null) return null;
        return normalizeResolvedText({ role: 'user', text });
    }

    if (message.kind === 'agent-text') {
        if (isAgentTextMessageActivelyStreamingForSelection(message)) return null;
        const text = input.isStructuredOnly
            ? message.text
            : prepareTranscriptMessageBody(message).text;
        if (text == null) return null;
        return normalizeResolvedText({ role: 'assistant', text });
    }

    return null;
}
