import type { AgentMessage } from '@/agent/core/AgentMessage';

import type { MergedAcpToolCall, MergedAcpToolResult } from '../types';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readLegacyAcpToolResultValue(result: MergedAcpToolResult): unknown {
    if (Object.prototype.hasOwnProperty.call(result, 'rawOutput')) return result.rawOutput;
    if (Object.prototype.hasOwnProperty.call(result, 'error')) return { error: result.error };
    return undefined;
}

export function projectLegacyAcpToolCallMessage(call: MergedAcpToolCall): AgentMessage {
    const input = isRecord(call.rawInput) ? call.rawInput : {};
    return {
        type: 'tool-call',
        toolName: call.toolName,
        args: {
            ...input,
            ...(call.locations ? { locations: call.locations } : {}),
            _acp: {
                ...(call.kind ? { kind: call.kind } : {}),
                ...(call.title !== undefined ? { title: call.title } : {}),
                ...(call.content ? { content: call.content } : {}),
            },
        },
        callId: call.toolCallId,
        localId: call.localId,
    };
}

export function projectLegacyAcpToolResultMessage(
    result: MergedAcpToolResult,
    callKind: string | null,
    value: unknown,
): AgentMessage {
    const metadata = { kind: callKind ?? 'unknown' };
    const decorated = isRecord(value)
        ? { ...value, _acp: { ...(isRecord(value._acp) ? value._acp : {}), ...metadata } }
        : { output: value, _acp: metadata };
    return {
        type: 'tool-result',
        toolName: result.toolName,
        result: decorated,
        callId: result.toolCallId,
        localId: result.localId,
        isError: result.isError,
    };
}
