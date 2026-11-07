import { vi } from 'vitest';
import type { DiscussionOpenedSummaryV1, DiscussionOpenedMessageV1, DiscussionListResultV1, DiscussionReadResultV1 } from '@happier-dev/protocol/discussions/actions';
import { DiscussionOpenedMessageV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { DiscussionRepositoryClient } from './discussionRepository';

export const address = { serverId: 'home-a' } as const;
export const scope = { serverId: address.serverId, accountId: 'account-a' } as const;

export function summary(id: string, localId: string | null, messageSeq: number): DiscussionOpenedSummaryV1 {
    return {
        id,
        ownerAccountId: scope.accountId,
        encryptionMode: 'plain',
        anchor: null,
        access: 'owner',
        keyReadiness: true,
        dataEncryptionKey: null,
        creationLocalId: localId,
        title: id,
        latestMessage: { id: `${id}-message`, localId: null, seq: messageSeq, authorAccountId: 'account-a', accountActor: { v: 1, accountId: 'account-a', profile: null }, producerV1: null, createdAt: messageSeq },
        messageSeq,
        lastReadSeq: 0,
        unreadCount: messageSeq,
        unreadMentionCount: 0,
        recentAuthorAccountIds: ['account-a'],
        archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    };
}

export function message(seq: number, localId: string | null = null, discussionId = 'discussion-a',
    options: Readonly<{ messageId?: string; createdAt?: number }> = {}): DiscussionOpenedMessageV1 {
    const row = { id: options.messageId ?? `message-${seq}`, discussionId, localId, seq, authorAccountId: 'account-a', accountActor: { v: 1 as const, accountId: 'account-a', profile: null }, producerV1: null,
        content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: `message ${seq}` }] } }, mentionedAccountIds: [], createdAt: options.createdAt ?? seq };
    return DiscussionOpenedMessageV1Schema.parse({ ...row, content: row.content.v,
        messageRef: createDiscussionMessageRefV1({ ...address, discussionId: row.discussionId }, row) });
}

export function listResult(discussions: readonly DiscussionOpenedSummaryV1[], nextCursor: string | null): DiscussionListResultV1 {
    return { v: 1, serverId: address.serverId, discussions: [...discussions], nextCursor, incomplete: false };
}

export function readResult(messages: readonly DiscussionOpenedMessageV1[], hasMoreOlder: boolean, messageSeq: number, discussionId = 'discussion-a'): DiscussionReadResultV1 {
    return { v: 1, serverId: address.serverId, discussionId, messages: [...messages], hasMoreOlder, messageSeq, incomplete: false };
}

export function client(overrides: Partial<DiscussionRepositoryClient> = {}): DiscussionRepositoryClient {
    return {
        attention: async () => ({ kind: 'succeeded', value: { v: 1, serverId: address.serverId, discussions: [], nextCursor: null, incomplete: false } }),
        list: vi.fn<DiscussionRepositoryClient['list']>().mockResolvedValue({ kind: 'succeeded', value: listResult([], null) }),
        get: vi.fn<DiscussionRepositoryClient['get']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_found' }),
        read: vi.fn<DiscussionRepositoryClient['read']>().mockResolvedValue({ kind: 'succeeded', value: readResult([], false, 0) }),
        create: vi.fn<DiscussionRepositoryClient['create']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        post: vi.fn<DiscussionRepositoryClient['post']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        rename: vi.fn<DiscussionRepositoryClient['rename']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        archive: vi.fn<DiscussionRepositoryClient['archive']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        restore: vi.fn<DiscussionRepositoryClient['restore']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        readState: vi.fn<DiscussionRepositoryClient['readState']>().mockResolvedValue({ kind: 'failed', errorCode: 'not_implemented' }),
        participants: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        getSettings: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        setSettings: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        setParticipantPolicy: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        invite: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        inviteExecutableParticipant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        removeParticipant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        leave: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        transferOwner: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        listGrants: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        setGrant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        removeGrant: async () => ({ kind: 'failed', errorCode: 'not_implemented' }),
        ...overrides,
    };
}

export function attentionClient(attention: DiscussionRepositoryClient['attention']): DiscussionRepositoryClient {
    return client({ attention, get: async id => ({ kind: 'succeeded', value: {
        v: 1, serverId: scope.serverId, discussion: summary(id, null, 1),
    } }) });
}
