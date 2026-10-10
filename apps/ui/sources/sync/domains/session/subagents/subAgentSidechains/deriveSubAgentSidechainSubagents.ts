import { compareTranscriptMessagesOldestFirst } from '@happier-dev/session-core/messages';
import { readToolCallStartedAtMs, readToolCallFinishedAtMs, readToolCallObservedAtMs } from '../toolCallActivityTimestamps';
import type { Message, ToolCallMessage } from "@happier-dev/session-core/messages";
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { buildToolCallMessageRouteId } from "@happier-dev/session-core/messages";

import type { SessionSubagent } from '../types';
import { resolveSubAgentSidechainProviderLabel } from './resolveSubAgentSidechainProviderLabel';
import { isAsyncSubAgentLaunchToolResult, isGenericSubAgentToolName, readSubAgentToolResultStatus } from '@happier-dev/protocol/tools/v2';
import { resolvePendingPermissionRouteForSubAgentTool } from './resolvePendingPermissionRouteForSubAgentTool';

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSubAgentDisplayTitle(toolMessage: ToolCallMessage): string {
    const input = toolMessage.tool.input as Record<string, unknown>;
    return readNonEmptyString(input?.name)
        ?? readNonEmptyString(input?.label)
        ?? readNonEmptyString(input?.prompt)
        ?? toolMessage.tool.name;
}

/**
 * The agent's state, which is not always the launching call's state.
 *
 * The generic sub-agent tool launches ASYNCHRONOUSLY: the call returns within milliseconds carrying
 * only a launch acknowledgement (`status: 'async_launched'`), the agent then runs for as long as
 * its work takes, and its real result supersedes that acknowledgement later. Reading the
 * acknowledgement as the agent's answer drew every live sub-agent as finished seconds after it
 * started. `isAsyncSubAgentLaunchToolResult` is the shared owner of that question, so this row and
 * the agent runtime's activity headline cannot disagree about it.
 *
 * Launch acknowledgements cannot hide a failed call. Explicit interruption is cancellation,
 * including when a transport represents its terminal result as a tool error.
 */
function deriveSubAgentStatus(toolMessage: ToolCallMessage): SessionSubagent['status'] {
    if (toolMessage.tool.state === 'running') return 'running';
    if (toolMessage.tool.state === 'completed' || toolMessage.tool.state === 'error') {
        const result = toolMessage.tool.result;
        const status = readSubAgentToolResultStatus(result);
        if (status === 'stopped' || status === 'interrupted' || status === 'aborted' || status === 'cancelled' || status === 'killed' || status === 'canceled') return 'cancelled';
        if (toolMessage.tool.state === 'completed') {
            if (isAsyncSubAgentLaunchToolResult(result)) return 'running';
            return 'succeeded';
        }
    }
    if (toolMessage.tool.state === 'error') return 'failed';
    return 'unknown';
}

export function deriveSubAgentSidechainSubagents(params: Readonly<{
    messages: readonly Message[];
    flavor?: string | null;
    excludedSidechainIds?: ReadonlySet<string>;
}>): readonly SessionSubagent[] {
    const subagents = new Map<string, { message: ToolCallMessage; subagent: SessionSubagent }>();
    const providerLabel = resolveSubAgentSidechainProviderLabel(params.flavor);

    for (const message of params.messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        if (!isGenericSubAgentToolName(toolMessage.tool?.name ?? '')) continue;

        const sidechainId = resolveToolTranscriptSidechainId({
            tool: toolMessage.tool,
            normalizedToolName: toolMessage.tool.name,
        });
        if (!sidechainId) continue;
        if (params.excludedSidechainIds?.has(sidechainId)) continue;

        const id = `subagent_sidechain:${sidechainId}`;
        const previous = subagents.get(id);
        if (previous && compareTranscriptMessagesOldestFirst(previous.message, toolMessage) >= 0) continue;

        const toolId = typeof toolMessage.tool.id === 'string' ? toolMessage.tool.id.trim() : '';
        const defaultToolMessageRouteId = buildToolCallMessageRouteId({
            toolId: toolId || null,
            fallbackMessageId: toolMessage.id,
        });
        const toolMessageRouteId = resolvePendingPermissionRouteForSubAgentTool({
            messages: params.messages,
            toolMessage,
        }) ?? defaultToolMessageRouteId;
        const startedAtMs = readToolCallStartedAtMs(toolMessage);
        const updatedAtMs = readToolCallObservedAtMs(toolMessage);
        const finishedAtMs = readToolCallFinishedAtMs(toolMessage);
        subagents.set(id, { message: toolMessage, subagent: {
            id,
            kind: 'subagent_sidechain',
            status: deriveSubAgentStatus(toolMessage),
            display: {
                title: readSubAgentDisplayTitle(toolMessage),
                ...(providerLabel ? { providerLabel } : {}),
            },
            transcript: {
                sidechainId,
                toolMessageRouteId: toolMessageRouteId ?? toolMessage.id,
                ...(toolId ? { toolId } : {}),
            },
            recipient: null,
            capabilities: {
                canOpen: true,
                canSend: false,
                canStop: false,
                canLaunchChild: false,
                canDelete: false,
                canOpenAdvancedRun: false,
            },
            timestamps: {
                ...(startedAtMs !== null ? { startedAtMs } : {}),
                ...(updatedAtMs !== null ? { updatedAtMs } : {}),
                ...(finishedAtMs !== null ? { finishedAtMs } : {}),
            },
        } });
    }

    return Array.from(subagents.values(), (entry) => entry.subagent);
}
