import type { Message } from '@happier-dev/session-core/messages';
import { projectToolFindText, type ToolFindTextContext } from '@/components/tools/renderers/core/toolDisplayText';
import { resolveTranscriptMessageDisplayText, type TranscriptMessageDisplayOptions } from '../messageDisplayText';
import type { StructuredFindTextBlock, StructuredFindTextContext } from '../structured/structuredFindText';
import { projectStructuredMessageFindText } from '../structured/StructuredMessageBlock';
import { deriveToolMessageDisplay } from '../toolCalls/deriveToolMessageDisplay';
import { presentsAsSessionAskRecord } from '../references/readSessionMessageInvocation';
import { projectReviewToolMessage } from '@/components/sessions/reviews/messages/projectReviewToolMessage';
import {
    projectMarkdownFindText,
    projectPlainFindText,
    type FindDisplayText,
} from '@/components/markdown/rendering/markdownFindProjection';

export { projectMarkdownFindText, projectMarkdownFindSpans } from '@/components/markdown/rendering/markdownFindProjection';
export type { FindDisplayText, TranscriptFindMarkdownSpan } from '@/components/markdown/rendering/markdownFindProjection';

export type TranscriptFindTextBlock = FindDisplayText & Readonly<{
    id: string;
    kind: 'text' | 'markdown' | 'toolTitle' | 'toolBody';
    sourceText: string;
}>;

export type TranscriptFindTextContext = ToolFindTextContext & TranscriptMessageDisplayOptions & StructuredFindTextContext;

function projectStructuredBlocks(blocks: readonly StructuredFindTextBlock[]): TranscriptFindTextBlock[] {
    return blocks.map<TranscriptFindTextBlock>((block) => ({
        id: block.id,
        kind: block.format === 'markdown' ? 'markdown' : 'text',
        sourceText: block.text,
        ...(block.format === 'markdown' ? projectMarkdownFindText(block.text) : projectPlainFindText(block.text)),
    }));
}

/** Message identity and reveal stay with the transcript model; display text stays with render owners. */
export function projectTranscriptFindText(message: Message, context?: TranscriptFindTextContext): readonly TranscriptFindTextBlock[] {
    if (message.kind === 'user-text' || message.kind === 'agent-text') {
        // Find keeps renderer-source offsets; its Markdown projection removes destinations.
        const { text } = resolveTranscriptMessageDisplayText(message, { ...context, preserveInlineReferences: true });
        if (text === null) return [];
        const structured = projectStructuredMessageFindText(message, context);
        if (structured !== null) return projectStructuredBlocks(structured);
        return [{ id: 'text', kind: 'markdown', sourceText: text, ...projectMarkdownFindText(text) }];
    }
    if (message.kind === 'tool-call') {
        message = projectReviewToolMessage(message);
        const structured = projectStructuredMessageFindText(message, context);
        if (context?.serverId && context.sessionId && presentsAsSessionAskRecord(message, { serverId: context.serverId, sessionId: context.sessionId })) return [];
        const display = deriveToolMessageDisplay({
            tool: message.tool,
            meta: message.meta,
        });
        const toolBlocks = display.shouldRenderToolChrome || display.turnChanges
            ? projectToolFindText(message.tool, context) : [];
        return [...projectStructuredBlocks(structured ?? []), ...toolBlocks.map((block) => ({
            id: block.id,
            kind: block.kind,
            sourceText: block.text,
            ...(block.format === 'markdown' ? projectMarkdownFindText(block.text) : projectPlainFindText(block.text)),
        }))];
    }
    return [];
}
