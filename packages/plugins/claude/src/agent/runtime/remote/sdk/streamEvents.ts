import type { SDKMessage } from '../../../sdk/types.js';
import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/plugin-sdk/experimental/diagnostics';
import { createClaudeConnectedServiceRuntimeAuthAdapter } from '../../../auth/services/runtime/index.js';
import { resolveClaudeAgentSdkRuntimeAuthRetryDecision } from './runtimeAuthRetryDecision.js';

function collectAgentSdkResultErrorText(value: unknown, output: string[]): void {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) output.push(trimmed);
        return;
    }
    if (value instanceof Error) {
        collectAgentSdkResultErrorText(value.message, output);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectAgentSdkResultErrorText(item, output);
        return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'details', 'description', 'code', 'type']) {
        collectAgentSdkResultErrorText(record[key], output);
    }
}

export function readClaudeAgentSdkResultText(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const record = message as Record<string, unknown>;
    if (record.type !== 'result') return null;
    return typeof record.result === 'string' && record.result.trim().length > 0 ? record.result.trim() : null;
}

export function readClaudeAgentSdkResultFailure(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const record = message as Record<string, unknown>;
    if (record.type !== 'result') return null;
    const subtype = typeof record.subtype === 'string' ? record.subtype : '';
    if (subtype !== 'error_max_turns' && subtype !== 'error_during_execution') return null;

    const errorParts: string[] = [];
    collectAgentSdkResultErrorText(record.errors, errorParts);
    const resultText = readClaudeAgentSdkResultText(message);
    if (resultText) errorParts.push(resultText);
    const detail = trimBugReportTextToMaxBytes(redactBugReportSensitiveText(errorParts.join('; ')), 1_024).trim();
    return detail ? `${subtype}: ${detail}` : subtype;
}

const claudeRuntimeAuthAdapter = createClaudeConnectedServiceRuntimeAuthAdapter();

function isSubagentScopedClaudeMessage(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const record = message as Record<string, unknown>;
    if (record.isSidechain === true) return true;
    const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
    return typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0;
}

export function hasClaudeAgentSdkRuntimeAuthFailureEvidence(message: unknown): boolean {
    // Sidechain/subagent-scoped failures are never PARENT auth evidence: a transient 401
    // inside a Task-tool subagent must not fail the parent turn nor trigger reactive auth
    // recovery/restart of a healthy parent session (incident 2026-06-12, cmq8y3nlx).
    if (isSubagentScopedClaudeMessage(message)) return false;
    if (resolveClaudeAgentSdkRuntimeAuthRetryDecision(message).action === 'await_provider_retry') return false;
    const classification = claudeRuntimeAuthAdapter.classifyRuntimeAuthFailure({
        target: { agentId: 'claude' },
        selection: { serviceId: 'claude-subscription' },
        error: message,
    });
    return classification?.limitCategory === 'auth_invalid' || classification?.kind === 'auth_expired';
}

export function extractTextDeltaFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_delta') return null;

    const delta = (event as Record<string, unknown>).delta;
    if (!delta || typeof delta !== 'object') return null;
    if ((delta as Record<string, unknown>).type !== 'text_delta') return null;

    const text = (delta as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
}

export function extractTextStartFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_start') return null;

    const block = (event as Record<string, unknown>).content_block;
    if (!block || typeof block !== 'object') return null;
    if ((block as Record<string, unknown>).type !== 'text') return null;

    const text = (block as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
}

export function extractThinkingDeltaFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_delta') return null;

    const delta = (event as Record<string, unknown>).delta;
    if (!delta || typeof delta !== 'object') return null;
    if ((delta as Record<string, unknown>).type !== 'thinking_delta') return null;

    const thinking = (delta as Record<string, unknown>).thinking;
    return typeof thinking === 'string' ? thinking : null;
}

export function extractThinkingStartFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_start') return null;

    const block = (event as Record<string, unknown>).content_block;
    if (!block || typeof block !== 'object') return null;
    if ((block as Record<string, unknown>).type !== 'thinking') return null;

    const thinking = (block as Record<string, unknown>).thinking;
    return typeof thinking === 'string' ? thinking : null;
}

export type StreamEventToolUseStart = { id: string; name: string; input: unknown };

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readSdkMessageContent(message: unknown): unknown[] | null {
    if (!message || typeof message !== 'object') return null;
    const record = message as Record<string, unknown>;
    const messageRecord = record.message;
    if (!messageRecord || typeof messageRecord !== 'object' || Array.isArray(messageRecord)) return null;
    const content = (messageRecord as Record<string, unknown>).content;
    return Array.isArray(content) ? content : null;
}

function readClaudeSdkToolResultOutput(value: unknown): unknown {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return value ?? '';
    const textParts: string[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (record.type !== 'text') continue;
        if (typeof record.text === 'string') textParts.push(record.text);
    }
    return textParts.length > 0 ? textParts.join('') : value;
}

export type ClaudeSdkToolUseBlock = Readonly<{
    id: string;
    name: string;
    input: unknown;
}>;

export function extractToolUseBlocksFromSdkMessage(message: unknown): ClaudeSdkToolUseBlock[] {
    if (!message || typeof message !== 'object') return [];
    const record = message as Record<string, unknown>;
    if (record.type !== 'assistant') return [];
    const content = readSdkMessageContent(message);
    if (!content) return [];
    const blocks: ClaudeSdkToolUseBlock[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const block = item as Record<string, unknown>;
        if (block.type !== 'tool_use') continue;
        const id = readNonEmptyString(block.id);
        const name = readNonEmptyString(block.name);
        if (!id || !name) continue;
        blocks.push({ id, name, input: block.input });
    }
    return blocks;
}

export type ClaudeSdkToolResultBlock = Readonly<{
    toolUseId: string;
    output: unknown;
    isError?: boolean;
}>;

