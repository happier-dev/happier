import type { Message } from '@/sync/domains/messages/messageTypes';

export function shouldEnableExecutionRunPolling(params: Readonly<{
    executionRunsFeatureEnabled: boolean;
    messages: readonly Message[];
}>): boolean {
    if (params.executionRunsFeatureEnabled) return true;
    return params.messages.some((message) => message?.kind === 'tool-call' && message.tool?.name === 'SubAgentRun');
}
