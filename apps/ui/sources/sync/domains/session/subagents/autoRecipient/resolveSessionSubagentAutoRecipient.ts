import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '../executionRuns/applyExecutionRunControlCapabilities';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { resolveExecutionRunAutoRecipient } from './core/resolveExecutionRunAutoRecipient';
import { resolveProviderSessionSubagentAutoRecipient } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

export function resolveSessionSubagentAutoRecipient(params: Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    canControlExecutionRuns?: boolean;
}>): ParticipantRecipientV1 | null {
    const subagents = applyExecutionRunControlCapabilities(deriveSessionSubagents({
        accountScope: params.accountScope,
        session: params.session,
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    }), {
        canControlExecutionRuns: params.canControlExecutionRuns !== false,
    });

    const context = {
        ...params,
        subagents,
    };

    return resolveExecutionRunAutoRecipient(context)
        ?? resolveProviderSessionSubagentAutoRecipient(context);
}