export function extractToolResultBlocksFromSdkMessage(message: unknown): ClaudeSdkToolResultBlock[] {
    if (!message || typeof message !== 'object') return [];
    const record = message as Record<string, unknown>;
    if (record.type !== 'user' && record.type !== 'assistant') return [];
    const content = readSdkMessageContent(message);
    if (!content) return [];
    const blocks: ClaudeSdkToolResultBlock[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const block = item as Record<string, unknown>;
        if (block.type !== 'tool_result') continue;
        const toolUseId = readNonEmptyString(block.tool_use_id);
        if (!toolUseId) continue;
        blocks.push({
            toolUseId,
            output: readClaudeSdkToolResultOutput(block.content),
            ...(typeof block.is_error === 'boolean' ? { isError: block.is_error } : {}),
        });
    }
    return blocks;
}

export function extractToolUseStartFromStreamEvent(message: unknown): StreamEventToolUseStart | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_start') return null;

    const block = (event as Record<string, unknown>).content_block;
    if (!block || typeof block !== 'object') return null;
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type !== 'tool_use') return null;

    const id = typeof blockRecord.id === 'string' ? blockRecord.id : null;
    const name = typeof blockRecord.name === 'string' ? blockRecord.name : null;
    if (!id || !name) return null;

    return { id, name, input: blockRecord.input };
}

export function extractToolUseInputJsonDeltaFromStreamEvent(message: unknown): string | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_delta') return null;

    const delta = (event as Record<string, unknown>).delta;
    if (!delta || typeof delta !== 'object') return null;
    if ((delta as Record<string, unknown>).type !== 'input_json_delta') return null;

    const partialJson = (delta as Record<string, unknown>).partial_json;
    return typeof partialJson === 'string' ? partialJson : null;
}

export type StreamEventToolResultStart = { toolUseId: string; content: string; isError: boolean };

export function extractToolResultStartFromStreamEvent(message: unknown): StreamEventToolResultStart | null {
    if (!message || typeof message !== 'object') return null;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return null;

    const event = m.event;
    if (!event || typeof event !== 'object') return null;
    if ((event as Record<string, unknown>).type !== 'content_block_start') return null;

    const block = (event as Record<string, unknown>).content_block;
    if (!block || typeof block !== 'object') return null;
    const blockRecord = block as Record<string, unknown>;
    if (blockRecord.type !== 'tool_result') return null;

    const toolUseId =
        typeof blockRecord.tool_use_id === 'string'
            ? blockRecord.tool_use_id
            : typeof blockRecord.toolUseId === 'string'
                ? blockRecord.toolUseId
                : null;
    if (!toolUseId) return null;

    const contentRaw = blockRecord.content;
    const content = (() => {
        if (typeof contentRaw === 'string') return contentRaw;
        if (!Array.isArray(contentRaw)) return '';
        const parts: string[] = [];
        for (const item of contentRaw) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const record = item as Record<string, unknown>;
            if (record.type !== 'text') continue;
            const text = record.text;
            if (typeof text === 'string') parts.push(text);
        }
        return parts.join('');
    })();
    const isError = typeof blockRecord.is_error === 'boolean' ? blockRecord.is_error : false;
    return { toolUseId, content, isError };
}

export function isContentBlockStopStreamEvent(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return false;
    const event = m.event;
    if (!event || typeof event !== 'object') return false;
    return (event as Record<string, unknown>).type === 'content_block_stop';
}

export function isMessageStopStreamEvent(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (m.type !== 'stream_event') return false;
    const event = m.event;
    if (!event || typeof event !== 'object') return false;
    return (event as Record<string, unknown>).type === 'message_stop';
}

export function messageContainsToolUseId(message: unknown, toolUseId: string): boolean {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (m.type !== 'assistant') return false;
    const content = (m.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return false;
    return content.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Record<string, unknown>;
        return record.type === 'tool_use' && record.id === toolUseId;
    });
}

export function messageContainsToolResultForToolUseId(message: unknown, toolUseId: string): boolean {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (m.type !== 'user' && m.type !== 'assistant') return false;
    const content = (m.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return false;
    return content.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const record = item as Record<string, unknown>;
        return record.type === 'tool_result' && record.tool_use_id === toolUseId;
    });
}

export function recordSeenToolBlocks(message: SDKMessage, seen: { toolUseIds: Set<string>; toolResultIds: Set<string> }): void {
    const content = ((message as unknown as Record<string, unknown>).message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'tool_use' && typeof record.id === 'string') {
            seen.toolUseIds.add(record.id);
        } else if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') {
            seen.toolResultIds.add(record.tool_use_id);
        }
    }
}

export function stripSeenToolBlocksFromMessage(
    message: SDKMessage,
    seen: { toolUseIds: Set<string>; toolResultIds: Set<string> },
): SDKMessage | null {
    const m = message as unknown as Record<string, unknown>;
    const content = (m.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return message;

    let didChange = false;
    const filtered: unknown[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') {
            filtered.push(block);
            continue;
        }

        const record = block as Record<string, unknown>;
        if (record.type === 'tool_use' && typeof record.id === 'string') {
            if (seen.toolUseIds.has(record.id)) {
                didChange = true;
                continue;
            }
            filtered.push(block);
            continue;
        }

        if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') {
            if (seen.toolResultIds.has(record.tool_use_id)) {
                didChange = true;
                continue;
            }
            filtered.push(block);
            continue;
        }

        filtered.push(block);
    }

    if (!didChange) return message;
    if (filtered.length === 0) return null;
    return {
        ...m,
        message: {
            ...((m.message as Record<string, unknown> | undefined) ?? {}),
            content: filtered,
        },
    } as unknown as SDKMessage;
}
