import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, type SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
const { storage } = await import('@/sync/domains/state/storage');
const { resetSessionDraftValueCachesForTests } = await import('@/dev/testkit/sessionDraftRepositoryTestkit');
const { writeExistingSessionDraft, getSessionDraftSnapshot, readSessionDiscussionSelectionSourceFromDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { readSessionAttachmentDrafts, clearSessionAttachmentDrafts, sessionAttachmentDraftKey, resolveSessionAttachmentDraftScope } = await import('../attachments/sessionAttachmentDraftStore');
const { useAttachmentDraftManager } = await import('../attachments/useAttachmentDraftManager');
const { readComposerPresentationSnapshot, registerSessionComposerPresentationTarget } = await import('../presentation/sessionComposerPresentationTargets');
const { createExistingSessionComposerDocumentOwner } = await import('./existingSessionComposerDocumentOwner');
const { projectComposerDocumentSnapshot } = await import('./composerSnapshotProjection');
const { appendToSessionDraft } = await import('./appendToSessionDraft');

let scope: { serverId: string; accountId: string };
let sessionTarget: { serverId: string; accountId: string; sessionId: string };
const ref = { kind: 'session', sessionId: 'capture-session' } as const;
let attachmentScope: ReturnType<typeof resolveSessionAttachmentDraftScope>;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let rpcRequests = 0;
const originalState = storage.getState();
const image = (name: string) => ({ kind: 'image' as const,
    source: { kind: 'memory' as const, bytes: new Uint8Array([137, 80, 78, 71]), name,
        mimeType: 'image/png' } });

describe('appendToSessionDraft', () => {
    it('commits a browser PNG with one upload, one picked image and its comment paragraph', async () => {
        const { commitBrowserAnnotation } = await import('../browser/commitBrowserAnnotation');
        const { subscribeAttachmentDraftsForKey } = await import('../attachments/attachmentDraftMemoryStore');
        let publications = 0;
        const stop = subscribeAttachmentDraftsForKey(sessionAttachmentDraftKey(attachmentScope), () => { publications += 1; });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const uploadFile = vi.fn(async () => ({ success: true as const,
            path: '.happier/uploads/messages/annotation/image.png', sha256: 'a'.repeat(64), sizeBytes: 4,
            attachmentHandle: { v: 1 as const, sessionId: sessionTarget.sessionId, id: 'annotation_image_1' },
        }));
        const result = await commitBrowserAnnotation({ sessionTarget, config: {
            uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none',
            vcsIgnoreWritesEnabled: false, maxFileBytes: 1024,
        }, uploadFile }, { png: bytes, width: 40, height: 30, annotationId: 'annotation_1',
            original: { uri: 'data:image/png;base64,AQIDBA==', width: 40, height: 30, scale: 1 },
            document: { v: 1, image: { width: 40, height: 30, scale: 1 }, marks: [] }, comment: 'Fix this button' });
        expect(result).toMatchObject({ ok: true, imageNumber: 1, imageRef: { width: 40, height: 30,
            file: { sessionId: sessionTarget.sessionId, sha256: 'a'.repeat(64) } } });
        const drafts = readSessionAttachmentDrafts(attachmentScope);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ status: 'uploaded', source: { kind: 'memory', bytes } });
        expect(readComposerPresentationSnapshot(ref)!.text).toMatch(/\n\nFix this button$/);
        expect(uploadFile).toHaveBeenCalledTimes(1);
        expect(publications).toBe(1);
        stop();
    });
    it('leaves the composer unchanged when the flattened browser PNG cannot upload', async () => {
        const { commitBrowserAnnotation } = await import('../browser/commitBrowserAnnotation');
        const before = readComposerPresentationSnapshot(ref)!;
        const uploadFile = vi.fn(async () => ({ success: false as const, error: 'offline' }));
        const result = await commitBrowserAnnotation({ sessionTarget, config: {
            uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none',
            vcsIgnoreWritesEnabled: false, maxFileBytes: 1024,
        }, uploadFile }, { png: new Uint8Array([137, 80, 78, 71]), width: 40, height: 30,
            original: { uri: 'data:image/png;base64,AQIDBA==', width: 40, height: 30, scale: 1 },
            annotationId: 'annotation_1', document: { v: 1, image: { width: 40, height: 30, scale: 1 }, marks: [] }, comment: 'Keep my marks' });
        expect(result.ok).toBe(false);
        expect(readSessionAttachmentDrafts(attachmentScope)).toHaveLength(0);
        expect(readComposerPresentationSnapshot(ref)).toEqual(before);
        expect(uploadFile).toHaveBeenCalledTimes(1);
    });
    beforeEach(async () => {
        await homes.reset();
        storage.setState(originalState, true);
        const serverId = await homes.addHome({ name: 'Capture draft', serverUrl: 'https://capture-draft.test', accountId: 'alice' });
        const features = createRootLayoutFeaturesResponse({ features: {
            sessions: { drafts: { enabled: true } },
            encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } },
        } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        // The remote Home is the boundary. Repository batching, epoch selection,
        // Account/session cipher selection and acknowledgement remain real.
        let remoteDraft: SessionDraftRecordV2 | null = null;
        homes.answer(serverId, '/v2/account/session-drafts/read', { select: () => ({
            body: remoteDraft ? { status: 'present', record: remoteDraft } : { status: 'absent' },
        }) });
        homes.answer(serverId, '/v2/account/session-drafts/list', { select: () => ({ body: { items: remoteDraft ? [remoteDraft] : [] } }) });
        for (const epoch of ['v1', 'v2']) homes.answer(serverId, `/${epoch}/account/session-drafts/mutate`, { select: input => {
            const request = SessionDraftMutateRequestV2Schema.parse(input);
            remoteDraft = { address: request.address, content: request.content,
                revision: (remoteDraft?.revision ?? 0) + 1, createdAt: 1, updatedAt: 2 };
            return { body: SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record: remoteDraft }) };
        } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://capture-draft.test', accountId: 'alice',
            request: createSessionReadBatchFetchBoundary(homes.request),
            configureSocket: socket => {
                const send = socket.emitWithAck;
                socket.emitWithAck = async (...emission) => {
                    if (emission[0] === 'rpc-call') rpcRequests += 1;
                    return await send.apply(socket, emission);
                };
            } });
        scope = { serverId, accountId: 'alice' };
        sessionTarget = { ...scope, sessionId: ref.sessionId };
        attachmentScope = resolveSessionAttachmentDraftScope(sessionTarget);
        resetSessionDraftValueCachesForTests();
        storage.getState().activateProfileScope(scope);
        await storage.getState().activateSettingsScope(scope);
        storage.getState().clearSessionLocalStateScope();
        storage.getState().activateSessionLocalStateScope(scope);
        storage.setState(state => ({ ...state, deletedSessionIds: {}, sessions: {
            ...state.sessions, [sessionTarget.sessionId]: createSessionFixture({ id: sessionTarget.sessionId }),
        } }));
        writeExistingSessionDraft({ scope, sessionId: sessionTarget.sessionId, patch: { text: 'Existing words' } });
    });
    afterEach(async () => {
        if (attachmentScope) clearSessionAttachmentDrafts(attachmentScope);
        await connection?.dispose(); connection = undefined;
        await homes.reset();
        resetSessionDraftValueCachesForTests();
        storage.setState(originalState, true);
        vi.unstubAllGlobals();
    });

    it('writes to a Session the chooser lists but nothing has hydrated yet', () => {
        const row = storage.getState().sessions[sessionTarget.sessionId]!;
        storage.setState(state => {
            const { [sessionTarget.sessionId]: _hydrated, ...sessions } = state.sessions;
            return { ...state, sessions, sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [scope.serverId]: { [sessionTarget.sessionId]: row } } };
        });
        expect(appendToSessionDraft({ sessionTarget, items: [image('listed.png')] })).toMatchObject({ status: 'applied', imageNumbers: [1] });
    });

    it('appends offscreen pictures, video, window text and notes in one transaction per Add with continuous image numbers', () => {
        const before = readComposerPresentationSnapshot(ref)!;
        expect(appendToSessionDraft({ sessionTarget, items: [image('one.png')], note: 'First note' }))
            .toMatchObject({ status: 'applied', revision: before.revision + 1, imageNumbers: [1] });
        const first = readComposerPresentationSnapshot(ref)!;
        expect(first.text).toMatch(/^Existing words\n\n\[one.png\].* First note$/);
        const video = { kind: 'video' as const, source: { kind: 'memory' as const,
            name: 'clip.mp4', mimeType: 'video/mp4', bytes: new Uint8Array([1, 2]) } };
        expect(appendToSessionDraft({ sessionTarget, items: [image('two.png'), video], note: 'Second note',
            windowText: { name: 'Window text.txt', text: 'Terminal contents' } }))
            .toMatchObject({ status: 'applied', revision: first.revision + 1, imageNumbers: [2] });
        const next = readComposerPresentationSnapshot(ref)!;
        expect(next.text.startsWith(`${first.text}\n\n`)).toBe(true);
        expect(next.references).toHaveLength(3);
        expect(next.text).not.toContain('Terminal contents');
        const drafts = readSessionAttachmentDrafts(attachmentScope);
        expect(drafts.map(draft => draft.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
        expect(drafts.map(draft => draft.source.kind === 'memory' ? draft.source.name : '')).toEqual([
            'one.png', 'two.png', 'clip.mp4', 'Window text.txt',
        ]);
    });

    it('publishes once to the mounted real document and attachment manager without touching another composer', async () => {
        const existing = Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n');
        writeExistingSessionDraft({ scope, sessionId: sessionTarget.sessionId, patch: { text: existing } });
        const owner = createExistingSessionComposerDocumentOwner({ scope, ref });
        const changed = vi.fn();
        const unobserve = owner.observe(changed);
        const snapshot = () => projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: null },
            presentation: { layout: 'wrap', focused: true, editable: true, submittable: true, submitting: false, running: false,
                selection: { start: 0, end: 0 } } });
        const unregister = registerSessionComposerPresentationTarget(sessionTarget, {
            readScope: () => scope, readRevision: () => owner.read().revision, readSnapshot: snapshot,
            replace: () => owner.read().revision,
            commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
            commitDocumentEmitsChange: true,
        });
        const other = { ...attachmentScope, sessionId: 'other' };
        const mountedCounter = createRenderCommitCounter();
        const unrelatedCounter = createRenderCommitCounter();
        const mounted = await renderHook(() => {
            useRenderCommitCounter(mountedCounter);
            return useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024, memoryKey: sessionAttachmentDraftKey(attachmentScope) });
        });
        const unrelated = await renderHook(() => {
            useRenderCommitCounter(unrelatedCounter);
            return useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024, memoryKey: sessionAttachmentDraftKey(other) });
        });
        mountedCounter.reset(); unrelatedCounter.reset();
        const requestsBefore = rpcRequests;
        const discussionSource = { kind: 'discussion' as const, serverId: scope.serverId,
            discussionId: 'discussion', messageIds: ['message'] };
        try {
            await act(async () => {
                expect(appendToSessionDraft({ sessionTarget, items: [image('mounted.png')], note: 'Live note', discussionSource }).status).toBe('applied');
            });
            expect(changed).toHaveBeenCalledOnce();
            expect(readSessionDiscussionSelectionSourceFromDraft(getSessionDraftSnapshot(scope,
                { kind: 'session', sessionId: sessionTarget.sessionId })?.document)).toEqual(discussionSource);
            expect(snapshot().text.startsWith(`${existing}\n\n[mounted.png]`)).toBe(true);
            expect(snapshot().text.endsWith(' Live note')).toBe(true);
            expect(mounted.getCurrent().drafts).toHaveLength(1);
            expect(unrelated.getCurrent().drafts).toHaveLength(0);
            expect(mountedCounter.read()).toEqual({ renders: 1, commits: 1 });
            expect(unrelatedCounter.read()).toEqual({ renders: 0, commits: 0 });
            // Uploads cross the Session RPC boundary. Independent Account bootstrap
            // HTTP reads are outside this operation and may settle during act.
            expect(rpcRequests - requestsBefore).toBe(0);
        } finally { unregister(); unobserve(); await mounted.unmount(); await unrelated.unmount(); }
    });

    it('flushes one append as exactly one acknowledged draft mutation through the real Sync transport', async () => {
        const { sync } = await import('@/sync/sync');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { flushSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        storage.getState().applySessions([createSessionFixture({ id: ref.sessionId, serverId: scope.serverId, encryptionMode: 'plain' })]);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the real restored Account lifetime');
        expect(await sync.prepareSessionDraftSurface(lifetime, [ref])).toBe(true);
        expect(await flushSessionDraft({ scope, address: ref })).toEqual({ status: 'clean' });
        const isMutation = (path: string) => path === '/v1/account/session-drafts/mutate' || path === '/v2/account/session-drafts/mutate';
        const before = homes.requests.filter(request => isMutation(request.path)).length;
        const rpcBefore = rpcRequests;
        const appended = appendToSessionDraft({ sessionTarget, items: [image('synced.png')], note: 'Synced note' });
        expect(appended.status).toBe('applied');
        expect(await flushSessionDraft({ scope, address: ref })).toEqual({ status: 'clean' });
        const writes = homes.requests.filter(request => isMutation(request.path)).slice(before);
        expect(writes).toHaveLength(1);
        const mutation = SessionDraftMutateRequestV2Schema.parse(writes[0]!.input);
        expect(mutation.address).toEqual(ref);
        expect(mutation.content).toMatchObject({ t: 'plain', v: { document: { composer: {
            text: { value: expect.stringContaining('Synced note') },
        } } } });
        expect(getSessionDraftSnapshot(scope, ref)?.status).toBe('clean');
        expect(rpcRequests - rpcBefore).toBe(0);
        // A second settled flush is quiet: no second publication of this append.
        expect(await flushSessionDraft({ scope, address: ref })).toEqual({ status: 'clean' });
        expect(homes.requests.filter(request => isMutation(request.path))).toHaveLength(before + 1);
    });

    it('uses the same owner for text-only append and refuses another Account without admitting bytes', () => {
        expect(appendToSessionDraft({ sessionTarget, items: [{ kind: 'text', text: 'Selected words' }] }).status).toBe('applied');
        expect(readComposerPresentationSnapshot(ref)?.text).toBe('Existing words\n\nSelected words');
        expect(appendToSessionDraft({ sessionTarget: { ...sessionTarget, accountId: 'other' }, items: [image('secret.png')] }).status)
            .toBe('composerUnavailable');
        expect(readSessionAttachmentDrafts(attachmentScope)).toHaveLength(0);
    });

    it('continues image numbering after a picked web picture loses its mounted preview', async () => {
        const picker = await renderHook(() => useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
            memoryKey: sessionAttachmentDraftKey(attachmentScope) }));
        await act(async () => { picker.getCurrent().addWebFiles([
            new File([new Uint8Array([137, 80, 78, 71])], 'picked.png', { type: 'image/png' }),
        ]); });
        await picker.unmount();
        expect(appendToSessionDraft({ sessionTarget, items: [image('capture.png')] }))
            .toMatchObject({ status: 'applied', imageNumbers: [2] });
    });
});
