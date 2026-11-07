import { isClaudeSidechainRuntimeEvidence } from '../../../hooks/sidechain.js';
import type { SDKMessage } from '../../../sdk/types.js';
import type { ClaudeProviderEvent } from '../../providerEvents.js';
import { isReplayClaudeAgentSdkMessage } from './providerActivity.js';
import { readClaudeAgentSdkRuntimeRetry } from './runtimeAuthRetryDecision.js';
import { extractToolResultBlocksFromSdkMessage } from './streamEvents.js';

function isRealProgress(message: SDKMessage): boolean {
    if (message.type === 'stream_event') {
        const event = message.event;
        if (!event || typeof event !== 'object' || !('type' in event)) return false;
        return event.type === 'message_start' || event.type === 'message_delta'
            || event.type === 'content_block_start' || event.type === 'content_block_delta';
    }
    if (message.type === 'assistant') return message.isApiErrorMessage !== true && !message.error;
    return extractToolResultBlocksFromSdkMessage(message).length > 0;
}

/** Native retry advice is presentation evidence; native query and host lifecycle keep authority. */
export function createClaudeAgentSdkRetryProgress() {
    let retryPending = false;
    let retryNotificationCount = 0;
    return (message: SDKMessage, turnId: string | null, sessionId: string): ClaudeProviderEvent | null => {
        if (!turnId || isReplayClaudeAgentSdkMessage(message) || isClaudeSidechainRuntimeEvidence(message)) return null;
        const retry = readClaudeAgentSdkRuntimeRetry(message);
        if (retry) {
            retryPending = true;
            retryNotificationCount += 1;
            return { kind: 'turn-progress', sessionId, turnId, emittedAtMs: Date.now(),
                retry: { ...retry, attempt: retry.attempt ?? retryNotificationCount } };
        }
        if (!retryPending || !isRealProgress(message)) return null;
        retryPending = false;
        return { kind: 'turn-progress', sessionId, turnId, emittedAtMs: Date.now() };
    };
}
