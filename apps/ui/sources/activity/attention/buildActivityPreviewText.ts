import type { Message } from "@happier-dev/session-core/messages";
import { readableMessageText } from '@/components/sessions/transcript/messageDisplayText';

/** Ambient previews show replies, never the Agent's thinking channel. */
export function isActivityAgentText(message: Message | undefined): message is Extract<Message, { kind: 'agent-text' }> {
    return message?.kind === 'agent-text' && message.isThinking !== true;
}

export function normalizeActivityPreviewText(value: string): string {
    value = readableMessageText(value);
    return value.replace(/\s+/g, ' ').trim();
}

export function buildActivityPreviewText(params: Readonly<{
    messages?: readonly Message[] | null | undefined;
}>): string | null {
    const latestAssistantText = params.messages
        ?.filter(isActivityAgentText)
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1)
        ?.text;

    if (typeof latestAssistantText !== 'string') {
        return null;
    }

    const normalized = normalizeActivityPreviewText(latestAssistantText);
    return normalized.length > 0 ? normalized : null;
}
