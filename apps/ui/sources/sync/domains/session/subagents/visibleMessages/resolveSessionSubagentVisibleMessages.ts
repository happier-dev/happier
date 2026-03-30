import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { findMatchingSessionSubagentForTool } from '../findMatchingSessionSubagentForTool';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { filterClaudeSubagentVisibleMessages } from './providers/claude/filterClaudeSubagentVisibleMessages';
import type { SessionSubagentVisibleMessagesResolver } from './types';

const SESSION_SUBAGENT_VISIBLE_MESSAGE_RESOLVERS = [
    filterClaudeSubagentVisibleMessages,
] as const satisfies readonly SessionSubagentVisibleMessagesResolver[];

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

    for (const resolveVisibleMessages of SESSION_SUBAGENT_VISIBLE_MESSAGE_RESOLVERS) {
        const visibleMessages = resolveVisibleMessages({
            ...params,
            focusedMessages: params.focusedMessages,
            subagents,
            subagent,
        });
        if (visibleMessages) return visibleMessages;
    }

    return params.focusedMessages;
}
