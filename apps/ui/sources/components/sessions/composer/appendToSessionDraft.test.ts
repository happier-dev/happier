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
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';

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

// Only this host port is reachable in these executor fixtures; unrelated host adapters remain absent.
const captureExecutor = (screenCaptureAction: NonNullable<ActionExecutorDeps['screenCaptureAction']>) =>
    createActionExecutor({ screenCaptureAction } as ActionExecutorDeps);

describe('appendToSessionDraft', () => {
    it('attaches a frozen browser document through one capture, flatten, upload and composer publication', async () => {
        const admissionOwner = await import('../attachments/attachmentDraftAdmission');
        const configOwner = await import('../attachments/useAttachmentsUploadConfig');
        // Call-through observation: both real owners run; prepared append must not admit bytes again.
        const admissions = vi.spyOn(admissionOwner, 'admitAttachmentDraftSources');
        const configReads = vi.spyOn(configOwner, 'readAttachmentsUploadConfig');
        const { createBrowserContextAnnotationAdapter } = await import('@/sync/domains/browser/context/annotationAdapter');
        const { createBrowserAnnotationCaptureProvider } = await import('@/sync/domains/browser/context/captureProvider');
        const { createBrowserContextState } = await import('@/sync/domains/browser/context/state');
        const { updateBrowserAnnotationDocument, setBrowserAnnotationDraftComment } = await import('@/sync/domains/browser/context/annotationDraft');
        const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
        const { commitBrowserAnnotation } = await import('../browser/commitBrowserAnnotation');
        const { installImageAnnotationCanvasBoundary } = await import('@/dev/testkit/mocks/imageAnnotationCanvas');
        const canvas = installImageAnnotationCanvasBoundary();
        const uploadFile = vi.fn<typeof import('@/sync/domains/transfers/ops/uploadSessionAttachment').sessionAttachmentsUploadFile>(async request => {
            expect(request.file).toMatchObject({ kind: 'memory', bytes: new Uint8Array([9, 8, 7]) });
            return { success: true, path: '.happier/uploads/messages/annotation/flattened.png', sha256: 'b'.repeat(64), sizeBytes: 3,
                attachmentHandle: { v: 1, sessionId: sessionTarget.sessionId, id: 'flattened_browser_image' } };
        });
        const captureScreenshot = vi.fn(() => ({ ok: true as const, snapshot: { bytes: new Uint8Array([1, 2, 3, 4]),
            mimeType: 'image/png' as const, width: 40, height: 30, sizeBytes: 4 } }));
        const captureProvider = createBrowserAnnotationCaptureProvider({ captureScreenshot });
        const view: import('@/sync/domains/browser/control').BrowserControlViewState = {
            browserSessionId: 'browser_1', viewId: 'view_1', platform: 'web', adapterKind: 'localPreview', engineKind: 'webIframe',
            target: { kind: 'localServicePreview', targetId: 'preview_1', sessionId: sessionTarget.sessionId, machineId: 'machine_1' },
            adapterCapabilities: { ...buildBrowserAdapterCapabilities({ adapterKind: 'localPreview', supportedTargetKinds: ['localServicePreview'], supportedRenderEngines: ['webIframe'] }),
                contextKinds: ['browserPageReference', 'browserAnnotation'] },
            currentUrl: 'https://preview.test/page', title: 'Frozen page', currentUrlExpiresAt: null, pendingUrl: null, faviconUrl: null,
            loadingState: 'ready', loadingProgress: 1, navigationGeneration: 4, canGoBack: false, canGoForward: false,
            securityOrigin: 'https://preview.test', lastError: null, openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
        };
        let state = createBrowserContextState();
        const adapter = createBrowserContextAnnotationAdapter({ resolveBinding: () => ({ state, view,
            browserContextEnabled: true, attachmentsUploadsEnabled: true, contextCapabilities: { enabled: true, available: true,
                supportedContextKinds: ['browserPageReference', 'browserAnnotation'], supportedAdapterKinds: ['localPreview'],
                screenshot: { supported: true, requiresAttachmentUploads: true }, text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
                disabledReasons: [], policyDeniedReasons: [] }, captureProvider,
            commitAnnotation: input => commitBrowserAnnotation({ sessionTarget, config: { uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 }, uploadFile }, input),
        }), onStateChange: next => { state = next; } });
        try {
            expect(await adapter.dispatch({ kind: 'start' })).toMatchObject({ status: 'started' });
            state = updateBrowserAnnotationDocument(state, { viewId: view.viewId, document: { v: 1,
                image: { width: 40, height: 30, scale: 1 }, marks: [{ id: 'blur', kind: 'blur', rect: { x: 1, y: 1, width: 8, height: 8 }, size: 's' }] } });
            state = setBrowserAnnotationDraftComment(state, { viewId: view.viewId, comment: 'Fix the page' });
            const before = readComposerPresentationSnapshot(ref)!;
            expect(await adapter.dispatch({ kind: 'attachDraft' })).toMatchObject({ status: 'committed' });
            expect(captureScreenshot).toHaveBeenCalledTimes(1);
            expect(canvas.encodeCount()).toBe(1);
            expect(uploadFile).toHaveBeenCalledTimes(1);
            expect(admissions).toHaveBeenCalledTimes(1);
            expect(configReads).toHaveBeenCalledTimes(1);
            expect(readSessionAttachmentDrafts(attachmentScope)).toHaveLength(1);
            const after = readComposerPresentationSnapshot(ref)!;
            expect(after.revision).toBe(before.revision + 1);
            expect(after.text).toMatch(/\n\nFix the page$/);
            expect(after.text.match(/Fix the page/g)).toHaveLength(1);
            const item = state.itemsById[state.itemOrder[0]!]!;
            expect(item).toMatchObject({ kind: 'browserAnnotation', imageRef: { mediaId: 'flattened_browser_image' }, pageTitle: 'Frozen page' });
            expect(item).not.toHaveProperty('comment');
            expect(item).not.toHaveProperty('media');
            const retained = readSessionAttachmentDrafts(attachmentScope)[0]!;
            expect(retained.edit).toMatchObject({ original: { kind: 'memory', bytes: new Uint8Array([1, 2, 3, 4]) },
                document: { image: { width: 40, height: 30, scale: 1 }, marks: [{ id: 'blur', kind: 'blur' }] } });
            const { writeSessionAttachmentDrafts } = await import('../attachments/sessionAttachmentDraftStore');
            const { readComposerPictureSource, commitComposerPicture } = await import('./replaceComposerPicture');
            const occurrence = { kind: 'picked' as const, attachmentId: retained.id,
                getDraftsSnapshot: () => readSessionAttachmentDrafts(attachmentScope),
                replaceDrafts: (drafts: readonly import('../attachments/attachmentDraftModel').AttachmentDraft[]) => writeSessionAttachmentDrafts(attachmentScope, drafts) };
            const reopened = await readComposerPictureSource(occurrence);
            expect(reopened).toEqual({ uri: 'data:image/png;base64,AQIDBA==', width: 40, height: 30, scale: 1 });
            expect(await commitComposerPicture(occurrence, { v: 1, image: { width: 40, height: 30, scale: 1 }, marks: [] }, reopened!)).toMatchObject({ ok: true, status: 'reverted' });
            expect(readSessionAttachmentDrafts(attachmentScope)[0]!.source).toMatchObject({ kind: 'memory', bytes: new Uint8Array([1, 2, 3, 4]) });
            expect(uploadFile).toHaveBeenCalledTimes(1);
            expect(canvas.encodeCount()).toBe(1);
        } finally { admissions.mockRestore(); configReads.mockRestore(); vi.unstubAllGlobals(); }
    });
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
    it.each(['edit', 'revert'] as const)('sends the browser attachment current marks and uploaded picture after %s', async change => {
        const { commitBrowserAnnotation } = await import('../browser/commitBrowserAnnotation');
        const { commitComposerPicture } = await import('./replaceComposerPicture');
        const { installImageAnnotationCanvasBoundary } = await import('@/dev/testkit/mocks/imageAnnotationCanvas');
        const { writeSessionAttachmentDrafts } = await import('../attachments/sessionAttachmentDraftStore');
        const { uploadAttachmentDraftsToSession } = await import('../attachments/uploadAttachmentDraftsToSession');
        const { buildBrowserContextMessageMetaOverrides } = await import('@/sync/domains/session/input/browserContext');
        const { createBrowserContextState, startBrowserAnnotationDraft, applyBrowserAnnotationOperations,
            commitBrowserAnnotationDraft, attachBrowserContextToComposer } = await import('@/sync/domains/browser/context');
        installImageAnnotationCanvasBoundary();
        const source = { uri: 'data:image/png;base64,AQID', width: 40, height: 30, scale: 1 };
        const arrow = { id: 'a', kind: 'arrow' as const, from: { x: 1, y: 2 }, to: { x: 20, y: 25 }, color: 'red' as const, size: 'm' as const };
        let state = startBrowserAnnotationDraft(createBrowserContextState(), { browserSessionId: 'browser', viewId: 'view',
            navigationGeneration: 1, nowMs: 1, source,
            capture: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', width: 40, height: 30, sizeBytes: 3 } });
        state = applyBrowserAnnotationOperations(state, { viewId: 'view', operations: [{ kind: 'mark.add', mark: arrow }] });
        const frozen = state.annotationDraftByViewId.view!;
        let uploadCount = 0;
        const uploadFile = vi.fn(async () => {
            uploadCount += 1;
            return { success: true as const, path: `image-${uploadCount}.png`, sha256: 'a'.repeat(64), sizeBytes: 3,
                attachmentHandle: { v: 1 as const, sessionId: sessionTarget.sessionId, id: `image-${uploadCount}` } };
        });
        const config = { uploadLocation: 'workspace' as const, workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'none' as const,
            vcsIgnoreWritesEnabled: false, maxFileBytes: 1024 };
        const attached = await commitBrowserAnnotation({ sessionTarget, config, uploadFile }, { png: new Uint8Array([9, 8, 7]),
            width: 40, height: 30, original: source, document: frozen.document, annotationId: frozen.annotationId, comment: '' });
        if (!attached.ok) throw new Error('Browser Attach failed');
        const committed = commitBrowserAnnotationDraft({ state, browserSessionId: 'browser', viewId: 'view', navigationGeneration: 1,
            adapterKind: 'localPreview', capturedAtMs: 1, imageRef: attached.imageRef });
        if (committed.status !== 'committed') throw new Error('Browser context commit failed');
        const context = attachBrowserContextToComposer(committed.state, { attachmentId: 'browser-context', contextId: committed.itemIds[0]! });
        const draft = readSessionAttachmentDrafts(attachmentScope)[0]!;
        const document = { ...frozen.document, marks: change === 'revert' ? [] : [{ ...arrow, id: 'b', to: { x: 30, y: 20 } }] };
        expect(await commitComposerPicture({ kind: 'picked', attachmentId: draft.id,
            getDraftsSnapshot: () => readSessionAttachmentDrafts(attachmentScope),
            replaceDrafts: drafts => writeSessionAttachmentDrafts(attachmentScope, drafts) }, document, source)).toMatchObject({ ok: true });
        const { uploaded } = await uploadAttachmentDraftsToSession({ sessionId: sessionTarget.sessionId, sessionTarget,
            drafts: readSessionAttachmentDrafts(attachmentScope), config, uploadFile, applyDraftPatch: () => {} });
        const meta = buildBrowserContextMessageMetaOverrides({ state: context.state, uploadedAttachments: uploaded });
        if (!meta.ok) throw new Error('Send metadata failed');
        const { BrowserContextMessageMetaV1Schema } = await import('@happier-dev/protocol/browser/context/v1');
        const payload = BrowserContextMessageMetaV1Schema.parse(meta.metaOverrides.happierBrowserContext).payload;
        expect(payload.contexts[0]).toMatchObject({ marks: document, imageRef: { mediaId: uploaded[0]!.attachmentHandle.id,
            file: { path: uploaded[0]!.path } } });
        expect(payload.attachments[0]!.structuredBlock).toMatchObject({ marks: document,
            imageRef: { mediaId: uploaded[0]!.attachmentHandle.id, file: { path: uploaded[0]!.path } } });
        expect(uploadFile).toHaveBeenCalledTimes(2);
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
    it('copies a stage picture through one flatten and the shared append owner while leaving its source untouched', async () => {
        const { useMediaStageAnnotation } = await import('@/components/ui/media/stage/useMediaStageAnnotation');
        const { installImageAnnotationCanvasBoundary } = await import('@/dev/testkit/mocks/imageAnnotationCanvas');
        const canvas = installImageAnnotationCanvasBoundary();
        const source = { uri: 'blob:message-picture', width: 40, height: 30, scale: 1 };
        const item = { kind: 'image' as const, title: 'Message.png', source: { enabled: true, source: { kind: 'uri' as const, uri: source.uri } } };
        const document = { v: 1 as const, image: { width: 40, height: 30, scale: 1 }, marks: [
            { id: 'arrow', kind: 'arrow' as const, from: { x: 2, y: 3 }, to: { x: 32, y: 24 }, color: 'red' as const, size: 's' as const },
        ] };
        const stage = await renderHook(() => useMediaStageAnnotation(item));
        try {
            await act(async () => { await stage.getCurrent().enter(source); });
            await act(async () => { await stage.getCurrent().done(document); });
            expect(stage.getCurrent().choosingSession).toBe(true);
            expect(canvas.encodeCount()).toBe(0);
            const transcript = storage.getState().sessionMessages;
            await act(async () => { expect(await stage.getCurrent().copyToSession(sessionTarget)).toBe(true); });
            expect(readSessionAttachmentDrafts(attachmentScope)).toHaveLength(1);
            expect(readSessionAttachmentDrafts(attachmentScope)[0]!.source).toMatchObject({ kind: 'memory', name: 'Message.png', mimeType: 'image/png' });
            expect(canvas.encodeCount()).toBe(1);
            expect(storage.getState().sessionMessages).toBe(transcript);
            expect(item.source.source.uri).toBe(source.uri);
            expect(stage.getCurrent().mode).toBe('view');
        } finally { await stage.unmount(); vi.unstubAllGlobals(); }
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

    it('delivers selected recording frames and their clip-relative words with one draft transaction, never a desktop path', async () => {
        const { createNativeScreenCaptureAction } = await import('@/sync/ops/actions/screenCaptureActions');
        const { createRecordingDocument, reduceRecordingDocument } = await import('@/components/screenCapture/recording/recordingDocument');
        let recording = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'recording', durationMs: 5000, includeWindowText: false });
        for (const operation of [
            { kind: 'pin.add', sourceTimeMs: 1000 }, { kind: 'pin.add', sourceTimeMs: 2000 },
            { kind: 'note.set', id: 'note', sourceTimeMs: 2000, text: 'Inspect this moment' },
            { kind: 'trim.set', startMs: 1000, endMs: 3000 },
        ] as const) recording = reduceRecordingDocument(recording, operation);
        const video = { captureRef: 'recording', kind: 'video', path: '/Other-Desktop/recording.mp4', mimeType: 'video/mp4',
            byteSize: 100, pixelSize: { width: 4, height: 4 }, scale: 1, origin: null, source: null, windowTextRef: null };
        const commands: string[] = [];
        const secureStorage = createDesktopSecureStorageBoundary();
        // Browser media decoding and native file I/O are genuine system boundaries;
        // document projection, delivery, draft admission and transaction remain real.
        let videoTime = 0;
        const browser = await installBrowserRuntimeForTests({ url: 'https://recording-delivery.test/' });
        const createElement = browser.document.createElement.bind(browser.document);
        const elements = vi.spyOn(browser.document, 'createElement').mockImplementation((tag: string) => {
            const element = createElement(tag);
            if (tag === 'canvas') {
                const canvas = element as HTMLCanvasElement;
                vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
                vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
            }
            if (tag !== 'video') return element;
            Object.defineProperties(element, {
                readyState: { value: 2 }, paused: { value: true }, seeking: { value: false },
                videoWidth: { value: 4 }, videoHeight: { value: 4 },
                currentTime: { get: () => videoTime, set(value: number) {
                    videoTime = value;
                    queueMicrotask(() => element.dispatchEvent(new browser.window.Event('seeked')));
                } },
            });
            Object.assign(element, { load() {}, pause() {}, async play() {} });
            return element;
        });
        const createUrl = URL.createObjectURL;
        const revokeUrl = URL.revokeObjectURL;
        URL.createObjectURL = () => 'blob:recording'; URL.revokeObjectURL = () => {};
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            commands.push(command);
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            if (command === 'desktop_capture_read_result') return video;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: false, disclosure: null, windowText: null, preparedRecording: null };
            if (command === 'desktop_recording_document_read') return recording;
            if (command === 'desktop_capture_read_source_png') return [4, 5, 6];
            if (command === 'desktop_recording_trim') return { ...video, captureRef: 'trimmed', path: '/Other-Desktop/trimmed.mp4', byteSize: 50 };
            if (command === 'desktop_recording_prepare') {
                const frames = args!.frames as Array<{ timeMs: number; note: string }>;
                return { captureRef: 'recording', frames: frames.map((frame, index) => ({ frameRef: `frame-${index}`,
                    ...frame, byteSize: 3, pixelSize: video.pixelSize })), videoRef: 'trimmed', includeVideo: true, byteSize: 56 };
            }
            if (command === 'desktop_capture_read_prepared_png') return [1, 2, 3];
            if (command === 'desktop_capture_settle') return { status: 'idle' };
            throw new Error(`Unexpected native command ${command}`);
        } });
        try {
            const before = readComposerPresentationSnapshot(ref)!;
            const changed = vi.fn();
            const owner = createExistingSessionComposerDocumentOwner({ scope, ref });
            const unobserve = owner.observe(changed);
            try {
                const delivered = await captureExecutor(createNativeScreenCaptureAction())
                    .execute('screenCapture.addToDraft', { captureRef: 'recording', session: sessionTarget }, { surface: 'ui' });
                expect(delivered.ok, delivered.ok ? '' : delivered.errorCode).toBe(true);
                expect(delivered).toMatchObject({ ok: true, result: { captureRef: 'recording', imageNumbers: [1, 2],
                    summary: { frameCount: 2, durationMs: 2000, byteSize: 56, includeVideo: true } } });
                expect(readComposerPresentationSnapshot(ref)!.revision).toBe(before.revision + 1);
                expect(changed).toHaveBeenCalledOnce();
                const drafts = readSessionAttachmentDrafts(attachmentScope);
                expect(drafts).toHaveLength(3);
                expect(drafts.map(draft => draft.source.kind)).toEqual(['memory', 'memory', 'memory']);
                expect(readComposerPresentationSnapshot(ref)!.text).toContain('0:00.000 — pin');
                expect(readComposerPresentationSnapshot(ref)!.text).toContain('0:01.000 — pin; note: "Inspect this moment"');
                expect(readComposerPresentationSnapshot(ref)!.text).not.toContain('/Other-Desktop/');
                expect(commands.filter(command => command === 'desktop_recording_prepare')).toHaveLength(1);
                expect(commands).not.toContain('desktop_capture_window_text');
            } finally { unobserve(); }
        } finally {
            URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
            elements.mockRestore(); browser.restore();
        }
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

    it('admits the capture Action through the real append owner using prepared pixels and the persisted disclosure', async () => {
        const { createScreenCaptureAction } = await import('@/sync/ops/actions/screenCaptureActions');
        const secure = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: secure.invoke });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const executor = captureExecutor(createScreenCaptureAction({
            readDelivery: async captureRef => ({ captureRef, image: { kind: 'prepared', bytes, name: 'Prepared.png' },
                disclosure: { hasMarks: true, includeWindowText: false }, inUse: false,
                windowText: { text: 'Excluded text', name: 'Window text.txt' } }),
            open: async () => {}, discard: async () => {},
        }));
        expect(await executor.execute('screenCapture.addToDraft', { captureRef: 'capture-action', session: sessionTarget, note: 'Action note' },
            { surface: 'ui' })).toMatchObject({ ok: true, result: { captureRef: 'capture-action', imageNumber: 1, waiting: false } });
        const drafts = readSessionAttachmentDrafts(attachmentScope);
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ status: 'pending', source: { kind: 'memory', name: 'Prepared.png', bytes,
            previewUri: 'data:image/png;base64,iVBORw==' } });
        expect(drafts[0]?.source.kind === 'memory' && drafts[0].source.bytes).toBe(bytes);
        expect(readComposerPresentationSnapshot(ref)?.text).toMatch(/^Existing words\n\n\[Prepared.png\].* Action note$/);
    });

    it('orders two Capture windows into one draft while keeping a different Session separate', async () => {
        const { createScreenCaptureAction } = await import('@/sync/ops/actions/screenCaptureActions');
        const secure = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: secure.invoke });
        const otherTarget = { ...sessionTarget, sessionId: 'other-capture-session' };
        const otherScope = resolveSessionAttachmentDraftScope(otherTarget);
        storage.setState(state => ({ sessions: { ...state.sessions,
            [otherTarget.sessionId]: createSessionFixture({ id: otherTarget.sessionId }) } }));
        const executor = captureExecutor(createScreenCaptureAction({
            readDelivery: async captureRef => ({ captureRef, image: { kind: 'prepared', bytes: new Uint8Array([137, 80, 78, 71]), name: `${captureRef}.png` },
                disclosure: { hasMarks: false, includeWindowText: false }, inUse: false }),
            open: async () => {}, discard: async () => {},
        }));
        try {
            for (const [captureRef, session, imageNumber] of [
                ['window-1', sessionTarget, 1], ['window-2', sessionTarget, 2], ['window-3', otherTarget, 1],
            ] as const) {
                expect(await executor.execute('screenCapture.addToDraft', { captureRef, session }, { surface: 'ui' }))
                    .toMatchObject({ ok: true, result: { captureRef, imageNumber } });
            }
            expect(readSessionAttachmentDrafts(attachmentScope).map(draft => draft.source.name)).toEqual(['window-1.png', 'window-2.png']);
            expect(readSessionAttachmentDrafts(otherScope).map(draft => draft.source.name)).toEqual(['window-3.png']);
        } finally { clearSessionAttachmentDrafts(otherScope); }
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
