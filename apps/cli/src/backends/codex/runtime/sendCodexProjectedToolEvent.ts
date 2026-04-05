import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';

import type { CodexProjectedRolloutEvent } from '../rollout/projectCodexRolloutActions';

type CodexProjectedToolEvent = Extract<
    CodexProjectedRolloutEvent,
    { type: 'tool-call' } | { type: 'tool-result' }
>;

export async function sendCodexProjectedToolEvent(params: Readonly<{
    session: Pick<ApiSessionClient, 'sendAgentMessage' | 'sendCodexMessage'>;
    event: CodexProjectedToolEvent;
    flushBeforeToolCall?: (() => Promise<void>) | null;
    flushBeforeToolResult?: (() => Promise<void>) | null;
}>): Promise<void> {
    if (params.event.type === 'tool-call') {
        await params.flushBeforeToolCall?.();
        if (params.event.sidechainId) {
            params.session.sendAgentMessage('codex', {
                type: 'tool-call',
                callId: params.event.callId,
                name: params.event.name,
                input: params.event.input,
                id: randomUUID(),
                sidechainId: params.event.sidechainId,
            });
            return;
        }

        params.session.sendCodexMessage({
            type: 'tool-call',
            callId: params.event.callId,
            name: params.event.name,
            input: params.event.input,
            id: randomUUID(),
        });
        return;
    }

    await params.flushBeforeToolResult?.();
    if (params.event.sidechainId) {
        params.session.sendAgentMessage('codex', {
            type: 'tool-result',
            callId: params.event.callId,
            output: params.event.output,
            id: randomUUID(),
            sidechainId: params.event.sidechainId,
            ...(params.event.isError ? { isError: params.event.isError } : {}),
        });
        return;
    }

    params.session.sendCodexMessage({
        type: 'tool-call-result',
        callId: params.event.callId,
        output: params.event.output,
        id: randomUUID(),
        ...(params.event.isError ? { isError: params.event.isError } : {}),
    });
}
