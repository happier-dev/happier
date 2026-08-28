import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS,
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY,
} from '@/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers';
import { isBundledAgentId, resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { findMatchingSessionSubagentForTool } from '../findMatchingSessionSubagentForTool';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { createVisibleMessagesResolverFromDescriptor } from './visibleMessageDescriptors';
import { resolveProjectedAgentUiBehaviorEntry } from '@/agents/registry/agentUiBehaviorProjection';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createVisibleMessageSessionDescriptor(descriptor: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (descriptor.kind === 'session.visibleMessages.v1') {
        return { visibleMessages: descriptor };
    }
    return {};
}

function declaresProjectedVisibleMessages(descriptor: Readonly<Record<string, unknown>>): boolean {
    const session = isRecord(descriptor.session) ? descriptor.session : null;
    return session !== null
        && Object.hasOwn(session, 'visibleMessages');
}

export function resolveSessionSubagentVisibleMessages(params: Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
}>): readonly Message[] {
    if (!Array.isArray(params.focusedMessages) || params.focusedMessages.length === 0) return [];

    const subagents = deriveSessionSubagents({
        session: params.session,
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    });
    const subagent = findMatchingSessionSubagentForTool({
        tool: params.tool,
        subagents,
    });

    const ownerMetadata = readSessionOwnerMetadataView(params.session);
    const rawFlavor = ownerMetadata?.flavor;
    const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata)
        ?? resolveAgentIdFromFlavor(typeof rawFlavor === 'string' ? rawFlavor : null);
    if (!agentId) return params.focusedMessages;

    const machineId = typeof ownerMetadata?.machineId === 'string' && ownerMetadata.machineId.trim().length > 0
        ? ownerMetadata.machineId.trim()
        : null;
    const projected = machineId
        ? resolveProjectedAgentUiBehaviorEntry(agentId, machineId)
        : null;
    const projectedDeclaration = projected && declaresProjectedVisibleMessages(projected.descriptor)
        ? [{
            agentId,
            resolveVisibleMessages: createVisibleMessagesResolverFromDescriptor(projected.descriptor).resolveVisibleMessages,
        }]
        : null;
    if (!projectedDeclaration && !isBundledAgentId(agentId)) {
        return params.focusedMessages;
    }

    const descriptorEntries = projectedDeclaration ?? BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS
        .filter((entry) => entry.agentId === agentId)
        .map((entry) => ({
            agentId: entry.agentId,
            resolveVisibleMessages: createVisibleMessagesResolverFromDescriptor({
                kind: 'plugin.ui.v1',
                pluginId: entry.agentId,
                agentId: entry.agentId,
                version: 1,
                session: isRecord(entry.descriptor) ? createVisibleMessageSessionDescriptor(entry.descriptor) : {},
            }).resolveVisibleMessages,
        }));

    const registryEntries = projectedDeclaration
        ? []
        : BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY.filter((entry) => entry.agentId === agentId);
    for (const entry of [...descriptorEntries, ...registryEntries]) {
        let visibleMessages: readonly Message[] | null = null;
        try {
            visibleMessages = entry.resolveVisibleMessages({
                ...params,
                focusedMessages: params.focusedMessages,
                subagents,
                subagent,
            });
        } catch {
            visibleMessages = null;
        }
        if (visibleMessages) return visibleMessages;
    }

    return params.focusedMessages;
}
