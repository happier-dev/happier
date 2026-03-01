import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';

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
    };

type CommittedMessageItem = Extract<ChatListItem, { kind: 'message' }>;

export type ChatListItemsBuildCache = Readonly<{
    messageIdsOldestFirst: readonly string[];
    committedItems: readonly CommittedMessageItem[];
    localIdsInTranscript: ReadonlySet<string>;
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

export function buildChatListItems(opts: {
    messageIdsOldestFirst: string[];
    messagesById: Record<string, Message>;
    pendingMessages: PendingMessage[];
    discardedMessages?: DiscardedPendingMessage[] | null;
    actionDrafts?: SessionActionDraft[] | null;
    includeCommittedMessages?: boolean;
}): ChatListItem[] {
    const localIdsInTranscript = new Set<string>();
    for (const messageId of opts.messageIdsOldestFirst) {
        const m = opts.messagesById[messageId];
        if (!m) continue;
        if ('localId' in m && m.localId) {
            localIdsInTranscript.add(m.localId);
        }
    }

    const pending = opts.pendingMessages.filter((p) => !p.localId || !localIdsInTranscript.has(p.localId));
    const discarded = Array.isArray(opts.discardedMessages) ? opts.discardedMessages : [];
    const items: ChatListItem[] = [];

    const includeCommittedMessages = opts.includeCommittedMessages !== false;
    if (includeCommittedMessages) {
        for (const messageId of opts.messageIdsOldestFirst) {
            const m = opts.messagesById[messageId];
            if (!m) continue;
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
    actionDrafts?: SessionActionDraft[] | null;
}): { cache: ChatListItemsBuildCache; items: ChatListItem[] } {
    const canReuse =
        opts.cache != null &&
        isPrefix({ prefix: opts.cache.messageIdsOldestFirst, full: opts.messageIdsOldestFirst });

    let committedItems: CommittedMessageItem[] = [];
    let localIdsInTranscript: Set<string> = new Set<string>();

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
            committedItems.push({
                kind: 'message',
                id: `msg:${m.id}`,
                messageId: m.id,
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
            committedItems.push({
                kind: 'message',
                id: `msg:${m.id}`,
                messageId: m.id,
                createdAt: m.createdAt,
                seq: normalizeSeq((m as any).seq),
            });
        }
    }

    const pending = opts.pendingMessages.filter((p) => !p.localId || !localIdsInTranscript.has(p.localId));
    const discarded = Array.isArray(opts.discardedMessages) ? opts.discardedMessages : [];
    const items: ChatListItem[] = [...committedItems];

    if (pending.length > 0 || discarded.length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: pending,
            discardedMessages: discarded,
        });
    }

    const drafts = Array.isArray(opts.actionDrafts) ? opts.actionDrafts : [];
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
            committedItems,
            localIdsInTranscript,
        },
        items,
    };
}
