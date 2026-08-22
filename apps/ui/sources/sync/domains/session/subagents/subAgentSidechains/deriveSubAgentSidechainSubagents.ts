import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

import type { SessionSubagent } from '../types';
import { resolveSubAgentSidechainProviderLabel } from './resolveSubAgentSidechainProviderLabel';
import { isAsyncSubAgentLaunchToolResult, isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
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
 * A failed launch is still a failure: the exception is bounded to a non-error completion.
 */
function deriveSubAgentStatus(toolMessage: ToolCallMessage): SessionSubagent['status'] {
    if (toolMessage.tool.state === 'running') return 'running';
    if (toolMessage.tool.state === 'completed') {
        return isAsyncSubAgentLaunchToolResult(toolMessage.tool.result) ? 'running' : 'succeeded';
    }
    if (toolMessage.tool.state === 'error') return 'failed';
    return 'unknown';
}

export function deriveSubAgentSidechainSubagents(params: Readonly<{
    messages: readonly Message[];
    flavor?: string | null;
    excludedSidechainIds?: ReadonlySet<string>;
}>): readonly SessionSubagent[] {
    const subagents: SessionSubagent[] = [];
    const seenIds = new Set<string>();
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
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const toolId = typeof toolMessage.tool.id === 'string' ? toolMessage.tool.id.trim() : '';
        const defaultToolMessageRouteId = buildToolCallMessageRouteId({
            toolId: toolId || null,
            fallbackMessageId: toolMessage.id,
        });
        const toolMessageRouteId = resolvePendingPermissionRouteForSubAgentTool({
            messages: params.messages,
            toolMessage,
        }) ?? defaultToolMessageRouteId;
        subagents.push({
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
                startedAtMs: typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : undefined,
                updatedAtMs: typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : undefined,
            },
        });
    }

    return subagents;
}
