import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import type { Message } from "@happier-dev/session-core/messages";
import { isToolCallMessageGroupableInTranscript } from '@/components/sessions/transcript/toolCalls/isToolCallMessageGroupableInTranscript';
import { resolveTranscriptMessageItemId } from '@/components/sessions/transcript/events/contextCompactionLifecycleProjection';
import { filterVisibleTranscriptMessageIds } from '@/components/sessions/transcript/events/runtimeIssueRepeatProjection';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { projectPendingTranscriptItems } from '@/components/sessions/transcript/items/projectPendingTranscriptItems';
import type { PendingMessagesPresentationByRecipient } from '@/components/sessions/pending/pendingMessageVisualState';
import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

export type ChatListRowType = string;

export function resolveChatListMessageRowType(message: Message | null): ChatListRowType {
    if (!message) return 'message:unknown';
    if (message.kind === 'tool-call') return 'message:tool';
    if (message.kind === 'agent-text' && (message.isThinking === true)) return 'message:thinking';
    return `message:${message.kind}`;
}

export type TranscriptMarker =
    | Readonly<{ type: 'new' }>
    | Readonly<{ type: 'turn-end'; outcome: 'worked' | 'stopped'; durationMs: number }>;

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
        /**
         * Quiet transcript furniture between rows, placed by `insertTranscriptMarkers`: the "New" divider at
         * the read cursor captured when the Session was opened, or a settled turn's duration line. It has no
         * seq of its own and is never a navigation or jump target.
         */
        kind: 'transcript-marker';
        id: string;
        marker: TranscriptMarker;
    }
    | {
        kind: 'pending-queue';
        id: string;
        pendingMessages: readonly PendingMessage[];
        /** Record-derived queue context shared by its anchored rows and measurement. */
        pendingQueueContexts?: PendingMessagesPresentationByRecipient;
        discardedMessages: readonly DiscardedPendingMessage[];
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
    }
    | {
        /** Ephemeral Resource projection; intentionally excluded from the transcript seq axis. */
        kind: 'plugin-transcript-activity';
        id: string;
        identityKey: string;
        pluginId: string;
        contributionId: string;
        occurrenceId: string;
        sessionId: string;
        resourceId: string;
        localActivityId: string;
        phase: 'running' | 'succeeded' | 'failed' | 'cancelled';
        title: string;
        status: string | null;
        progress: Readonly<{ completed: number; total: number }> | null;
        checklist: readonly Readonly<{
            id: string;
            label: string;
            state: 'pending' | 'active' | 'complete' | 'failed';
        }>[];
        dismissible: boolean;
        actions: readonly Readonly<{ pluginId: string; localId: string; label: string | null }>[];
        freshness: 'current' | 'stale';
        /** Number of valid Resource rows omitted behind the bounded aggregate tail. */
        aggregateHiddenCount?: number;
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
    pendingMessagesRef: readonly PendingMessage[] | null | undefined;
    discardedMessagesRef: readonly DiscardedPendingMessage[] | null | undefined;
    pendingUserActionRequestsRef: readonly PendingPermissionRequest[] | null | undefined;
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

export function buildChatListItems(opts: {
    messageIdsOldestFirst: readonly string[];
    messagesById: Record<string, Message>;
    pendingMessages: readonly PendingMessage[];
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    pendingUserActionRequests?: readonly PendingPermissionRequest[] | null;
    includeCommittedMessages?: boolean;
    groupConsecutiveToolCalls?: boolean;
}): ChatListItem[] {
    const items: ChatListItem[] = [];
    const visibleMessageIds = new Set(filterVisibleTranscriptMessageIds(opts.messageIdsOldestFirst, opts.messagesById));

    const includeCommittedMessages = opts.includeCommittedMessages !== false;
    if (includeCommittedMessages) {
        const groupConsecutiveToolCalls = opts.groupConsecutiveToolCalls === true;
        const toolCallsGroupIdForFirstToolMessageId = (messageId: string) => `toolCalls:linear:${messageId}`;

        for (const messageId of opts.messageIdsOldestFirst) {
            const m = opts.messagesById[messageId];
            if (!m) continue;
            if (!visibleMessageIds.has(messageId)) continue;

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
                id: resolveTranscriptMessageItemId(m),
                messageId: m.id,
                createdAt: m.createdAt,
                seq: typeof (m as any).seq === 'number' && Number.isFinite((m as any).seq) ? Math.trunc((m as any).seq) : null,
            });
        }
    }

    return projectPendingTranscriptItems({ ...opts, items });
}

export function buildChatListItemsCached(opts: {
    cache: ChatListItemsBuildCache | null;
    messageIdsOldestFirst: readonly string[];
    messagesById: Record<string, Message>;
    pendingMessages: readonly PendingMessage[];
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    pendingUserActionRequests?: readonly PendingPermissionRequest[] | null;
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
    const toolCallsGroupIdForFirstToolMessageId = (messageId: string) => `toolCalls:linear:${messageId}`;

    if (canReuse) {
        committedItems = opts.cache!.committedItems.slice();

        for (let i = opts.cache!.messageIdsOldestFirst.length; i < opts.messageIdsOldestFirst.length; i += 1) {
            const messageId = opts.messageIdsOldestFirst[i]!;
            const m = opts.messagesById[messageId];
            if (!m) continue;

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
                id: resolveTranscriptMessageItemId(m),
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
        for (const messageId of opts.messageIdsOldestFirst) {
            const m = opts.messagesById[messageId];
            if (!m) continue;

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
                id: resolveTranscriptMessageItemId(m),
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

    const visibleMessageIdsOldestFirst = filterVisibleTranscriptMessageIds(opts.messageIdsOldestFirst, opts.messagesById);
    const visibleMessageIds = new Set(visibleMessageIdsOldestFirst);
    if (
        canReuse &&
        opts.cache != null &&
        opts.cache.messageIdsOldestFirst.length === opts.messageIdsOldestFirst.length &&
        areSameStringList(opts.cache.visibleMessageIdsOldestFirst, visibleMessageIdsOldestFirst) &&
        areSameSourceList(opts.cache.pendingMessagesRef, opts.pendingMessages) &&
        areSameSourceList(opts.cache.discardedMessagesRef, opts.discardedMessages) &&
        areSameSourceList(opts.cache.pendingUserActionRequestsRef, opts.pendingUserActionRequests)
    ) {
        return {
            cache: opts.cache,
            items: opts.cache.items,
        };
    }

    const items: ChatListItem[] = projectPendingTranscriptItems({
        ...opts,
        items: filterCommittedItemsForEventLifecycle(committedItems, visibleMessageIds),
    });

    return {
        cache: {
            messageIdsOldestFirst: opts.messageIdsOldestFirst,
            messageStructureKeysOldestFirst,
            visibleMessageIdsOldestFirst,
            groupConsecutiveToolCalls,
            forkBoundarySignature,
            committedItems,
            pendingMessagesRef: opts.pendingMessages,
            discardedMessagesRef: opts.discardedMessages,
            pendingUserActionRequestsRef: opts.pendingUserActionRequests,
            items,
        },
        items,
    };
}
