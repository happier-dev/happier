import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';
import { applyExecutionRunControlCapabilities } from '@/sync/domains/session/subagents/executionRuns/applyExecutionRunControlCapabilities';
import { resolveSessionSubagentAutoRecipient } from '@/sync/domains/session/subagents/autoRecipient/resolveSessionSubagentAutoRecipient';
import { deriveSessionSubagentRecipients } from '@/sync/domains/session/subagents/deriveSessionSubagentRecipients';
import { deriveSessionSubagents } from '@/sync/domains/session/subagents/deriveSessionSubagents';
import type { SessionSubagentActiveExecutionRunState } from '@/sync/domains/session/subagents/types';
import { deriveProviderParticipantTargets } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

import type { SessionParticipantTarget } from './participantTargets';

export function deriveSessionParticipantTargets(params: Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
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
            accountScope: params.accountScope,
            session: params.session,
            messages: params.messages,
            currentTargets: targets,
        }),
        ...targets,
    ];
}

export function deriveAutoRecipientFromFocusedToolTranscript(params: Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    focusedMessages?: readonly Message[];
    canControlExecutionRuns?: boolean;
}>): ParticipantRecipientV1 | null {
    return resolveSessionSubagentAutoRecipient({
        accountScope: params.accountScope,
        session: params.session,
        tool: params.tool,
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
        focusedMessages: params.focusedMessages,
        canControlExecutionRuns: params.canControlExecutionRuns,
    });
}
