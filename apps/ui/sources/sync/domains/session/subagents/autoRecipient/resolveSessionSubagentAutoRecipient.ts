import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';

import { deriveSessionSubagents } from '../deriveSessionSubagents';
import { applyExecutionRunControlCapabilities } from '../executionRuns/applyExecutionRunControlCapabilities';
import type { SessionSubagentActiveExecutionRunState } from '../types';
import { resolveExecutionRunAutoRecipient } from './core/resolveExecutionRunAutoRecipient';
import { resolveProviderSessionSubagentAutoRecipient } from '@/sync/domains/session/providers/sessionProviderBehaviorRegistry';

export function resolveSessionSubagentAutoRecipient(params: Readonly<{
    session: Session;
    tool: ToolCall;
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    canControlExecutionRuns?: boolean;
}>): ParticipantRecipientV1 | null {
    const subagents = applyExecutionRunControlCapabilities(deriveSessionSubagents({
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
