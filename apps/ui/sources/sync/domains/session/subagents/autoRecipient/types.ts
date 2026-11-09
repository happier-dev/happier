import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from '../types';

export type SessionSubagentAutoRecipientContext = Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
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
