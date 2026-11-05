import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceAgentTurnTranscriptText } from '@happier-dev/agents';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import {
    readUnsupportedContentMeta,
    resolveUnsupportedContentPresentation,
    type UnsupportedContentKind,
    type UnsupportedContentPresentation,
} from '@happier-dev/session-core/messages';
import { parseHappierMetaEnvelope, readTranscriptAttachmentsMeta } from './structured/happierMetaEnvelope';
export { readTranscriptAttachmentsMeta } from './structured/happierMetaEnvelope';
import { resolveUnsupportedContentLabel } from '@/sync/domains/messages/resolveUnsupportedContentLabel';
import { scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { projectInlineReferenceLabelsV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { resolveInlineMessageReference, resolveMessageStructuredReferences, type MessageStructuredReferences } from './references/messageStructuredReferences';

export type TranscriptMessageDisplayOptions = Readonly<{
    debugInformationEnabled?: boolean;
    thinkingDisplayMode?: Settings['sessionThinkingDisplayMode'];
    /** Selection callers already know whether an attachment row replaced the legacy suffix. */
    hasAttachmentBlockToStrip?: boolean;
    /** Only the Markdown chip renderer consumes the token-bearing source. */
    preserveInlineReferences?: boolean;
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
    options: Pick<TranscriptMessageDisplayOptions, 'hasAttachmentBlockToStrip' | 'preserveInlineReferences'> = {},
): Pick<TranscriptMessageDisplayText, 'text' | 'isVoiceAgentTurn'> {
    const isLegacyVoiceAgentTurn = parseHappierMetaEnvelope(message.meta)?.kind === 'voice_agent_turn.v1';
    const origin = readConversationTurnOriginV1FromMessageMeta(message.meta);
    const isVoiceAgentTurn = isLegacyVoiceAgentTurn
        || origin?.modality === 'voice'
        || (message.kind === 'user-text' && readSessionMessageProvenance(message.meta, 'stored')?.kind === 'voice');
    let text: string | null;
    if (message.kind === 'user-text' && message.displayText !== undefined) text = message.displayText;
    else if (isLegacyVoiceAgentTurn) text = normalizeVoiceAgentTurnTranscriptText(message.text);
    else if (message.kind === 'user-text' && (options.hasAttachmentBlockToStrip ?? readTranscriptAttachmentsMeta(message.meta) !== null)) {
        text = stripLegacyAttachmentsBlock(message.text);
    } else text = message.text;
    if (text !== null && message.kind === 'agent-text' && message.isThinking) text = unwrapLegacyThinkingWrapper(text);
    if (text !== null && !(message.kind === 'user-text' && options.preserveInlineReferences)) {
        text = readableMessageText(text, message.kind === 'user-text' ? message.meta : undefined);
    }
    return { text, isVoiceAgentTurn };
}

/** Human readers never disclose token syntax; only typed message records supply markers. */
export function readableMessageText(text: string, meta?: unknown): string {
    if (meta == null) return projectInlineReferenceLabelsV1(text);
    return readableMessageTextWithReferences(text, resolveMessageStructuredReferences({ text, meta }).inline);
}

/** Resource adapters supply typed bindings, never pretend their files are Session paths. */
export function readableMessageTextWithReferences(text: string, inline: MessageStructuredReferences['inline']): string {
    const tokens = scanInlineReferenceTokensV1(text);
    if (tokens.length === 0) return text;
    const chunks: string[] = [];
    let cursor = 0;
    for (const token of tokens) {
        const reference = resolveInlineMessageReference(inline, token.ref, text.slice(token.start, token.end), token.start);
        chunks.push(text.slice(cursor, token.start), reference?.marker ?? token.label);
        cursor = token.end;
    }
    chunks.push(text.slice(cursor));
    return chunks.join('');
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
