import 'fake-indexeddb/auto';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createBytesPreviewSource, createComposerStagedMediaPreviewSource, createSessionFilePreviewSource } from './createSessionFilePreviewSource';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Image: { getSize: (_uri: string, success: (width: number, height: number) => void) => success(40, 30) },
}));

const nativeFiles = vi.hoisted(() => ({
    current: null as ReturnType<typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock> | null,
}));
vi.mock('expo-file-system', async () => {
    const fixture = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    nativeFiles.current = fixture;
    return fixture.module;
});

// Load the real Sync/transfer graph once, outside behavior timeouts. Only SDK,
// network, credential persistence, filesystem and object-URL boundaries vary.
await loadSyncSingletonForTests();
await import('expo-file-system');

describe('createSessionFilePreviewSource', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>> | null;
    let annotationConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null;
    beforeEach(() => {
        harness = null;
        annotationConnection = null;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const credentials = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
            if (command.startsWith('desktop_secure_storage_')) return await credentials.invoke(command, args);
            if (command === 'iroh_get_availability') return { available: true };
            if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
            if (command === 'iroh_start_machine_tunnel') return { leaseId: 'preview-desktop-lease', localPort: 48126 };
            if (command === 'iroh_stop_machine_tunnel') return undefined;
            throw new Error(`Unexpected desktop IPC command: ${command}`);
        } });
        nativeFiles.current!.files.clear();
    });
    afterEach(async () => {
        await annotationConnection?.dispose();
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it.each([false, true])('creates revocable Blob object URLs on web and retains bytes only when requested (%s)', async (retainBytes) => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'image.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const transferOwner = await import('@/sync/domains/transfers/runtime/transferRuntime');
        const downloads = vi.spyOn(transferOwner, 'downloadDaemonWorkspaceFileToDestination');
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png', maxBytes: 16,
            retainBytes,
        });
        expect(source.ok, source.ok ? undefined : source.error).toBe(true);
        if (!source.ok || source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');
        expect(source.source).toMatchObject({ uri: 'blob:preview-1', byteLength: 4, mimeType: 'image/png' });
        const blob = createObjectURL.mock.calls[0]![0];
        expect(blob).toBeInstanceOf(Blob);
        if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(source.source.bytes).toEqual(retainBytes ? new Uint8Array([1, 2, 3, 4]) : undefined);
        expect(downloads).toHaveBeenCalledTimes(1);
        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    });

    it('reads a daemon approval image through its Action from the settled Home inventory while the active map is empty', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'approval.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://workspace-download.example.test', { serverId: harness.scope.serverId });
        if (!credentials) throw new Error('Expected the synthetic download Account');
        annotationConnection = await restoreServerAccountForTest({ serverUrl: 'https://workspace-download.example.test',
            serverIdentityId: 'srv_workspace_download', credentials, request: harness.request,
            additionalRequestOrigins: ['http://127.0.0.1:46001', 'http://127.0.0.1:48126'] });
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        await sync.awaitBootstrapForegroundAcquisition();
        const { storage } = await import('@/sync/domains/state/storage');
        const { getAppliedActiveServerId } = await import('@/sync/runtime/orchestration/connectionManager');
        const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        expect(areServerProfileIdentifiersEquivalent(getAppliedActiveServerId(), harness.scope.serverId)).toBe(true);
        const machine = storage.getState().machines[harness.scope.machineId];
        if (!machine) throw new Error('Expected the loaded download Machine');
        storage.setState({ machines: {}, machineListByServerId: { [harness.scope.serverId]: [machine] },
            machineListStatusByServerId: { [harness.scope.serverId]: 'idle' } });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:approval-image');
        const result = await createSessionFilePreviewSource({ scope: harness.scope,
            filePath: '.happier/uploads/artifacts/session/capture/approval.png', mimeType: 'image/png', maxBytes: 16 });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, source: { byteLength: 4 } });
        if (result.ok) {
            if (result.source.kind === 'object-url') result.source.revoke();
            else await result.source.delete();
        }
    });

    it('applies session-image marks through the Action, real download and shared draft append without mutating the transcript', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'source.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://workspace-download.example.test', { serverId: harness.scope.serverId });
        if (!credentials) throw new Error('Expected the synthetic download Account');
        annotationConnection = await restoreServerAccountForTest({ serverUrl: 'https://workspace-download.example.test',
            serverIdentityId: 'srv_workspace_download', credentials, request: harness.request,
            // The download fixture publishes a loopback carrier and its native tunnel.
            additionalRequestOrigins: ['http://127.0.0.1:46001', 'http://127.0.0.1:48126'] });
        const { sync } = await import('@/sync/sync');
        await sync.resumeSync('manual');
        await sync.awaitBootstrapForegroundAcquisition();
        const { SessionMediaItemV1Schema } = await import('@happier-dev/protocol');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createSessionMessagesFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
        const { installImageAnnotationCanvasBoundary } = await import('@/dev/testkit/mocks/imageAnnotationCanvas');
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        const { writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { readSessionAttachmentDrafts, resolveSessionAttachmentDraftScope, clearSessionAttachmentDrafts } = await import('@/components/sessions/attachments/sessionAttachmentDraftStore');
        const scope = { serverId: harness.scope.serverId, accountId: 'workspace-download-account' };
        const destination = { ...scope, sessionId: 'annotation-destination' };
        const originalState = storage.getState();
        storage.getState().activateProfileScope(scope);
        storage.getState().activateSessionLocalStateScope(scope);
        const media = SessionMediaItemV1Schema.parse({ id: 'source-image', mediaKind: 'image', name: 'source.png',
            path: '.happier/media/source.png', mimeType: 'image/png', sizeBytes: 4, category: 'attachment', role: 'input', origin: { source: 'user-upload' } });
        const transcript = createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: ['message'], messagesById: {
            message: { kind: 'user-text', id: 'message', localId: null, createdAt: 1, text: 'Original message',
                meta: { happier: { kind: 'session_media.v1', payload: { media: [media] } } } },
        } });
        storage.setState(state => ({ ...state, sessions: { ...state.sessions,
            'annotation-source': createSessionFixture({ id: 'annotation-source', serverId: scope.serverId, metadata: { path: '/repo', host: 'test.local', machineId: harness!.scope.machineId } }),
            [destination.sessionId]: createSessionFixture({ id: destination.sessionId, serverId: scope.serverId }),
        }, sessionMessages: { ...state.sessionMessages, 'annotation-source': transcript } }));
        writeExistingSessionDraft({ scope, sessionId: destination.sessionId, patch: { text: '' } });
        const canvas = installImageAnnotationCanvasBoundary();
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:annotation-source');
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            expect(storage.getState().profileScope).toEqual(scope);
            expect(storage.getState().sessions['annotation-source']?.access?.capabilities.readTranscript).toBe(true);
            const { readTranscriptSessionMediaMeta } = await import('@/components/sessions/transcript/structured/happierMetaEnvelope');
            expect(readTranscriptSessionMediaMeta(transcript.messagesById.message!.meta)?.inlineImages[0]?.id).toBe('source-image');
            const { resolveWorkspaceTargetForSession } = await import('@/sync/domains/session/resolveWorkspaceTargetForSession');
            expect(resolveWorkspaceTargetForSession({ ...scope, sessionId: 'annotation-source' })).toMatchObject(harness.scope);
            const executor = createDefaultActionExecutor();
            const outcome = await executor.execute('media.annotation.apply', { scope,
                target: { kind: 'sessionImage', sessionId: 'annotation-source', mediaId: 'source-image' }, into: { sessionId: destination.sessionId },
                operations: [{ kind: 'mark.add', mark: { id: 'arrow', kind: 'arrow', from: { x: 1, y: 2 }, to: { x: 30, y: 20 }, color: 'red', size: 's' } }],
            }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId });
            expect(storage.getState().profileScope).toEqual(scope);
            expect(storage.getState().sessionMessages['annotation-source']).toBe(transcript);
            expect(harness.rpcRequests.length, 'The admitted source must reach the real download boundary').toBeGreaterThan(0);
            expect(revoke, 'The temporary original is disposed after copy').toHaveBeenCalledWith('blob:annotation-source');
            expect(outcome).toEqual({ ok: true, result: { status: 'appended', imageNumber: 1 } });
            expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(destination))).toHaveLength(1);
            expect(storage.getState().sessionMessages['annotation-source']).toBe(transcript);
            expect(canvas.encodeCount()).toBe(1);
            const requests = harness.rpcRequests.length;
            expect(await executor.execute('media.annotation.read', { scope: { ...scope, accountId: 'other-account' },
                target: { kind: 'sessionImage', sessionId: 'annotation-source', mediaId: 'source-image' } },
                { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
                .toEqual({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
            expect(harness.rpcRequests).toHaveLength(requests);
            expect(canvas.encodeCount()).toBe(1);
        } finally { clearSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(destination)); storage.setState(originalState, true); }
    });

    it('keeps cold workspace download preparation alive beyond the byte-request deadline', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'hero.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const preparation = harness.deferNextDownloadPreparation();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cold-preview');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'assets/hero.png', mimeType: 'image/png', maxBytes: 16,
        });
        try {
            await preparation.entered;
            const request = harness.requests.find(request => request.url.endsWith('/v1/actions/daemon.filesystem.download'));
            expect(request?.signal).toBeDefined();
            await vi.advanceTimersByTimeAsync(5_001);
            expect(request?.signal?.aborted).toBe(false);
            expect(createObjectURL).not.toHaveBeenCalled();
            preparation.release();
            const result = await pending;
            expect(result).toMatchObject({ ok: true, source: { uri: 'blob:cold-preview', byteLength: 4 } });
            if (result.ok && result.source.kind === 'object-url') result.source.revoke();
        } finally {
            preparation.release();
            await pending;
            vi.useRealTimers();
        }
    });

    it('cancels workspace download preparation when the preview caller retires', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'hero.png', bytes: new Uint8Array([1, 2, 3, 4]) });
        const preparation = harness.deferNextDownloadPreparation();
        const controller = new AbortController();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retired-preview');
        const pending = createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'assets/hero.png', mimeType: 'image/png', maxBytes: 16, signal: controller.signal,
        });
        try {
            await preparation.entered;
            const request = harness.requests.find(request => request.url.endsWith('/v1/actions/daemon.filesystem.download'));
            expect(request?.signal?.aborted).toBe(false);
            controller.abort();
            expect(request?.signal?.aborted).toBe(true);
            preparation.release();
            expect(await pending).toMatchObject({ ok: false });
            expect(createObjectURL).not.toHaveBeenCalled();
        } finally {
            preparation.release();
            await pending;
        }
    });

    it('creates a bounded preview from an exact opaque staged-media inspection without a workspace path', async () => {
        harness = await createWorkspaceFileDownloadHarness({
            name: 'incident.png', bytes: new Uint8Array([1, 2, 3, 4]), composerInspection: { id: 'stage_42' },
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:composer-stage-preview');
        if (!harness.composerHandle) throw new Error('Expected Composer stage fixture');
        const source = await createComposerStagedMediaPreviewSource({ handle: harness.composerHandle, maxBytes: 16 });
        expect(source).toMatchObject({ ok: true, source: {
            kind: 'object-url', uri: 'blob:composer-stage-preview', byteLength: 4, mimeType: 'image/png',
        } });
        const preparation = harness.rpcRequests.find(request => request.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        expect(preparation?.payload).toEqual({ t: 'composer_media_stage_inspect_v1', handle: harness.composerHandle, offset: 0, maxBytes: 4 });
        expect(harness.rpcRequests.some(request => request.method === 'daemon.filesystem.download')).toBe(false);
        const blob = createObjectURL.mock.calls[0]![0];
        if (!(blob instanceof Blob)) throw new Error('Expected preview Blob');
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        if (source.ok && source.source.kind === 'object-url') source.source.revoke();
    });

    it('rejects an incomplete staged-media range before it can create a preview source', async () => {
        harness = await createWorkspaceFileDownloadHarness({
            name: 'incident.png', bytes: new Uint8Array([1, 2]), composerInspection: { id: 'stage_partial', sizeBytes: 4 },
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-exist');
        if (!harness.composerHandle) throw new Error('Expected Composer stage fixture');
        const source = await createComposerStagedMediaPreviewSource({ handle: harness.composerHandle, maxBytes: 16 });
        expect(source).toEqual({ ok: false, error: 'Composer media inspection returned an invalid range' });
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('does not create an object URL when the preview request is cancelled after transfer settlement', async () => {
        const controller = new AbortController();
        harness = await createWorkspaceFileDownloadHarness({
            name: 'image.png', bytes: new Uint8Array([1, 2]), onCompleted: () => controller.abort(),
        });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cancelled-preview');
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png',
            maxBytes: 16, signal: controller.signal,
        });
        expect(harness.requests.some(request => request.url.endsWith('/complete'))).toBe(true);
        expect(source.ok).toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('creates revocable Blob object URLs for supported video evidence references on web', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'recording.webm', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording-preview-1');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
            mimeType: 'video/webm', maxBytes: 16,
        });
        expect(source).toMatchObject({ ok: true, source: {
            kind: 'object-url', uri: 'blob:recording-preview-1', byteLength: 8, mimeType: 'video/webm',
        } });
        if (!source.ok || source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');
        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:recording-preview-1');
    });

    it.each([false, true])('writes native previews through the shared cache sink with opt-in retained bytes (%s)', async (retainBytes) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'image.png', bytes: new Uint8Array([1, 2, 3]) });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: '.happier/uploads/messages/m1/image.png', mimeType: 'image/png', maxBytes: 16,
            retainBytes,
        });
        expect(source.ok, source.ok ? undefined : source.error).toBe(true);
        if (!source.ok || source.source.kind !== 'cache-file') throw new Error('Expected cache-file preview source');
        expect(source.source).toMatchObject({ byteLength: 3, mimeType: 'image/png' });
        expect(source.source.uri).toMatch(/^file:\/\/\/cache\/happier-session-file-previews\/[^/]+-image\.png$/);
        expect(nativeFiles.current!.files.get(source.source.uri)).toEqual([1, 2, 3]);
        expect(nativeFiles.current!.close).toHaveBeenCalledWith(source.source.uri);
        await source.source.delete();
        expect(nativeFiles.current!.deleteFile).toHaveBeenCalledWith(source.source.uri);
        expect(nativeFiles.current!.files.size).toBe(0);
        expect(source.source.bytes).toEqual(retainBytes ? new Uint8Array([1, 2, 3]) : undefined);
    });

    it.each([
        ['icon.svg', 'image/svg+xml'], ['document.pdf', 'application/pdf'], ['voice.mp3', 'audio/mpeg'],
    ])('admits %s through the shared file classifier', async (filePath, mimeType) => {
        harness = await createWorkspaceFileDownloadHarness({ name: filePath, bytes: new Uint8Array([1, 2, 3]) });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath, mimeType, maxBytes: 16,
        });
        expect(source).toMatchObject({ ok: true, source: { mimeType, byteLength: 3 } });
        if (source.ok && source.source.kind === 'object-url') source.source.revoke();
    });

    it('rejects non-previewable files before reading bytes', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'archive.zip' });
        const source = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'archive.zip', mimeType: 'application/zip', maxBytes: 16,
        });
        expect(source).toEqual({ ok: false, error: 'Unsupported preview type', errorCode: 'unsupported' });
        expect(harness.rpcRequests).toEqual([]);
    });

    it('materializes bytes through the shared budget and destination', async () => {
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bytes');
        const bytes = new Uint8Array([1, 2, 3]);
        expect(await createBytesPreviewSource({ bytes, fileName: 'icon.svg', mimeType: 'image/svg+xml', maxBytes: 2 }))
            .toEqual({ ok: false, error: 'File exceeds the preview size limit', errorCode: 'too_large' });
        expect(await createBytesPreviewSource({ bytes, fileName: 'icon.svg', mimeType: 'image/svg+xml', maxBytes: 3 }))
            .toMatchObject({ ok: true, source: { uri: 'blob:bytes', byteLength: 3, mimeType: 'image/svg+xml' } });
    });

    it('keeps destination ENOENT as a retryable load failure for already-held bytes', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const error = "ENOENT: cannot create preview cache";
        nativeFiles.current!.create.mockImplementationOnce(() => { throw Object.assign(new Error(error), { code: 'ENOENT' }); });
        const result = await createBytesPreviewSource({ bytes: new Uint8Array([1]), fileName: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null });
        expect(result).toEqual({ ok: false, error });
        if (result.ok) throw new Error('Expected destination failure');
        const { resolvePreviewUnavailable, previewUnavailableCard } = await import('@/components/ui/media/previewUnavailable');
        expect(previewUnavailableCard(resolvePreviewUnavailable(result), 'clip.mp4')).toMatchObject({ kind: 'error', retryable: true });
    });

    it('deletes a native bytes destination cancelled while writing', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const controller = new AbortController();
        nativeFiles.current!.writes.mockImplementationOnce(() => controller.abort());
        const result = await createBytesPreviewSource({
            bytes: new Uint8Array([1, 2, 3]), fileName: 'cancelled.svg', mimeType: 'image/svg+xml', maxBytes: 3,
            signal: controller.signal,
        });
        expect(result).toEqual({ ok: false, error: 'Preview request cancelled' });
        expect(nativeFiles.current!.files.size).toBe(0);
    });

    it('materializes an Android MP4 through the encrypted prepared workspace carrier without an image/text limit', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '2');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
        const result = await createSessionFilePreviewSource({
            scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null,
        });
        expect(result.ok, result.ok ? undefined : result.error).toBe(true);
        expect(result).toMatchObject({ ok: true, source: { kind: 'cache-file', mimeType: 'video/mp4', byteLength: 3 } });
        if (!result.ok || result.source.kind !== 'cache-file') throw new Error('Expected video cache source');
        expect(nativeFiles.current!.files.get(result.source.uri)).toEqual([1, 2, 3]);
        expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(true);
        await result.source.delete();
        expect(nativeFiles.current!.files.size).toBe(0);
    });

    it.each(['video/mp4', 'image/png'])('rejects %s at the shared web buffering budget before encrypted chunk reads', async mimeType => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '2');
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized-preview');
        const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType, maxBytes: mimeType === 'video/mp4' ? null : 100 });
        expect(result).toEqual({ ok: false, error: 'File exceeds the preview size limit', errorCode: 'too_large' });
        expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('materializes a web video exactly at the shared buffering budget through encrypted chunks', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '3');
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bounded-preview');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null });
        expect(result).toMatchObject({ ok: true, source: { kind: 'object-url', byteLength: 3 } });
        expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(true);
        if (result.ok && result.source.kind === 'object-url') result.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview');
    });

    it('retains the existing web memory ceiling even when file-backed download admission is configured higher', async () => {
        const { WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES } = await import('@/hooks/workspaces/transfers/webDownloadFileSink');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', String(WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES * 2));
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized-preview');
        const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null, expectedSizeBytes: WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES + 1 });
        expect(result).toEqual({ ok: false, error: 'File exceeds the preview size limit', errorCode: 'too_large' });
        expect(harness.rpcRequests).toHaveLength(0);
        expect(createObjectURL).not.toHaveBeenCalled();
    });
});
