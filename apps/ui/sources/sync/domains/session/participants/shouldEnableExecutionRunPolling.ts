import type { Message } from '@/sync/domains/messages/messageTypes';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';

export function shouldEnableExecutionRunPolling(params: Readonly<{
    executionRunsFeatureEnabled: boolean;
    messages: readonly Message[];
}>): boolean {
    if (params.executionRunsFeatureEnabled) return true;

    // Even when the feature gate is disabled, certain transcripts may still contain SubAgentRun tool-calls
    // whose run status can change asynchronously (e.g., runs continuing after an interrupted tool call).
    return params.messages.some((message) => {
        if (!message || message.kind !== 'tool-call') return false;
        return isSubAgentTranscriptToolName(message.tool?.name ?? '');
    });
}
