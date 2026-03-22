import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from '../types';

export type SessionSubagentVisibleMessagesContext = Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    subagents: readonly SessionSubagent[];
    subagent: SessionSubagent | null;
}>;

export type SessionSubagentVisibleMessagesResolver = (
    context: SessionSubagentVisibleMessagesContext,
) => readonly Message[] | null;
