import { readClaudePeerMessage } from '@happier-dev/protocol';

import type { RawJSONLines } from '@/backends/claude/types';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

export function isClaudeGeneratedUserMessage(body: unknown): boolean {
    const row = readRecord(body);
    return row?.type === 'user' && (row.isMeta === true || row.isSynthetic === true);
}

/** Native JSONL and SDK streams use different provenance flags for the same injected text. */
export function isClaudeInternalUserTextMessage(body: unknown): boolean {
    return isClaudeGeneratedUserMessage(body)
        && readTextOnlyContent(readRecord(readRecord(body)?.message)?.content) !== null
        && !readClaudePeerMessage(body);
}

function readTextOnlyContent(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || content.length === 0) return null;

    const text: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
        const part = block as Record<string, unknown>;
        if (part.type !== 'text' || typeof part.text !== 'string') return null;
        text.push(part.text);
    }
    return text.join('\n');
}

/** Read human prompts without flattening tool results, media, or peer provenance. */
export function readClaudeUserMessageText(body: RawJSONLines): string | null {
    if (body.type !== 'user' || body.isSidechain === true || isClaudeGeneratedUserMessage(body) || readClaudePeerMessage(body)) {
        return null;
    }
    return readTextOnlyContent(body.message.content);
}
