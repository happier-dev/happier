import { readClaudePeerMessage } from '@happier-dev/protocol';

import type { RawJSONLines } from '@/backends/claude/types';

/** Read human prompts without flattening tool results, media, or peer provenance. */
export function readClaudeUserMessageText(body: RawJSONLines): string | null {
    if (body.type !== 'user' || body.isSidechain === true || body.isMeta === true || readClaudePeerMessage(body)) {
        return null;
    }

    const content: unknown = body.message.content;
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
