import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from '../types';

export type SessionSubagentAutoRecipientContext = Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    canControlExecutionRuns?: boolean;
    subagents: readonly SessionSubagent[];
}>;

export type SessionSubagentAutoRecipientResolver = (
    context: SessionSubagentAutoRecipientContext,
) => ParticipantRecipientV1 | null;
