import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import { normalizeToolCallForRendering } from '@/components/tools/normalization/core/normalizeToolCallForRendering';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';

export interface FilteredTool {
    tool: ToolCall;
    title: string;
    state: 'running' | 'completed' | 'error';
}

export function collectSubAgentSummaryTools(params: Readonly<{
    tool: ToolCall;
    messages: readonly Message[];
    metadata: Metadata | null;
}>): readonly FilteredTool[] {
    const filtered: FilteredTool[] = [];
    const taskStartedAt = params.tool.startedAt ?? params.tool.createdAt;

    for (const message of params.messages) {
        if (message.kind !== 'tool-call') continue;
        // Heuristic: show tool calls that happened during/after this task started.
        if (
            typeof taskStartedAt === 'number' &&
            typeof message.tool.createdAt === 'number' &&
            message.tool.createdAt < taskStartedAt
        ) {
            continue;
        }
        if (isGenericSubAgentToolName(message.tool.name)) continue;

        const toolForRendering = normalizeToolCallForRendering(message.tool);
        const headerText = resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: params.metadata });

        const state = message.tool.state;
        if (state === 'running' || state === 'completed' || state === 'error') {
            filtered.push({ tool: message.tool, title: headerText.title, state });
        }
    }

    filtered.sort((a, b) => {
        const aCreatedAt = typeof a.tool.createdAt === 'number' ? a.tool.createdAt : Number.POSITIVE_INFINITY;
        const bCreatedAt = typeof b.tool.createdAt === 'number' ? b.tool.createdAt : Number.POSITIVE_INFINITY;
        if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
        // Stable-ish tie-breaker for deterministic ordering
        const aName = typeof a.tool.name === 'string' ? a.tool.name : '';
        const bName = typeof b.tool.name === 'string' ? b.tool.name : '';
        return aName.localeCompare(bName);
    });

    return filtered;
}
