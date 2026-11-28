import { parseSessionMediaMessageMeta } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { sortTranscriptMessagesOldestFirst } from '@/sync/domains/messages/transcriptOrdering';

export type TranscriptExportFormat = 'markdown' | 'json';

type TranscriptRecord = Readonly<{
    id: string;
    createdAt: number;
    seq?: number;
    role: 'user' | 'assistant' | 'tool' | 'event';
    text?: string;
    attachments?: readonly Readonly<{ name: string; path: string }>[];
    thinking?: true;
    tool?: Readonly<{ name: string; input: unknown; result?: unknown; state: string }>;
    event?: unknown;
    children?: readonly TranscriptRecord[];
}>;

export type TranscriptExportOptions = Readonly<{
    /** Subagent transcripts nested under the tool call that started them; on unless turned off. */
    includeSubagents?: boolean;
}>;

function transcriptRecord(message: Message, includeSubagents: boolean): TranscriptRecord {
    const { inlineImages } = parseSessionMediaMessageMeta(message.meta);
    const identity = {
        ...(inlineImages.length ? { attachments: inlineImages.map(({ name, path }) => ({ name, path })) } : {}),
        id: message.realID ?? message.id,
        createdAt: message.createdAt,
        ...(message.seq === undefined ? {} : { seq: message.seq }),
    };
    switch (message.kind) {
        case 'user-text':
            return { ...identity, role: 'user', text: message.displayText ?? message.text };
        case 'agent-text':
            return { ...identity, role: 'assistant', text: message.text, ...(message.isThinking ? { thinking: true } : {}) };
        case 'tool-call':
            return {
                ...identity,
                role: 'tool',
                tool: { name: message.tool.name, input: message.tool.input, result: message.tool.result, state: message.tool.state },
                ...(includeSubagents && message.children.length > 0 ? { children: message.children.map((child) => transcriptRecord(child, true)) } : {}),
            };
        case 'agent-event':
            return { ...identity, role: 'event', event: message.event };
    }
}

function markdownBlock(record: TranscriptRecord): string {
    if (record.text !== undefined) {
        const references = record.attachments?.map(({ name, path }) => `- ${JSON.stringify(name)} (${JSON.stringify(path)})`).join('\n');
        return `## ${record.role === 'user' ? 'User' : record.thinking ? 'Assistant (thinking)' : 'Assistant'}\n\n${record.text}${references ? `\n\nAttachments\n${references}` : ''}`;
    }
    const body = JSON.stringify(record, null, 2);
    let longest = 0;
    for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const label = record.tool ? `Tool: ${record.tool.name}` : 'Event';
    return `## ${label}\n\n${fence}json\n${body}\n${fence}`;
}

export function serializeTranscript(
    messages: readonly Message[],
    format: TranscriptExportFormat,
    options: TranscriptExportOptions = {},
): string {
    const includeSubagents = options.includeSubagents !== false;
    const records = sortTranscriptMessagesOldestFirst([...messages]).map((message) => transcriptRecord(message, includeSubagents));
    return format === 'json'
        ? `${JSON.stringify(records, null, 2)}\n`
        : records.map(markdownBlock).join('\n\n') + (records.length ? '\n' : '');
}
