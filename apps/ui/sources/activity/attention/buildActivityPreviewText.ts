import type { Message } from '@/sync/domains/messages/messageTypes';

export function normalizeActivityPreviewText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function buildActivityPreviewText(params: Readonly<{
    messages?: readonly Message[] | null | undefined;
}>): string | null {
    const latestAssistantText = params.messages
        ?.filter((message): message is Extract<Message, { kind: 'agent-text' }> => message.kind === 'agent-text')
        .sort((left, right) => left.createdAt - right.createdAt)
        .at(-1)
        ?.text;

    if (typeof latestAssistantText !== 'string') {
        return null;
    }

    const normalized = normalizeActivityPreviewText(latestAssistantText);
    return normalized.length > 0 ? normalized : null;
}
