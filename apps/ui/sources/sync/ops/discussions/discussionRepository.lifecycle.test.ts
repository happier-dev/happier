import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode, useEffect, useLayoutEffect } from 'react';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@/encryption/base64';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { answerDiscussionThreadForTests, createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Genuine third-party render boundary, as in the shared storage-hook tests;
// this data-owner suite never renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('./discussionRepositoryRegistry');
const { useDiscussionListSearch } = await import('./useDiscussionListSearch');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { useDiscussionRepositorySnapshot } = await import('./useDiscussionRepositorySnapshot');
const { createDiscussionAttachmentPreviewInput } = await import('./discussionAttachmentPreview');

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); clearDiscussionRepositoryRegistryForTests(); await homes.reset(); });

describe('shared Discussion repository Account custody', () => {
    it('shares a cold plugin-only summary read through the default Account repository', async () => {
        const serverId = await homes.addHome({ name: 'Plugin Discussion', serverUrl: 'https://plugin-discussion.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect(await client.create({ creationLocalId: 'plugin-topic', messageLocalId: 'plugin-first', title: 'Private topic',
            content: { v: 1, parts: [{ t: 'text', text: 'Private content' }] } })).toMatchObject({ kind: 'succeeded' });
        const binding = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const lifetime = binding.getCurrent().get(serverId)!;
        const { createPluginDiscussionHostReadStore } = await import('@/components/plugins/surfaces/pluginDiscussionHostRead');
        const stores = Array.from({ length: 3 }, () => createPluginDiscussionHostReadStore({ lifetime }));
        const resource = { hostRead: 'discussion.get', input: { discussionId: 'committed-thread' } } as const;
        homes.requests.length = 0;
        try {
            const snapshots = await Promise.all(stores.map(store => store.getEntry(resource).refresh()));
            for (const snapshot of snapshots) {
                expect(snapshot.error).toBeUndefined();
                expect(JSON.parse(new TextDecoder().decode(snapshot.value?.bytes))).toEqual({ discussionId: 'committed-thread', revision: 0 });
            }
            expect(homes.requestsFor('/v1/discussions/committed-thread')).toHaveLength(1);
            expect(homes.requestsFor('/v1/discussions/committed-thread/messages')).toHaveLength(0);
            expect(readRegisteredDiscussionRepository(scope, scope)?.getSnapshot().threads['committed-thread']?.summary?.title).toBe('Private topic');
        } finally { stores.forEach(store => store.dispose()); await binding.unmount(); }
    });
    it('retires an attachment preview on exact Discussion denial without acquiring bytes', async () => {
        const serverId = await homes.addHome({ name: 'Attachment preview', serverUrl: 'https://attachment-preview.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        await client.create({ creationLocalId: 'preview-topic', messageLocalId: 'preview-first', title: 'Topic', content: { v: 1, parts: [{ t: 'text', text: 'First' }] } });
        const repository = getDiscussionRepository({ scope, address: { serverId }, client });
        await repository.refreshDiscussion('committed-thread');
        const preview = createDiscussionAttachmentPreviewInput({ repository, client, discussionId: 'committed-thread', messageId: 'message',
            reference: { blobId: 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86', mime: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64) }, name: 'image.png', enabled: false });
        if (preview.source.kind !== 'resource') throw new Error('Expected a qualified resource source');
        expect(preview.source.lifetime.isCurrent()).toBe(true);
        let retired = 0;
        const subscription = preview.source.lifetime.onRetire(() => { retired++; });
        // A real Discussion read denial flows through the existing repository's current-grant purge.
        homes.answer(serverId, 'GET /v1/discussions/committed-thread', { status: 403, body: { error: 'discussion_read_denied' } });
        await repository.refreshSummary('committed-thread');
        expect(preview.source.lifetime.isCurrent()).toBe(false);
        expect(retired).toBe(1);
        subscription.dispose();
    });
    it('opens a cold encrypted thread through the detail subscription without a connected socket', async () => {
        const secret = new Uint8Array(32).fill(17);
        const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
        const serverId = await homes.addHome({ name: 'Cold Discussion', serverUrl: 'https://cold-discussion.test',
            accountId: 'alice', currentAccount: true, accountEncryptionMode: 'e2ee', credentials });
        const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: { mode: 'e2ee', version: 1,
            signingKeyFingerprint: 'a'.repeat(64), contentKeyFingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } });
        const scope = { serverId, accountId: 'alice' };
        const fixture = answerDiscussionThreadForTests(homes, serverId, { mode: 'e2ee', loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect(await client.create({ creationLocalId: 'cold-thread', messageLocalId: 'cold-root', title: 'Cold encrypted title',
            content: { v: 1, parts: [{ t: 'text', text: 'First decrypted message' }] } })).toMatchObject({ kind: 'succeeded' });
        const started = performance.now();
        const timings: Record<string, number> = {};
        homes.answer(serverId, 'GET /v1/discussions/committed-thread', { select: () => {
            timings.lastHttpResponse = performance.now() - started;
            timings.firstDetailResponse ??= timings.lastHttpResponse;
            return { body: { discussion: fixture.stored()!.discussion } };
        } });
        homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: () => {
            timings.lastHttpResponse = timings.messagesResponse = performance.now() - started;
            return { body: { messages: fixture.messages, hasMoreOlder: false, messageSeq: fixture.messages.length } };
        } });
        const binding = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime: binding.getCurrent().get(serverId)! });
        let opening: Promise<void> | undefined;
        const hook = await renderHook(() => {
            const snapshot = useDiscussionRepositorySnapshot(repository);
            useEffect(() => {
                const dispose = repository.mount();
                opening = repository.refreshDiscussion('committed-thread');
                return dispose;
            }, []);
            const thread = snapshot.threads['committed-thread'];
            useLayoutEffect(() => {
                if (thread?.status === 'ready' && timings.firstMessageCommit === undefined) {
                    timings.firstMessageCommit = performance.now() - started;
                }
            }, [thread]);
            return thread;
        });
        await act(async () => { await opening; });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', summary: { title: 'Cold encrypted title' },
            messages: [{ content: { parts: [{ t: 'text', text: 'First decrypted message' }] } }] });
        expect(timings.firstMessageCommit).toBeGreaterThanOrEqual(timings.lastHttpResponse!);
        timings.afterLastResponse = timings.firstMessageCommit! - timings.lastHttpResponse!;
        // Intentional timing output for the reported post-HTTP opening stall;
        // this is a cold data-hook measurement, not loaded-browser paint timing.
        console.info('Discussion cold-open timings (ms)', timings);
    });

    it('completes a delayed whole-list search under the canonical StrictMode wrapper and keeps unrelated thread updates local', async () => {
        const serverId = await homes.addHome({ name: 'Search Strict Effects', serverUrl: 'https://search-strict.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect((await client.create({ creationLocalId: 'search-seed', messageLocalId: 'search-root', title: 'First topic',
            content: { v: 1, parts: [{ t: 'text', text: 'Not a search field' }] } })).kind).toBe('succeeded');
        const base = thread.stored()!.discussion;
        const sourceSession = createSessionFixture({ id: 'search-source', serverId, metadata: {
            name: 'Payment source', path: '/project', host: 'review-box',
        } });
        getStorage().getState().applySessions([sourceSession]);
        const firstPageEntered = createDeferred<void>();
        const firstPageReady = createDeferred<void>();
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            const firstPage = url.searchParams.get('state') === 'active' && !url.searchParams.has('cursor');
            if (firstPage) firstPageEntered.resolve();
            return { ...(firstPage ? { respondAfter: firstPageReady.promise } : {}), body: { discussions: url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.has('cursor') ? [{ ...base, id: 'later-match', titleContent: { t: 'plain', v: { v: 1, title: 'Release gates' } },
                    participantAccounts: [SessionMessageAccountActorV1Schema.parse({ v: 1, accountId: 'mei-account', profile: {
                        name: 'Mei Chen', firstName: 'Mei', lastName: 'Chen', username: 'mei', avatarUrl: null,
                    } })] }, { ...base, id: 'source-match', anchor: { kind: 'session', sessionId: sourceSession.id } }] : [base],
                nextCursor: url.searchParams.get('state') === 'archived' || url.searchParams.has('cursor') ? null : 'later-page' } };
        } });
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const accountLifetime = bindingHook.getCurrent().get(serverId)!;
        const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime });
        let renders = 0;
        const search = await renderHook(({ query }: { query: string }) => {
            renders += 1;
            return useDiscussionListSearch({ repository, scope, accountLifetime, query, state: 'active' });
        }, { initialProps: { query: 'release' }, wrapper: ({ children }) => createElement(StrictMode, null, children) });
        await firstPageEntered.promise;
        await act(async () => {
            firstPageReady.resolve();
            await vi.waitFor(() => expect(repository.getSnapshot().lists.active).toMatchObject({ status: 'ready', nextCursor: null }));
        });
        expect(search.getCurrent()).toMatchObject({ status: 'ready', errorCode: null, incomplete: false, items: [{ id: 'later-match' }] });
        await search.rerender({ query: 'Payment source' });
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['source-match']);
        await act(async () => { getStorage().getState().applySessions([{ ...sourceSession, metadata: {
            ...sourceSession.metadata!, name: 'Renamed source',
        } }]); });
        expect(search.getCurrent().items).toEqual([]);
        await search.rerender({ query: 'Mei Chen' });
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['later-match']);
        const reference = search.getCurrent();
        const before = renders;
        await act(async () => { await repository.refreshMessages('committed-thread'); });
        expect(search.getCurrent()).toBe(reference);
        expect(renders).toBe(before);
        await search.rerender({ query: '' });
        expect(search.getCurrent().items).toHaveLength(3);
    });

    it('never searches a foreign Doc through the current Home same-id header', async () => {
        const serverId = await homes.addHome({ name: 'Search Docs', serverUrl: 'https://search-docs.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        await client.create({ creationLocalId: 'doc-search-seed', messageLocalId: 'doc-search-root', title: 'Discussion',
            content: { v: 1, parts: [{ t: 'text', text: 'Not searchable body' }] } });
        const base = thread.stored()!.discussion;
        const anchored = (id: string, home: string) => ({ ...base, id, anchor: { kind: 'doc', doc: {
            ref: { kind: 'doc', artifactId: 'same-doc', serverId: home }, revision: { headerVersion: 1, bodyVersion: 1 },
        } } });
        let taskOnly = false;
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => ({ body: {
            discussions: new URL(request.url).searchParams.get('state') === 'archived' ? []
                : taskOnly ? [{ ...base, id: 'task-source', anchor: { kind: 'task', entry: {
                    source: { pluginId: 'com.example.tasks', localId: 'tasks' }, kindId: 'issue', collisionScope: 'project', entryId: 'opaque-id',
                } } }] : [anchored('local-doc', serverId), anchored('foreign-doc', 'other-home')], nextCursor: null,
        } }) });
        getStorage().setState({ profileScope: scope, artifacts: {
            'same-doc': createUsageNoticeArtifactFixture({ id: 'same-doc', title: 'Home-only planning', header: { kind: 'doc', title: 'Home-only planning' } }),
        } });
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const accountLifetime = bindingHook.getCurrent().get(serverId)!;
        const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime });
        await repository.refreshList('active');
        const search = await renderHook(() => useDiscussionListSearch({ repository, scope, accountLifetime, query: 'Home-only', state: 'active' }));
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['local-doc']);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
        await act(async () => { getStorage().setState({ profileScope: { serverId, accountId: 'other-account' } }); });
        expect(search.getCurrent().items).toEqual([]);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
        taskOnly = true;
        await act(async () => { await repository.refreshList('active'); });
        expect(search.getCurrent().items).toEqual([]);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
    });

    it('finishes opening the selected thread when an earlier surface unmounts during its remount read', async () => {
        const serverId = await homes.addHome({ name: 'Discussion remount', serverUrl: 'https://discussion-remount.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const address = { serverId };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const created = await client.create({ creationLocalId: 'remount-thread', messageLocalId: 'remount-root',
            title: 'Retained discussion', content: { v: 1, parts: [{ t: 'text', text: 'Original message' }] } });
        expect(created.kind).toBe('succeeded');
        const firstSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const firstBinding = firstSurface.getCurrent().get(serverId)!;
        expect(firstBinding?.isCurrent()).toBe(true);
        const first = getDiscussionRepository({ scope, address, client, accountLifetime: firstBinding });
        await first.refreshDiscussion('committed-thread');
        expect(first.getSnapshot().threads['committed-thread']?.status).toBe('ready');

        const remountedSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const remountedBinding = remountedSurface.getCurrent().get(serverId)!;
        const remounted = getDiscussionRepository({ scope, address, client, accountLifetime: remountedBinding });
        expect(remounted).toBe(first);
        const response = createDeferred<void>();
        const entered = createDeferred<void>();
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => {
            entered.resolve();
            return { respondAfter: response.promise, body: { discussion: thread.stored()!.discussion } };
        } });
        const opening = remounted.refreshDiscussion('committed-thread');
        await entered.promise;
        await firstSurface.unmount();
        expect(firstBinding.isCurrent()).toBe(false);
        expect(remountedBinding.isCurrent()).toBe(true);
        await act(async () => { response.resolve(); await opening; });
        expect(remounted.getSnapshot().threads['committed-thread']).toMatchObject({ status: 'ready',
            summary: { id: 'committed-thread', title: 'Retained discussion' }, messages: [{ id: 'committed-root' }] });
        expect(readRegisteredDiscussionRepository(scope, address)).toBe(remounted);

        // Navigation is not Account retirement, even when all detail surfaces
        // close. A fresh mount can keep the same canonical projection and read.
        await remountedSurface.unmount();
        const freshSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const freshBinding = freshSurface.getCurrent().get(serverId)!;
        expect(getDiscussionRepository({ scope, address, client, accountLifetime: freshBinding })).toBe(remounted);
        await remounted.refreshDiscussion('committed-thread');
        expect(remounted.getSnapshot().threads['committed-thread']?.status).toBe('ready');

        // A different Account has neither this cache nor permission to adopt
        // the current credential binding, even without a credential event.
        const otherScope = { serverId, accountId: 'bob' };
        const otherClient = createDiscussionClient({ scope: otherScope, availability: 'available' });
        expect(() => getDiscussionRepository({ scope: otherScope, address, client: otherClient, accountLifetime: freshBinding }))
            .toThrow('Account lifetime must match');
        const other = getDiscussionRepository({ scope: otherScope, address, client: otherClient });
        expect(other).not.toBe(remounted);
        await other.refreshDiscussion('committed-thread');
        expect(other.getSnapshot().threads['committed-thread']?.summary ?? null).toBeNull();

        // Real credential removal must still purge the shared projection and
        // prevent a response already in flight from restoring private rows.
        const staleResponse = createDeferred<void>();
        const staleEntered = createDeferred<void>();
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => {
            staleEntered.resolve();
            return { respondAfter: staleResponse.promise, body: { discussion: thread.stored()!.discussion } };
        } });
        const staleRead = remounted.refreshDiscussion('committed-thread');
        await staleEntered.promise;
        await act(async () => { await TokenStorage.removeCredentialsForServerUrl('https://discussion-remount.test', { serverId }); });
        expect(freshBinding.isCurrent()).toBe(false);
        expect(readRegisteredDiscussionRepository(scope, address)).toBeNull();
        expect(remounted.getSnapshot().threads).toEqual({});
        await act(async () => { staleResponse.resolve(); await staleRead; });
        expect(remounted.getSnapshot().threads).toEqual({});
    });
});
