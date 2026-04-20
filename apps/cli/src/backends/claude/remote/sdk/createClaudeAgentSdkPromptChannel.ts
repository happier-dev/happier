import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import type { SDKUserMessage } from '@/backends/claude/sdk';

export function createClaudeAgentSdkPromptChannel(params: {
    initialMessage: string;
    setUserMessageSender?: ((sender: ((message: SDKUserMessage) => void) | null) => void) | null;
}) {
    const messages = new PushableAsyncIterable<SDKUserMessage>();

    const pushUserTextMessage = (messageText: string) => {
        messages.push({
            type: 'user',
            session_id: '',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [{ type: 'text', text: messageText }],
            },
        });
    };

    params.setUserMessageSender?.((message: SDKUserMessage) => messages.push(message));
    pushUserTextMessage(params.initialMessage);

    return {
        messages,
        pushUserTextMessage,
        end: () => messages.end(),
        dispose: () => params.setUserMessageSender?.(null),
    };
}
