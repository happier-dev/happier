import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { isToolCallMessageGroupableInTranscript } from '@/components/sessions/transcript/toolCalls/isToolCallMessageGroupableInTranscript';
import { filterVisibleContextCompactionLifecycleMessageIds } from '@/components/sessions/transcript/events/contextCompactionLifecycleProjection';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';
import {
    collectServerOwnedPendingLocalIds,
    shouldShowCommittedTranscriptMessage,
    shouldShowPendingTranscriptMessage,
} from '@/sync/domains/pending/pendingTranscriptProjection';

export type ChatListRowType = string;

export function resolveChatListMessageRowType(message: Message | null): ChatListRowType {
    if (!message) return 'message:unknown';
    if (message.kind === 'tool-call') return 'message:tool';
    if (message.kind === 'agent-text' && (message.isThinking === true)) return 'message:thinking';
    return `message:${message.kind}`;
}

export type ChatListItem =
    | {
        kind: 'message';
        id: string;
        messageId: string;
        /**
         * When rendering a forked transcript, committed messages can originate from ancestor sessions.
         * These rows should be treated as read-only context in the child session.
         */
        originSessionId?: string;
        isReadOnlyContext?: boolean;
        createdAt: number;
        seq: number | null;
    }
    | {
        kind: 'tool-calls-group';
        id: string;
        toolMessageIds: string[];
        originSessionId?: string;
        isReadOnlyContext?: boolean;
        createdAt: number;
    }
    | {
        kind: 'fork-divider';
        id: string;
        parentSessionId: string;
        childSessionId: string;
        parentCutoffSeqInclusive: number;
    }
    | {
        kind: 'action-draft';
        id: string;
        draft: SessionActionDraft;
    }
    | {
        kind: 'pending-queue';
        id: string;
        pendingMessages: PendingMessage[];
        discardedMessages: DiscardedPendingMessage[];
    }
    | {
        kind: 'pending-user-action';
        id: string;
        request: PendingPermissionRequest;
        createdAt: number;
    }
    | {
        kind: 'external-session-operation';
        id: string;
        presentation: ExternalSessionOperationSharedPresentationV1;
        progress: ExternalSessionOperationProgressV1 | null;
        createdAt: number;
    };

type CommittedTranscriptItem = Extract<ChatListItem, { kind: 'message' | 'tool-calls-group' }>;

type ForkMessageMetadata = Readonly<{
    originSessionId: string;
    isReadOnlyContext: boolean;
}>;

export type ChatListItemsBuildCache = Readonly<{
    messageIdsOldestFirst: readonly string[];
    messageStructureKeysOldestFirst: readonly string[];
    visibleMessageIdsOldestFirst: readonly string[];
    groupConsecutiveToolCalls: boolean;
    forkBoundarySignature?: string;
    committedItems: readonly CommittedTranscriptItem[];
    localIdsInTranscript: ReadonlySet<string>;
    pendingMessagesRef: readonly PendingMessage[] | null | undefined;
    discardedMessagesRef: readonly DiscardedPendingMessage[] | null | undefined;
    pendingUserActionRequestsRef: readonly PendingPermissionRequest[] | null | undefined;
    actionDraftsRef: readonly SessionActionDraft[] | null | undefined;
    items: ChatListItem[];
}>;

