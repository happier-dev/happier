import type { SDKMessage } from '../sdk/index.js';
import { isRecord } from '@happier-dev/plugin-sdk';
import type { RawJSONLines } from './rawJsonLines.js';
import { CLAUDE_CODE_MODE_TOOL } from '../runtime/codeModeEligibility.js';

/** Preserve provider-supplied parents and infer prefixed inner calls from an open REPL. */
export function correlateClaudeCodeModeTranscriptRow<T>(row: T, activeReplId?: string): {
    row: T;
    activeReplId?: string;
    scriptResultId?: string;
} {
    if (!row || typeof row !== 'object' || !('message' in row)) return { row, activeReplId };
    const message = row.message;
    if (!isRecord(message) || !Array.isArray(message.content)) {
        return { row, activeReplId };
    }
    let content: unknown[] | undefined;
    let scriptResultId: string | undefined;
    const blocks: readonly unknown[] = message.content;
    for (const [index, block] of blocks.entries()) {
        if (!isRecord(block)) continue;
        const id = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : undefined;
        if (typeof id !== 'string') continue;
        if (block.type === 'tool_use' && block.name === CLAUDE_CODE_MODE_TOOL) {
            activeReplId = id;
        } else if (block.type === 'tool_result' && id === activeReplId) {
            scriptResultId = id;
            activeReplId = undefined;
        } else if (activeReplId && /^(?:repl_|toolu_cc_)/.test(id)
            && !block.parent_tool_use_id && !block.parentToolUseId
            && !('parent_tool_use_id' in row && row.parent_tool_use_id)
            && !('parentToolUseId' in row && row.parentToolUseId)) {
            content ??= [...message.content];
            content[index] = { ...block, parent_tool_use_id: activeReplId };
        }
    }
    return { row: content ? { ...row, message: { ...message, content } } : row, activeReplId, scriptResultId };
}

export function normalizeClaudeToolNameToCanonicalToolNameV2(rawName: string): string {
    const name = String(rawName ?? '');
    switch (name) {
        case 'TeamCreate':
            return 'AgentTeamCreate';
        case 'TeamDelete':
            return 'AgentTeamDelete';
        case 'Agent':
            return 'SubAgent';
        case 'SendMessage':
        case 'sendMessage':
            return 'AgentTeamSendMessage';
        default:
            return name;
    }
}

function normalizeToolUseNamesInContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    let didChange = false;
    const next = content.map((block) => {
        if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
        const record = block as Record<string, unknown>;
        if (record.type !== 'tool_use') return block;
        const name = typeof record.name === 'string' ? record.name : null;
        if (!name) return block;
        if (name === CLAUDE_CODE_MODE_TOOL && record.input && typeof record.input === 'object'
            && 'code' in record.input && typeof record.input.code === 'string') {
            didChange = true;
            return { ...record, name: 'Script', input: { code: record.input.code, language: 'javascript', origin: 'native' } };
        }
        const normalized = normalizeClaudeToolNameToCanonicalToolNameV2(name);
        if (normalized === name) return block;
        didChange = true;
        return { ...record, name: normalized };
    });
    return didChange ? next : content;
}

export function normalizeClaudeToolUseNamesInRawJsonLines(message: RawJSONLines): RawJSONLines {
    if (message.type !== 'assistant') return message;
    const msg = message as RawJSONLines & { message?: { content?: unknown } };
    const content = msg.message?.content;
    const normalized = normalizeToolUseNamesInContent(content);
    if (normalized === content) return message;
    return { ...msg, message: { ...msg.message, content: normalized } } as RawJSONLines;
}

export function normalizeClaudeToolUseNamesInSdkMessage(message: SDKMessage): SDKMessage {
    if (!message || typeof message !== 'object') return message;
    const m = message as SDKMessage & { message?: { content?: unknown } };
    if (m.type !== 'assistant' && m.type !== 'user') return message;
    const content = m.message?.content;
    const normalized = normalizeToolUseNamesInContent(content);
    if (normalized === content) return message;
    return { ...m, message: { ...m.message, content: normalized } } as SDKMessage;
}

