import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';

import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';

import type { TranscriptSelectableMessageText } from './_types';

export function stripLegacyAttachmentsBlock(text: string): string {
    const startTag = '[attachments]';
    const endTag = '[/attachments]';
    const start = text.indexOf(startTag);
    const end = text.indexOf(endTag);
    if (start < 0 || end < 0 || end <= start) return text;

    let stripStart = start;
    const intro = text.lastIndexOf('Attachments:', start);
    if (intro >= 0) {
        const lineStart = text.lastIndexOf('\n', intro - 1) + 1;
        if (lineStart === intro || text.slice(lineStart, intro).trim() === '') {
            stripStart = lineStart;
        }
    }

    const before = text.slice(0, stripStart).trimEnd();
    const after = text.slice(end + endTag.length).trimStart();
    if (!before) return after;
    if (!after) return before;
    return `${before}\n\n${after}`;
}

export function unwrapLegacyThinkingWrapper(text: string): string {
    const match = text.match(/^\*Thinking\.\.\.\*\n\n\*([\s\S]*)\*$/);
    return match ? match[1] : text;
}

function isVoiceAgentTurn(message: Message): boolean {
    if (message.kind !== 'user-text' && message.kind !== 'agent-text') return false;
    return parseHappierMetaEnvelope(message.meta)?.kind === 'voice_agent_turn.v1';
}

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
            : isVoiceAgentTurn(message) && message.displayText === undefined
                ? normalizeVoiceAgentTurnTranscriptText(message.text)
                : message.displayText !== undefined
                    ? message.displayText
                    : input.hasAttachmentBlockToStrip
                        ? stripLegacyAttachmentsBlock(message.text)
                        : message.text;
        if (text == null) return null;
        return normalizeResolvedText({ role: 'user', text });
    }

    if (message.kind === 'agent-text') {
        if (isAgentTextMessageActivelyStreamingForSelection(message)) return null;
        const baseText = input.isStructuredOnly
            ? message.text
            : isVoiceAgentTurn(message)
                ? normalizeVoiceAgentTurnTranscriptText(message.text)
                : message.text;
        if (baseText == null) return null;
        const text = !input.isStructuredOnly && message.isThinking ? unwrapLegacyThinkingWrapper(baseText) : baseText;
        return normalizeResolvedText({ role: 'assistant', text });
    }

    return null;
}