function normalizeSeq(seq: unknown): number | null {
    return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

function isPrefix(params: Readonly<{ prefix: readonly string[]; full: readonly string[] }>): boolean {
    if (params.prefix.length > params.full.length) return false;
    for (let i = 0; i < params.prefix.length; i += 1) {
        if (params.prefix[i] !== params.full[i]) return false;
    }
    return true;
}

function canGroupToolCallMessage(message: Message): boolean {
    return isToolCallMessageGroupableInTranscript(message);
}

function readForkMetadata(
    metadataByMessageId: Readonly<Record<string, ForkMessageMetadata>> | undefined,
    messageId: string,
): ForkMessageMetadata | null {
    return metadataByMessageId?.[messageId] ?? null;
}

function hasSameForkMetadata(
    item: Extract<ChatListItem, { kind: 'tool-calls-group' }>,
    metadata: ForkMessageMetadata | null,
): boolean {
    return (item.originSessionId ?? undefined) === (metadata?.originSessionId ?? undefined) &&
        (item.isReadOnlyContext ?? undefined) === (metadata?.isReadOnlyContext ?? undefined);
}

function areSameStringList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function areSameSourceList<T>(
    left: readonly T[] | null | undefined,
    right: readonly T[] | null | undefined,
): boolean {
    if (left === right) return true;
    return (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
}

function buildMessageStructureKey(messageId: string, message: Message | undefined, groupConsecutiveToolCalls: boolean): string {
    if (!message) return `${messageId}:missing`;
    const seq = normalizeSeq((message as { seq?: unknown }).seq);
    const localId = 'localId' in message ? (message.localId ?? '') : '';
    const groupKey =
        groupConsecutiveToolCalls && canGroupToolCallMessage(message)
            ? 'groupable'
            : 'standalone';
    return `${message.id}:${message.kind}:${message.createdAt}:${seq ?? ''}:${localId}:${groupKey}`;
}

function buildMessageStructureKeys(
    messageIdsOldestFirst: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
    groupConsecutiveToolCalls: boolean,
): string[] {
    return messageIdsOldestFirst.map((messageId) =>
        buildMessageStructureKey(messageId, messagesById[messageId], groupConsecutiveToolCalls)
    );
}

function filterCommittedItemsForEventLifecycle(
    items: readonly CommittedTranscriptItem[],
    visibleMessageIds: ReadonlySet<string>,
): CommittedTranscriptItem[] {
    return items.filter((item) => {
        if (item.kind === 'message') return visibleMessageIds.has(item.messageId);
        return item.toolMessageIds.some((messageId) => visibleMessageIds.has(messageId));
    });
}

function readToolPermissionRequestId(message: Message): string | null {
    if (message.kind !== 'tool-call') return null;
    const permission = message.tool.permission;
    if (!permission || permission.kind !== 'user_action' || permission.status !== 'pending') return null;
    return typeof permission.id === 'string' && permission.id.length > 0 ? permission.id : null;
}

function collectPendingTranscriptUserActionRequestIds(
    messageIdsOldestFirst: readonly string[],
    messagesById: Readonly<Record<string, Message>>,
): Set<string> {
    const ids = new Set<string>();
    for (const messageId of messageIdsOldestFirst) {
        const message = messagesById[messageId];
        if (!message) continue;
        const requestId = readToolPermissionRequestId(message);
        if (requestId) ids.add(requestId);
    }
    return ids;
}

function buildPendingUserActionItems(
    requests: readonly PendingPermissionRequest[] | null | undefined,
    transcriptRequestIds: ReadonlySet<string>,
): Extract<ChatListItem, { kind: 'pending-user-action' }>[] {
    if (!Array.isArray(requests) || requests.length === 0) return [];
    const items: Extract<ChatListItem, { kind: 'pending-user-action' }>[] = [];
    for (const request of requests) {
        if (request.kind !== 'user_action') continue;
        if (transcriptRequestIds.has(request.id)) continue;
        items.push({
            kind: 'pending-user-action',
            id: `pending-user-action:${request.id}`,
            request,
            createdAt: typeof request.createdAt === 'number' && Number.isFinite(request.createdAt)
                ? request.createdAt
                : 0,
        });
    }
    return items;
}

export function buildChatListItems(opts: {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    pendingMessages: PendingMessage[];
    discardedMessages?: DiscardedPendingMessage[] | null;
    pendingUserActionRequests?: readonly PendingPermissionRequest[] | null;
    actionDrafts?: SessionActionDraft[] | null;
    includeCommittedMessages?: boolean;
    groupConsecutiveToolCalls?: boolean;
}): ChatListItem[] {
    const localIdsInTranscript = new Set<string>();
    for (const messageId of opts.messageIdsOldestFirst) {
        const m = opts.messagesById[messageId];
        if (!m) continue;
        if ('localId' in m && m.localId) {
            localIdsInTranscript.add(m.localId);
        }
    }

    const serverOwnedPendingLocalIds = collectServerOwnedPendingLocalIds(opts.pendingMessages, opts.discardedMessages);
    const pending = opts.pendingMessages.filter((p) => shouldShowPendingTranscriptMessage(p, localIdsInTranscript));
    const discarded = Array.isArray(opts.discardedMessages) ? opts.discardedMessages : [];
    const items: ChatListItem[] = [];
    const visibleMessageIds = new Set(filterVisibleContextCompactionLifecycleMessageIds(opts.messageIdsOldestFirst, opts.messagesById));

    const includeCommittedMessages = opts.includeCommittedMessages !== false;
    if (includeCommittedMessages) {
        const groupConsecutiveToolCalls = opts.groupConsecutiveToolCalls === true;
        const toolCallsGroupIdForFirstToolMessageId = (messageId: string) => `toolCalls:linear:${messageId}`;

        for (const messageId of opts.messageIdsOldestFirst) {
            const m = opts.messagesById[messageId];
            if (!m) continue;
            if (!visibleMessageIds.has(messageId)) continue;
            if (!shouldShowCommittedTranscriptMessage(m, serverOwnedPendingLocalIds)) continue;

            if (groupConsecutiveToolCalls && canGroupToolCallMessage(m)) {
                const prev = items[items.length - 1];
                if (prev?.kind === 'tool-calls-group') {
                    items[items.length - 1] = { ...prev, toolMessageIds: [...prev.toolMessageIds, m.id] };
                    continue;
                }
                items.push({
                    kind: 'tool-calls-group',
                    id: toolCallsGroupIdForFirstToolMessageId(m.id),
                    toolMessageIds: [m.id],
                    createdAt: m.createdAt,
                });
                continue;
            }

            items.push({
                kind: 'message',
                id: `msg:${m.id}`,
                messageId: m.id,
                createdAt: m.createdAt,
                seq: typeof (m as any).seq === 'number' && Number.isFinite((m as any).seq) ? Math.trunc((m as any).seq) : null,
            });
        }
    }

    if (pending.length > 0 || discarded.length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: pending,
            discardedMessages: discarded,
        });
    }

    const transcriptUserActionRequestIds = collectPendingTranscriptUserActionRequestIds(opts.messageIdsOldestFirst, opts.messagesById);
    items.push(...buildPendingUserActionItems(opts.pendingUserActionRequests, transcriptUserActionRequestIds));

    const drafts = Array.isArray(opts.actionDrafts) ? opts.actionDrafts : [];
    for (const d of drafts) {
        items.push({
            kind: 'action-draft',
            id: `draft:${d.id}`,
            draft: d,
        });
    }

    return items;
}

