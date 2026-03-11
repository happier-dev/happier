import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { resolveSessionSubagentAutoRecipient } from '@/sync/domains/session/subagents/autoRecipient/resolveSessionSubagentAutoRecipient';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import type { SessionSubagentActiveExecutionRunState } from '@/sync/domains/session/subagents/types';
import { deriveProviderParticipantTargets } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

import type { SessionParticipantTarget } from './participantTargets';

export function deriveSessionParticipantTargets(params: Readonly<{
    session: Session;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    canControlExecutionRuns?: boolean;
}>): ReadonlyArray<SessionParticipantTarget> {
    const subagents = applyExecutionRunControlCapabilities(deriveSessionSubagents(params), {
        canControlExecutionRuns: params.canControlExecutionRuns !== false,
    });
    const targets = [...deriveSessionSubagentRecipients(subagents)];
    return [
        ...deriveProviderParticipantTargets({
            session: params.session,
            messages: params.messages,
            currentTargets: targets,
        }),
        ...targets,
    ];
}

export function deriveAutoRecipientFromFocusedToolTranscript(params: Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    focusedMessages?: readonly Message[];
    canControlExecutionRuns?: boolean;
}>): ParticipantRecipientV1 | null {
    return resolveSessionSubagentAutoRecipient({
        session: params.session,
        tool: params.tool,
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
        focusedMessages: params.focusedMessages,
        canControlExecutionRuns: params.canControlExecutionRuns,
    });
}
