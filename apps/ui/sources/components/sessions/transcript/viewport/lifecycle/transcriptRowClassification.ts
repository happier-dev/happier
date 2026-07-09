import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';
import type { TranscriptNavigationRole } from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import type { TranscriptViewportTelemetryLiveTailAnchorKind } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStreamSegmentMetaV1 } from '@/sync/reducer/helpers/streamSegmentMeta';

export function collectTranscriptNavigationMessageIdsForItem(
    item: TranscriptRowShellItem,
): readonly string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (value: unknown) => {
        if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return;
        seen.add(value);
        ids.push(value);
    };

    if (item.kind === 'message') {
        add(item.messageId);
    } else if (item.kind === 'tool-calls-group') {
        for (const messageId of item.toolMessageIds) add(messageId);
    } else if (item.kind === 'turn') {
        add(item.turn.userMessageId);
        for (const content of item.turn.content) {
            if (content.kind === 'message') {
                add(content.messageId);
            } else {
                for (const messageId of content.toolMessageIds) add(messageId);
            }
        }
    } else if (item.kind === 'tool-group-tool') {
        add(item.toolMessageId);
    } else if (
        item.kind === 'tool-group-header' ||
        item.kind === 'tool-group-expand' ||
        item.kind === 'tool-group-footer'
    ) {
        for (const messageId of item.toolMessageIds) add(messageId);
    }

    return ids;
}

export function transcriptNavigationRoleForMessage(
    message: Message | null | undefined,
): TranscriptNavigationRole {
    if (message?.kind === 'user-text') return 'user';
    if (message?.kind === 'agent-text') return 'assistant';
    if (message?.kind === 'tool-call') return 'tool';
    if (message?.kind === 'agent-event') return 'system';
    return 'unknown';
}

export type TranscriptLiveTailAnchorReason = TranscriptViewportTelemetryLiveTailAnchorKind;
export type TranscriptLiveTailAnchor =
    Readonly<{ messageId: string; reason: TranscriptLiveTailAnchorReason }> | null;

function classifyLiveTailAnchorMessage(
    message: Message | null,
    sessionActive: boolean,
): 'streaming-message' | 'streaming-tool' | null {
    if (!message) return null;
    if (!sessionActive) return null;
    if (message.kind === 'tool-call') {
        return message.tool?.state === 'running' ? 'streaming-tool' : null;
    }
    if (message.kind !== 'agent-text') return null;
    return readStreamSegmentMetaV1(message.meta)?.segmentState === 'streaming' ? 'streaming-message' : null;
}

export function resolveTranscriptLiveTailAnchor(params: Readonly<{
    getMessageById: (messageId: string) => Message | null;
    items: readonly TranscriptRowShellItem[];
    latestCommittedActivityKey: string | null;
    sessionActive: boolean;
    thinkingFallbackMessageId: string | null;
    turnActive: boolean;
}>): TranscriptLiveTailAnchor {
    const sessionActive = params.sessionActive;
    for (const item of params.items) {
        if (item.kind === 'message') {
            const reason = classifyLiveTailAnchorMessage(params.getMessageById(item.messageId), sessionActive);
            if (reason) return { messageId: item.messageId, reason };
            continue;
        }

        if (
            item.kind === 'tool-calls-group' ||
            item.kind === 'tool-group-header' ||
            item.kind === 'tool-group-expand' ||
            item.kind === 'tool-group-tool' ||
            item.kind === 'tool-group-footer'
        ) {
            for (const messageId of item.toolMessageIds) {
                const reason = classifyLiveTailAnchorMessage(params.getMessageById(messageId), sessionActive);
                if (reason) return { messageId, reason };
            }
            continue;
        }

        if (item.kind === 'turn') {
            if (item.turn.userMessageId) {
                const reason = classifyLiveTailAnchorMessage(params.getMessageById(item.turn.userMessageId), sessionActive);
                if (reason) return { messageId: item.turn.userMessageId, reason };
            }
            for (const contentItem of item.turn.content) {
                if (contentItem.kind === 'message') {
                    const reason = classifyLiveTailAnchorMessage(params.getMessageById(contentItem.messageId), sessionActive);
                    if (reason) return { messageId: contentItem.messageId, reason };
                    continue;
                }
                if (contentItem.kind === 'tool_calls') {
                    for (const messageId of contentItem.toolMessageIds) {
                        const reason = classifyLiveTailAnchorMessage(params.getMessageById(messageId), sessionActive);
                        if (reason) return { messageId, reason };
                    }
                }
            }
        }
    }

    if (params.thinkingFallbackMessageId != null) {
        return { messageId: params.thinkingFallbackMessageId, reason: 'thinking' };
    }

    if (sessionActive && params.turnActive && params.latestCommittedActivityKey != null) {
        return { messageId: params.latestCommittedActivityKey, reason: 'turn-floor' };
    }

    return null;
}