export function buildChatListItemsCached(opts: {
    cache: ChatListItemsBuildCache | null;
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    pendingMessages: PendingMessage[];
    discardedMessages?: DiscardedPendingMessage[] | null;
    pendingUserActionRequests?: readonly PendingPermissionRequest[] | null;
    actionDrafts?: SessionActionDraft[] | null;
    groupConsecutiveToolCalls?: boolean;
    forkBoundaryBeforeMessageIds?: ReadonlySet<string>;
    forkBoundarySignature?: string;
    forkMetadataByMessageId?: Readonly<Record<string, ForkMessageMetadata>>;
}): { cache: ChatListItemsBuildCache; items: ChatListItem[] } {
    const groupConsecutiveToolCalls = opts.groupConsecutiveToolCalls === true;
    const forkBoundarySignature = opts.forkBoundarySignature;
    const forkBoundaryBeforeMessageIds = opts.forkBoundaryBeforeMessageIds;
    const messageStructureKeysOldestFirst = buildMessageStructureKeys(
        opts.messageIdsOldestFirst,
        opts.messagesById,
        groupConsecutiveToolCalls,
    );
    const canReuse =
        opts.cache != null &&
        opts.cache.groupConsecutiveToolCalls === groupConsecutiveToolCalls &&
        opts.cache.forkBoundarySignature === forkBoundarySignature &&
        isPrefix({ prefix: opts.cache.messageIdsOldestFirst, full: opts.messageIdsOldestFirst }) &&
        isPrefix({ prefix: opts.cache.messageStructureKeysOldestFirst, full: messageStructureKeysOldestFirst });

    let committedItems: CommittedTranscriptItem[] = [];
    let localIdsInTranscript: Set<string> = new Set<string>();
    const toolCallsGroupIdForFirstToolMessageId = (messageId: string) => `toolCalls:linear:${messageId}`;

    if (canReuse) {
        committedItems = opts.cache!.committedItems.slice();
        localIdsInTranscript = new Set(opts.cache!.localIdsInTranscript);

        for (let i = opts.cache!.messageIdsOldestFirst.length; i < opts.messageIdsOldestFirst.length; i += 1) {
            const messageId = opts.messageIdsOldestFirst[i]!;
            const m = opts.messagesById[messageId];
            if (!m) continue;
            if ('localId' in m && m.localId) {
                localIdsInTranscript.add(m.localId);
            }

            if (groupConsecutiveToolCalls && canGroupToolCallMessage(m)) {
                const hasBoundaryBeforeMessage = forkBoundaryBeforeMessageIds?.has(messageId) === true;
                const forkMetadata = readForkMetadata(opts.forkMetadataByMessageId, m.id);
                const prev = committedItems[committedItems.length - 1];
                if (!hasBoundaryBeforeMessage && prev?.kind === 'tool-calls-group' && hasSameForkMetadata(prev, forkMetadata)) {
                    committedItems[committedItems.length - 1] = { ...prev, toolMessageIds: [...prev.toolMessageIds, m.id] };
                    continue;
                }
                committedItems.push({
                    kind: 'tool-calls-group',
                    id: toolCallsGroupIdForFirstToolMessageId(m.id),
                    toolMessageIds: [m.id],
                    ...(forkMetadata ? { originSessionId: forkMetadata.originSessionId, isReadOnlyContext: forkMetadata.isReadOnlyContext } : {}),
                    createdAt: m.createdAt,
                });
                continue;
            }

            committedItems.push({
                kind: 'message',
                id: `msg:${m.id}`,
                messageId: m.id,
                ...(readForkMetadata(opts.forkMetadataByMessageId, m.id)
                    ? {
                        originSessionId: readForkMetadata(opts.forkMetadataByMessageId, m.id)!.originSessionId,
                        isReadOnlyContext: readForkMetadata(opts.forkMetadataByMessageId, m.id)!.isReadOnlyContext,
                    }
                    : {}),
                createdAt: m.createdAt,
                seq: normalizeSeq((m as any).seq),
            });
        }
    } else {
        committedItems = [];
        localIdsInTranscript = new Set<string>();
        for (const messageId of opts.messageIdsOldestFirst) {
            const m = opts.messagesById[messageId];
            if (!m) continue;
            if ('localId' in m && m.localId) {
                localIdsInTranscript.add(m.localId);
            }

            if (groupConsecutiveToolCalls && canGroupToolCallMessage(m)) {
                const hasBoundaryBeforeMessage = forkBoundaryBeforeMessageIds?.has(messageId) === true;
                const forkMetadata = readForkMetadata(opts.forkMetadataByMessageId, m.id);
                const prev = committedItems[committedItems.length - 1];
                if (!hasBoundaryBeforeMessage && prev?.kind === 'tool-calls-group' && hasSameForkMetadata(prev, forkMetadata)) {
                    committedItems[committedItems.length - 1] = { ...prev, toolMessageIds: [...prev.toolMessageIds, m.id] };
                    continue;
                }
                committedItems.push({
                    kind: 'tool-calls-group',
                    id: toolCallsGroupIdForFirstToolMessageId(m.id),
                    toolMessageIds: [m.id],
                    ...(forkMetadata ? { originSessionId: forkMetadata.originSessionId, isReadOnlyContext: forkMetadata.isReadOnlyContext } : {}),
                    createdAt: m.createdAt,
                });
                continue;
            }

            committedItems.push({
                kind: 'message',
                id: `msg:${m.id}`,
                messageId: m.id,
                ...(readForkMetadata(opts.forkMetadataByMessageId, m.id)
                    ? {
                        originSessionId: readForkMetadata(opts.forkMetadataByMessageId, m.id)!.originSessionId,
                        isReadOnlyContext: readForkMetadata(opts.forkMetadataByMessageId, m.id)!.isReadOnlyContext,
                    }
                    : {}),
                createdAt: m.createdAt,
                seq: normalizeSeq((m as any).seq),
            });
        }
    }

    const visibleMessageIdsOldestFirst = filterVisibleContextCompactionLifecycleMessageIds(opts.messageIdsOldestFirst, opts.messagesById);
    const visibleMessageIds = new Set(visibleMessageIdsOldestFirst);
    const serverOwnedPendingLocalIds = collectServerOwnedPendingLocalIds(opts.pendingMessages, opts.discardedMessages);
    const pending = opts.pendingMessages.filter((p) => shouldShowPendingTranscriptMessage(p, localIdsInTranscript));
    const discarded = Array.isArray(opts.discardedMessages) ? opts.discardedMessages : [];
    const pendingUserActionItems = buildPendingUserActionItems(
        opts.pendingUserActionRequests,
        collectPendingTranscriptUserActionRequestIds(opts.messageIdsOldestFirst, opts.messagesById),
    );
    const drafts = Array.isArray(opts.actionDrafts) ? opts.actionDrafts : [];
    if (
        canReuse &&
        opts.cache != null &&
        opts.cache.messageIdsOldestFirst.length === opts.messageIdsOldestFirst.length &&
        areSameStringList(opts.cache.visibleMessageIdsOldestFirst, visibleMessageIdsOldestFirst) &&
        areSameSourceList(opts.cache.pendingMessagesRef, opts.pendingMessages) &&
        areSameSourceList(opts.cache.discardedMessagesRef, opts.discardedMessages) &&
        areSameSourceList(opts.cache.pendingUserActionRequestsRef, opts.pendingUserActionRequests) &&
        areSameSourceList(opts.cache.actionDraftsRef, opts.actionDrafts)
    ) {
        return {
            cache: opts.cache,
            items: opts.cache.items,
        };
    }

    const items: ChatListItem[] = [
        ...filterCommittedItemsForEventLifecycle(committedItems, visibleMessageIds).filter((item) => {
            if (item.kind === 'tool-calls-group') return true;
            const message = opts.messagesById[item.messageId];
            return !message || shouldShowCommittedTranscriptMessage(message, serverOwnedPendingLocalIds);
        }),
    ];

    if (pending.length > 0 || discarded.length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: pending,
            discardedMessages: discarded,
        });
    }

    items.push(...pendingUserActionItems);

    for (const d of drafts) {
        items.push({
            kind: 'action-draft',
            id: `draft:${d.id}`,
            draft: d,
        });
    }

    return {
        cache: {
            messageIdsOldestFirst: opts.messageIdsOldestFirst,
            messageStructureKeysOldestFirst,
            visibleMessageIdsOldestFirst,
            groupConsecutiveToolCalls,
            forkBoundarySignature,
            committedItems,
            localIdsInTranscript,
            pendingMessagesRef: opts.pendingMessages,
            discardedMessagesRef: opts.discardedMessages,
            pendingUserActionRequestsRef: opts.pendingUserActionRequests,
            actionDraftsRef: opts.actionDrafts,
            items,
        },
        items,
    };
}
