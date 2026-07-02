import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

import type { ToolCall } from '../../domains/messages/messageTypes';
import {
    isRequestInterruptedPlaceholder,
    REQUEST_INTERRUPTED_REASON,
} from '../../domains/session/pending/requestInterruptedPlaceholder';
import type { ReducerState } from '../reducer';

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readStringField(value: unknown, key: string): string | null {
    const record = readRecord(value);
    const field = record?.[key];
    return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
}

function readResultError(result: unknown): string | null {
    return readStringField(result, 'error');
}

function collectSubagentSidechainIds(params: Readonly<{
    tool: ToolCall;
    messageId?: string | null;
    sidechainId?: string | null;
}>): string[] {
    const ids = new Set<string>();
    const add = (value: string | null | undefined) => {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed.length > 0) {
            ids.add(trimmed);
        }
    };

    add(params.sidechainId);
    add(params.tool.id);
    add(params.messageId);
    add(readStringField(params.tool.input, 'sidechainId'));
    add(readStringField(params.tool.input, 'callId'));
    add(readStringField(params.tool.result, 'sidechainId'));
    add(readStringField(params.tool.result, 'callId'));

    return Array.from(ids);
}

function isSyntheticRequestInterruptedTool(tool: ToolCall): boolean {
    if (isRequestInterruptedPlaceholder({
        permission: tool.permission,
        result: readRecord(tool.result),
    })) {
        return true;
    }

    return readResultError(tool.result) === REQUEST_INTERRUPTED_REASON;
}

function hasLinkedSubagentSidechainActivity(params: Readonly<{
    state: ReducerState;
    messageId?: string | null;
    tool: ToolCall;
    sidechainId?: string | null;
}>): boolean {
    if (!isSubAgentTranscriptToolName(params.tool.name)) return false;

    for (const id of collectSubagentSidechainIds(params)) {
        const chain = params.state.sidechains.get(id);
        if (chain && chain.length > 0) {
            return true;
        }
    }

    return false;
}

export function restoreSubagentToolFromSyntheticInterruption(params: Readonly<{
    state: ReducerState;
    messageId: string;
    sidechainId: string;
}>): boolean {
    const message = params.state.messages.get(params.messageId);
    const tool = message?.tool;
    if (!tool) return false;
    if (tool.state !== 'error') return false;
    if (!isSyntheticRequestInterruptedTool(tool)) return false;
    if (!hasLinkedSubagentSidechainActivity({
        state: params.state,
        messageId: params.messageId,
        tool,
        sidechainId: params.sidechainId,
    })) {
        return false;
    }

    tool.state = 'running';
    tool.completedAt = null;
    tool.result = undefined;

    if (tool.permission?.status === 'canceled' && tool.permission.reason === REQUEST_INTERRUPTED_REASON) {
        tool.permission.status = tool.startedAt === null ? 'pending' : 'approved';
        delete tool.permission.reason;
        if (tool.permission.decision === 'abort') {
            delete tool.permission.decision;
        }
    }

    return true;
}
