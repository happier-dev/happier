import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

import type { ReducerState } from '../reducer';
import type { ToolCall } from '../../domains/messages/messageTypes';

function readObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readStringField(value: unknown, key: string): string | null {
    const record = readObject(value);
    const field = record?.[key];
    return typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
}

function collectSubagentSidechainIds(params: Readonly<{
    tool: ToolCall;
    messageId?: string | null;
}>): string[] {
    const ids = new Set<string>();
    const add = (value: string | null | undefined) => {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed.length > 0) {
            ids.add(trimmed);
        }
    };

    add(params.tool.id);
    add(params.messageId);
    add(readStringField(params.tool.input, 'sidechainId'));
    add(readStringField(params.tool.input, 'callId'));
    add(readStringField(params.tool.result, 'sidechainId'));
    add(readStringField(params.tool.result, 'callId'));

    return Array.from(ids);
}

/**
 * Latest instant at which a subagent tool-call's linked sidechain produced a message, or `null`
 * when the row is not a subagent tool-call or its sidechain never spoke. A sidechain that has
 * spoken is why the ordinary sweep leaves the row alone: it looked alive.
 */
function readLatestLinkedSubagentSidechainActivityAt(params: Readonly<{
    state: ReducerState;
    messageId: string;
    tool: ToolCall;
}>): number | null {
    if (!isSubAgentTranscriptToolName(params.tool.name)) return null;

    let latest: number | null = null;
    for (const id of collectSubagentSidechainIds(params)) {
        const chain = params.state.sidechains.get(id);
        if (!chain) continue;
        for (const message of chain) {
            const createdAt = message.createdAt;
            if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
            if (latest === null || createdAt > latest) latest = createdAt;
        }
    }

    return latest;
}

export function markRunningToolsUnavailable(params: Readonly<{
    state: ReducerState;
    completedAt: number;
    changed: Set<string>;
    /**
     * Set when the sweep is triggered by the session process that owned these tool calls being
     * gone, rather than by a turn boundary. Subagent sidechains run inside that process, so a
     * sidechain that once looked alive is no longer evidence of life — unless it spoke after the
     * instant we last saw the process, which would mean that instant is stale rather than final.
     */
    ownerProcessEnded?: boolean;
}>): void {
    const completedAt = Math.trunc(params.completedAt);
    if (!Number.isFinite(completedAt)) return;

    for (const [messageId, message] of params.state.messages.entries()) {
        const tool = message.tool;
        if (!tool) continue;
        if (tool.state !== 'running') continue;
        if (tool.startedAt === null) continue;
        if (tool.createdAt > completedAt) continue;

        const sidechainActivityAt = readLatestLinkedSubagentSidechainActivityAt({
            state: params.state,
            messageId,
            tool,
        });
        if (sidechainActivityAt !== null) {
            if (params.ownerProcessEnded !== true) continue;
            if (sidechainActivityAt > completedAt) continue;
        }

        tool.state = 'unavailable';
        tool.completedAt = completedAt;
        params.changed.add(messageId);
    }
}
