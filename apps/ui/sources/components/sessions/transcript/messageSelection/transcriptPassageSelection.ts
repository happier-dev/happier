import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { parseSessionMessageRefV1, type SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { resolveCommittedMessageRef } from '../messageActions/resolveCommittedMessageRef';
import type { AskSelection } from '@/components/ui/code/selection/useAskSelection';
import { normalizeExclusiveRangeEnd } from '@/components/ui/code/selection/domSelectionRange';
import type { MarkdownRenderedSelection } from '@/components/markdown/MarkdownView';

export type TranscriptPassageSourceInput = Readonly<{
    message: UserTextMessage | AgentTextMessage;
    sessionId: string;
    serverId?: string | null;
    canSendMessages: boolean;
    text: string;
    historical?: boolean;
    discarded?: boolean;
    structured?: boolean;
    streaming?: boolean;
}>;

export function resolveTranscriptPassageSource(input: TranscriptPassageSourceInput): SessionMessageRefV1 | null {
    if (!input.canSendMessages || input.historical || input.discarded || input.structured || input.streaming
        || (input.message.kind === 'agent-text' && input.message.isThinking) || !input.text.trim()) return null;
    return resolveCommittedMessageRef(input);
}

export function readNativeTranscriptPassageQuote(selection: MarkdownRenderedSelection | undefined): string | null {
    if (!selection || !selection.text.trim() || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)
        || selection.start < 0 || selection.end <= selection.start) return null;
    // Older native binaries send the exact selected text but no whole rendered block. Offsets are
    // deliberately not persisted; a committed message identity is enough for a transcript annotation.
    if (selection.renderedText !== undefined && selection.renderedText.slice(selection.start, selection.end) !== selection.text) return null;
    return selection.text;
}

type DomNode = Readonly<{ parentElement?: DomElement | null; nodeType?: number }>;
type DomElement = DomNode & Readonly<{ id?: string; dataset?: Readonly<Record<string, string | undefined>> }>;
type Selection = Readonly<{
    isCollapsed: boolean; rangeCount: number; toString(): string;
    getRangeAt(index: number): Range;
}>;

export type TranscriptPassageSelection = AskSelection & Readonly<{ source: SessionMessageRefV1 }>;

export function readTranscriptPassageSelection(selection: Selection | null | undefined, listIdPrefix: string): TranscriptPassageSelection | null {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = normalizeExclusiveRangeEnd(selection.getRangeAt(0));
    const closest = (node: DomNode, match: (element: DomElement) => boolean) => {
        let element: DomElement | null | undefined = node.nodeType === 1 ? node : node.parentElement;
        while (element) {
            if (match(element)) return element;
            element = element.parentElement;
        }
        return null;
    };
    const isPassage = (element: DomElement) => typeof element.dataset?.happierTranscriptPassage === 'string';
    const body = closest(range.startContainer, isPassage);
    if (!body || body !== closest(range.endContainer, isPassage)
        || !closest(body, (element) => element.id?.startsWith(listIdPrefix) === true)) return null;
    let source;
    try { source = parseSessionMessageRefV1(JSON.parse(body.dataset!.happierTranscriptPassage!)); } catch { return null; }
    const text = selection.toString();
    if (!source || !text.trim()) return null;
    const rect = Array.from(range.getClientRects()).find((box) => box.width > 0 && box.height > 0) ?? range.getBoundingClientRect();
    return { source, key: JSON.stringify(source), text, startLine: 1, endLine: text.split('\n').length,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
}
