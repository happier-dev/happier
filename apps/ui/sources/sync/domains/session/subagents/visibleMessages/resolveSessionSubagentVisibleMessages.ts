import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS,
    BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY,
} from '@/agents/registry/generatedBundledPluginEntries.visibleMessageResolvers';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { findMatchingSessionSubagentForTool } from '../findMatchingSessionSubagentForTool';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { createVisibleMessagesResolverFromDescriptor } from './visibleMessageDescriptors';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createVisibleMessageSessionDescriptor(descriptor: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (descriptor.kind === 'session.visibleMessages.v1') {
        return { visibleMessages: descriptor };
    }
    const descriptorId = typeof descriptor.descriptorId === 'string' && descriptor.descriptorId.trim().length > 0
        ? descriptor.descriptorId
        : null;
    return descriptorId ? { visibleMessageFilterDescriptorId: descriptorId } : {};
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

    const descriptorEntries = BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_DESCRIPTORS.map((entry) => ({
        agentId: entry.agentId,
        resolveVisibleMessages: createVisibleMessagesResolverFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: entry.agentId,
            agentId: entry.agentId,
            version: 1,
            session: isRecord(entry.descriptor) ? createVisibleMessageSessionDescriptor(entry.descriptor) : {},
        }).resolveVisibleMessages,
    }));

    for (const entry of [...descriptorEntries, ...BUNDLED_SESSION_SUBAGENT_VISIBLE_MESSAGE_REGISTRY]) {
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
