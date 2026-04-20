import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';

import type {
    MessageContent,
    Usage,
} from '../../../types';
import {
    buildCliMessageMeta,
    buildUserTextMessageContent,
    readSidechainId,
} from '../shared';

export function buildClaudeSessionOutboundMessage(params: Readonly<{
    body: RawJSONLines;
    meta?: Record<string, unknown>;
}>): Readonly<{
    content: MessageContent;
    sidechainId: string | null;
    usage?: Readonly<{ usage: Usage; model?: string }>;
    summary?: Readonly<{ text: string; updatedAt: number }>;
}> {
    const sidechainId = readSidechainId((params.body as { sidechainId?: unknown }).sidechainId);

    const content: MessageContent =
        params.body.type === 'user'
        && typeof (params.body as { message?: { content?: unknown } }).message?.content === 'string'
        && (params.body as { isSidechain?: boolean }).isSidechain !== true
        && (params.body as { isMeta?: boolean }).isMeta !== true
            ? buildUserTextMessageContent((params.body as { message: { content: string } }).message.content, params.meta)
            : {
                role: 'agent',
                content: {
                    type: 'output',
                    data: params.body,
                },
                meta: buildCliMessageMeta(params.meta),
            };

    const usage =
        params.body.type === 'assistant'
        && (params.body as { message?: { usage?: Usage; model?: string } }).message?.usage
            ? {
                usage: (params.body as { message: { usage: Usage; model?: string } }).message.usage,
                ...(typeof (params.body as { message?: { model?: string } }).message?.model === 'string'
                    ? { model: (params.body as { message: { model?: string } }).message.model }
                    : {}),
            }
            : undefined;

    const summary =
        params.body.type === 'summary'
        && typeof (params.body as { summary?: unknown }).summary === 'string'
        && typeof (params.body as { leafUuid?: unknown }).leafUuid === 'string'
            ? {
                text: (params.body as { summary: string }).summary,
                updatedAt: Date.now(),
            }
            : undefined;

    return {
        content,
        sidechainId,
        ...(usage ? { usage } : {}),
        ...(summary ? { summary } : {}),
    };
}
