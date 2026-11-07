import { afterEach, expect, it, vi } from 'vitest';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainArtifactHomeFixture, seedAdmittedArtifactRows } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ApprovalRequestV2Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { INBOX_ARTIFACT_KINDS } from '@/sync/domains/artifacts/inboxArtifacts';

installDisconnectedServerSocketBoundary();
const { createInboxApprovalArtifactFixture } = await import('@/dev/testkit/fixtures/inboxFixtures');
const { areServerProfileIdentifiersEquivalent, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { useDiscussionListRows } = await import('./useDiscussionListRows');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');

afterEach(standardCleanup);

it('re-evaluates captured approval Home identity when a live profile alias is learned', async () => {
    const url = 'https://discussion-approval-live-alias.test';
    const identity = 'srv_discussion_live_alias';
    const home = await createPlainArtifactHomeFixture(url);
    seedAdmittedArtifactRows([], storage);
    const scope = storage.getState().profileScope!;
    const fixture = createInboxApprovalArtifactFixture({ id: 'alias-approval', serverId: scope.serverId, serverIdentityId: identity });
    if (typeof fixture.body !== 'string') throw new Error('Expected the private approval fixture body');
    const original = ApprovalRequestV2Schema.parse(JSON.parse(fixture.body));
    const request = ApprovalRequestV2Schema.parse({ ...original, actionId: 'discussion.reply',
        actionArgs: { discussionId: 'discussion', content: { v: 1, parts: [{ t: 'text', text: 'Answer' }] },
            replyTarget: { kind: 'message', messageId: 'question' } },
        executionOriginV1: { ...original.executionOriginV1, actionId: 'discussion.reply' } });
    storage.getState().applyArtifacts([{ ...fixture, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }]);
    storage.setState({ isDataReady: true, artifactInboxLoaded: true });
    const entries = storage.getState().artifactDiscussionAttentionEntries;
    expect(entries[fixture.id]?.discussionAttention).toMatchObject({ serverId: identity, discussionId: 'discussion' });
    const items: readonly DiscussionOpenedSummaryV1[] = [{ id: 'discussion', ownerAccountId: scope.accountId,
        encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
        creationLocalId: null, title: 'Review', latestMessage: { id: 'question', localId: null, seq: 1,
            authorAccountId: scope.accountId, accountActor: { v: 1, accountId: scope.accountId, profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false } }];
    const hook = await renderHook(() => useDiscussionListRows(scope, items));
    try {
        expect(areServerProfileIdentifiersEquivalent(identity, scope.serverId)).toBe(false);
        expect(hook.getCurrent()[0]?.attentionReason).toBeNull();
        await act(async () => { await setServerProfileIdentityForUrl(url, identity); });
        expect(areServerProfileIdentifiersEquivalent(identity, scope.serverId)).toBe(true);
        expect(storage.getState().profileScope).toBe(scope);
        expect(storage.getState().artifactDiscussionAttentionEntries).toBe(entries);
        expect(hook.getCurrent()[0]?.attentionReason).toBe('approval_pending');
        expect(hook.getCurrent()[0]?.approvalArtifactIds).toEqual([fixture.id]);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('renders no list when an attention Artifact write changes none of its own Discussions\u2019 attention', async () => {
    const home = await createPlainArtifactHomeFixture('https://discussion-approval-quiet.test');
    seedAdmittedArtifactRows([], storage);
    const scope = storage.getState().profileScope!;
    const fixture = createInboxApprovalArtifactFixture({ id: 'quiet-approval', serverId: scope.serverId });
    if (typeof fixture.body !== 'string') throw new Error('Expected the private approval fixture body');
    const original = ApprovalRequestV2Schema.parse(JSON.parse(fixture.body));
    const replyArgs = { discussionId: 'discussion', content: { v: 1, parts: [{ t: 'text', text: 'Answer' }] },
        replyTarget: { kind: 'message', messageId: 'question' } };
    const request = ApprovalRequestV2Schema.parse({ ...original, actionId: 'discussion.reply',
        actionArgs: replyArgs,
        executionOriginV1: { ...original.executionOriginV1, actionId: 'discussion.reply' } });
    const artifact = { ...fixture, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    storage.getState().applyArtifacts([artifact]);
    storage.setState({ isDataReady: true, artifactInboxLoaded: true });
    const items: readonly DiscussionOpenedSummaryV1[] = [{ id: 'discussion', ownerAccountId: scope.accountId,
        encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
        creationLocalId: null, title: 'Review', latestMessage: { id: 'question', localId: null, seq: 1,
            authorAccountId: scope.accountId, accountActor: { v: 1, accountId: scope.accountId, profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false } }];
    let renders = 0;
    const hook = await renderHook(() => { renders += 1; return useDiscussionListRows(scope, items); });
    try {
        expect(hook.getCurrent()[0]?.attentionReason).toBe('approval_pending');
        const entries = storage.getState().artifactDiscussionAttentionEntries;
        renders = 0;
        // The Home republishes the open request with a newer timestamp only.
        await act(async () => { storage.getState().applyArtifacts([{ ...artifact, updatedAt: artifact.updatedAt + 1000 }]); });
        expect(storage.getState().artifactDiscussionAttentionEntries).not.toBe(entries);
        expect(renders).toBe(0);
        // Another Discussion's request arrives: it is not this list's attention.
        const elsewhere = ApprovalRequestV2Schema.parse({ ...request, actionArgs: { ...replyArgs, discussionId: 'elsewhere' } });
        await act(async () => { storage.getState().applyArtifacts([{ ...artifact, id: 'elsewhere-approval',
            header: buildApprovalRequestArtifactHeaderV1(elsewhere), body: JSON.stringify(elsewhere) }]); });
        expect(storage.getState().artifactDiscussionAttentionEntries['elsewhere-approval']?.discussionAttention?.discussionId).toBe('elsewhere');
        expect(renders).toBe(0);
        expect(hook.getCurrent()[0]?.approvalArtifactIds).toEqual([fixture.id]);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('reads only open Inbox membership for an open Discussion list at Account scale', async () => {
    const home = await createPlainArtifactHomeFixture('https://discussion-approval-membership.test', {
        handleRequest: async path => path === '/v2/account/settings' ? Response.json({ content: { t: 'plain', v: {} }, version: 1 })
            : path === '/v2/account/settings/history' ? Response.json({ snapshots: [] }) : null,
    });
    await Promise.all(Array.from({ length: 512 }, (_, index) => home.boundary.handle('/v1/artifacts', {
        method: 'POST', body: JSON.stringify({ id: `unrelated-${index}`,
            header: encodePlainArtifactStoredContent({ kind: 'memory_doc.v1', title: 'Unrelated' }),
            body: encodePlainArtifactStoredContent({ body: 'Not demanded' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }),
    })));
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
    if (!credentials) throw new Error('Expected fixture Account');
    await restoreConnectionToActiveServer(credentials);
    storage.setState({ isDataReady: true });
    const scope = storage.getState().profileScope!;
    const items: readonly DiscussionOpenedSummaryV1[] = [{ id: 'discussion', ownerAccountId: scope.accountId,
        encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
        creationLocalId: null, title: 'Review', latestMessage: { id: 'message', localId: null, seq: 1,
            authorAccountId: scope.accountId, accountActor: { v: 1, accountId: scope.accountId, profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 1, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
            askAgent: true, sendToSession: true, manageAccess: true, leave: false } }];
    const hook = await renderHook(() => useDiscussionListRows(scope, items));
    try {
        await vi.waitFor(() => expect(storage.getState().artifactInboxLoaded).toBe(true));
        await flushHookEffects();
        const reads = home.requests.filter(request => request.path.startsWith('/v1/artifacts'));
        expect(reads).toHaveLength(1);
        expect(reads[0]?.method).toBe('GET');
        const query = new URL(reads[0]!.path, 'https://home.test').searchParams;
        expect(JSON.parse(query.get('kinds')!)).toEqual(INBOX_ARTIFACT_KINDS);
        expect(query.get('approvalStates')).toBe('["open"]');
        expect(storage.getState().artifactsLoaded).toBe(false);
        expect(Object.keys(storage.getState().artifacts)).toHaveLength(0);
        expect(hook.getCurrent()[0]?.approvalAttentionAvailable).toBe(true);
        await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'other-account' } }));
        expect(hook.getCurrent()[0]?.approvalAttentionAvailable).toBe(false);
        expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(1);
    } finally { await hook.unmount(); await disconnectActiveServerConnection(); await home.dispose(); }
});
