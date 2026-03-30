import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { resolveToolTranscriptSidechainId } from '@/components/tools/shell/views/resolveToolTranscriptSidechainId';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

import type { SessionSubagent } from '../types';
import { resolveSubAgentSidechainProviderLabel } from './resolveSubAgentSidechainProviderLabel';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
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

function deriveSubAgentStatus(toolMessage: ToolCallMessage): SessionSubagent['status'] {
    if (toolMessage.tool.state === 'running') return 'running';
    if (toolMessage.tool.state === 'completed') return 'succeeded';
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
