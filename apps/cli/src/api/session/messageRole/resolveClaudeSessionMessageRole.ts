import type { RawJSONLines } from '@/backends/claude/types';
import { readClaudePeerMessage, type SessionMessageRole } from '@happier-dev/protocol';

import { asRecord, readNestedProperty, readStringProperty, readType } from './messageRoleClassificationPrimitives';

const CLAUDE_EVENT_TYPES = new Set(['summary', 'system', 'progress']);
const CLAUDE_TOOL_BLOCK_TYPES = new Set(['tool_use', 'tool_result']);

function readClaudeContent(body: unknown): unknown {
    return readNestedProperty(readNestedProperty(body, 'message'), 'content');
}

function contentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : [];
}

function hasToolBlock(content: unknown): boolean {
    return contentBlocks(content).some((block) => {
        const type = readType(block);
        return type !== null && CLAUDE_TOOL_BLOCK_TYPES.has(type);
    });
}

function hasTextBlock(content: unknown): boolean {
    if (typeof content === 'string') return content.trim().length > 0;
    return contentBlocks(content).some((block) => {
        const record = asRecord(block);
        if (!record) return false;
        const type = readType(record);
        const text = record.text;
        return type === 'text' && typeof text === 'string' && text.trim().length > 0;
    });
}

function readSingleTextBlock(content: unknown): string | null {
    if (!Array.isArray(content) || content.length !== 1) return null;
    const record = asRecord(content[0]);
    if (!record || readType(record) !== 'text') return null;
    const text = record.text;
    return typeof text === 'string' ? text : null;
}

function isClaudeSyntheticNoResponseAssistant(body: unknown): boolean {
    const message = readNestedProperty(body, 'message');
    const content = readClaudeContent(body);
    const text = readSingleTextBlock(content);
    return readStringProperty(message, 'model') === '<synthetic>'
        && readStringProperty(message, 'stop_reason') === 'stop_sequence'
        && readStringProperty(message, 'stop_sequence') === ''
        && text?.trim() === 'No response requested.';
}

export function resolveClaudeSessionMessageRole(body: RawJSONLines | unknown): SessionMessageRole {
    const type = readType(body);
    if (type === 'user') {
        // Teammate and subagent deliveries are agent output, not human input.
        if (readClaudePeerMessage(body)) return 'agent';
        const content = readClaudeContent(body);
        if (hasToolBlock(content)) return 'event';
        return hasTextBlock(content) ? 'user' : 'event';
    }
    if (type === 'assistant') {
        if (isClaudeSyntheticNoResponseAssistant(body)) return 'event';
        const content = readClaudeContent(body);
        return hasTextBlock(content) ? 'agent' : 'event';
    }
    if (type && CLAUDE_EVENT_TYPES.has(type)) return 'event';
    return 'unknown';
}
