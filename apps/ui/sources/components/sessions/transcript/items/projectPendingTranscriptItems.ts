import type { Message } from '@happier-dev/session-core/messages';
import { isSessionToolAnswerDeliveryMeta } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { WorkflowTranscriptTurnItem } from '@/components/sessions/transcript/turnGrouping/workflowTranscriptTurns';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import {
    collectCommittedTranscriptLocalIds,
    isCommittedTranscriptMessageHiddenByCrossover,
    isPendingTranscriptMessageHiddenByCrossover,
    resolvePendingTranscriptCrossover,
} from '@/sync/domains/pending/pendingTranscriptProjection';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { resolvePendingMessagesPresentationByRecipient } from '@/components/sessions/pending/pendingMessageVisualState';

type PendingQueueItem = Extract<ChatListItem, { kind: 'pending-queue' }>;

function isPendingToolAnswerDelivery(message: PendingMessage): boolean {
    return isSessionToolAnswerDeliveryMeta(message.rawRecord?.meta)
        && message.pendingDeliveryStatus !== 'blocked'
        && message.sendState !== 'failed';
}

function buildPendingUserActionItems(
    requests: readonly PendingPermissionRequest[] | null | undefined,
    messageIds: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): Extract<ChatListItem, { kind: 'pending-user-action' }>[] {
    if (!requests?.length) return [];
    const transcriptRequestIds = new Set<string>();
    for (const messageId of messageIds) {
        const message = messagesById[messageId];
        const permission = message?.kind === 'tool-call' ? message.tool.permission : null;
        if (permission?.kind === 'user_action' && permission.status === 'pending' && permission.id) {
            transcriptRequestIds.add(permission.id);
        }
    }
    return requests.filter((request) => request.kind === 'user_action' && !transcriptRequestIds.has(request.id)).map((request) => ({
        kind: 'pending-user-action',
        id: `pending-user-action:${request.id}`,
        request,
        createdAt: typeof request.createdAt === 'number' && Number.isFinite(request.createdAt) ? request.createdAt : 0,
    }));
}

/**
 * Present the canonical crossover decision as ONE Pending section docked at the tail (owner 11-15).
 * Durable retry custody hides its committed user row; the replies after it (a failure, a partial
 * answer) stay where they landed, and the message itself joins every other pending and discarded
 * message in the single tail section, which reports each one's status and reason.
 */
export function projectPendingTranscriptItems<T extends ChatListItem | WorkflowTranscriptTurnItem>(params: Readonly<{
    items: readonly T[];
    messageIdsOldestFirst: readonly string[];
    messagesById: Readonly<Record<string, Message>>;
    pendingMessages: readonly PendingMessage[];
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    pendingUserActionRequests?: readonly PendingPermissionRequest[] | null;
}>): Array<T | PendingQueueItem | Extract<ChatListItem, { kind: 'pending-user-action' }>> {
    const crossover = resolvePendingTranscriptCrossover({
        committedLocalIds: collectCommittedTranscriptLocalIds(params.messageIdsOldestFirst, params.messagesById),
        pendingMessages: params.pendingMessages,
        discardedMessages: params.discardedMessages,
    });
    const pending = params.pendingMessages.filter((message) => !isPendingToolAnswerDelivery(message)
        && !isPendingTranscriptMessageHiddenByCrossover(message, crossover));
    const discarded = (params.discardedMessages ?? []).filter((message) => !isPendingTranscriptMessageHiddenByCrossover(message, crossover));

    const items: Array<T | PendingQueueItem | Extract<ChatListItem, { kind: 'pending-user-action' }>> = [];
    for (const item of params.items) {
        const messageId = item.kind === 'message' ? item.messageId : item.kind === 'turn' ? item.turn.userMessageId : null;
        const message = messageId ? params.messagesById[messageId] : null;
        if (!message || !isCommittedTranscriptMessageHiddenByCrossover(message, crossover)) {
            items.push(item);
            continue;
        }
        if (item.kind === 'turn' && item.turn.content.length > 0) {
            items.push({ ...item, turn: { ...item.turn, userMessageId: null } });
        }
    }
    if (pending.length > 0 || discarded.length > 0) {
        items.push({ kind: 'pending-queue', id: 'pending-queue', pendingMessages: pending,
            pendingQueueContexts: resolvePendingMessagesPresentationByRecipient(pending), discardedMessages: discarded });
    }
    items.push(...buildPendingUserActionItems(params.pendingUserActionRequests, params.messageIdsOldestFirst, params.messagesById));
    return items;
}
