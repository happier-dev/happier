import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import {
    readUnsupportedContentMeta,
    resolveUnsupportedContentPresentation,
    type UnsupportedContentKind,
    type UnsupportedContentPresentation,
} from '@happier-dev/session-core/messages';
import { parseHappierMetaEnvelope } from './structured/happierMetaEnvelope';
import { AttachmentsMessageMetaV1Schema, type AttachmentsMessageMetaV1 } from '@/sync/domains/attachments/attachmentsMessageMeta';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';

export type TranscriptMessageDisplayOptions = Readonly<{
    debugInformationEnabled?: boolean;
    thinkingDisplayMode?: Settings['sessionThinkingDisplayMode'];
    /** Selection callers already know whether an attachment row replaced the legacy suffix. */
    hasAttachmentBlockToStrip?: boolean;
}>;

export type TranscriptMessageDisplayText = Readonly<{
    text: string | null;
    unsupportedContentText: string | null;
    isVoiceAgentTurn: boolean;
}>;

export function resolveTranscriptMessageDisplayText(
    message: UserTextMessage | AgentTextMessage,
    options: TranscriptMessageDisplayOptions = {},
): TranscriptMessageDisplayText {
    const prepared = prepareTranscriptMessageBody(message, options);
    const { isVoiceAgentTurn } = prepared;
    const unsupportedKind = readUnsupportedContentMeta(message.meta);
    const presentation = unsupportedKind
        ? resolveUnsupportedContentPresentation({ kind: unsupportedKind, debugInformationEnabled: options.debugInformationEnabled ?? false })
        : null;
    const unsupportedContentText = unsupportedKind && presentation
        ? resolveUnsupportedContentText({ kind: unsupportedKind, presentation, rawText: message.text })
        : null;
    if (presentation === 'hidden' || (message.kind === 'agent-text' && message.isThinking && options.thinkingDisplayMode === 'hidden')) {
        return { text: null, unsupportedContentText, isVoiceAgentTurn };
    }
    const text = unsupportedContentText ?? prepared.text;
    return { text, unsupportedContentText, isVoiceAgentTurn };
}

/** Body preprocessing is shared with copy selection, which has its own eligibility contract. */
export function prepareTranscriptMessageBody(
    message: UserTextMessage | AgentTextMessage,
    options: Pick<TranscriptMessageDisplayOptions, 'hasAttachmentBlockToStrip'> = {},
): Pick<TranscriptMessageDisplayText, 'text' | 'isVoiceAgentTurn'> {
    const isVoiceAgentTurn = parseHappierMetaEnvelope(message.meta)?.kind === 'voice_agent_turn.v1';
    let text: string | null;
    if (message.kind === 'user-text' && message.displayText !== undefined) text = message.displayText;
    else if (isVoiceAgentTurn) text = normalizeVoiceAgentTurnTranscriptText(message.text);
    else if (message.kind === 'user-text' && (options.hasAttachmentBlockToStrip ?? readTranscriptAttachmentsMeta(message.meta) !== null)) {
        text = stripLegacyAttachmentsBlock(message.text);
    } else text = message.text;
    if (text !== null && message.kind === 'agent-text' && message.isThinking) text = unwrapLegacyThinkingWrapper(text);
    return { text, isVoiceAgentTurn };
}

export function readTranscriptAttachmentsMeta(meta: unknown): AttachmentsMessageMetaV1 | null {
    const primary = parseHappierMetaEnvelope(meta);
    const envelope = primary?.kind === 'attachments.v1' ? primary : parseHappierMetaEnvelope(meta, 'happierAttachments');
    if (envelope?.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    return parsed.success && parsed.data.attachments.length > 0 ? parsed.data : null;
}

export function resolveUnsupportedContentText(params: Readonly<{
    presentation: UnsupportedContentPresentation;
    kind: UnsupportedContentKind;
    rawText: string | null | undefined;
}>): string {
    if (params.presentation !== 'diagnostic') return resolveUnsupportedContentLabel(params.kind);
    const raw = typeof params.rawText === 'string' ? params.rawText.trim() : '';
    return raw.length > 0 ? raw : resolveUnsupportedContentLabel(params.kind);
}

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
        if (lineStart === intro || text.slice(lineStart, intro).trim() === '') stripStart = lineStart;
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
