// @vitest-environment jsdom
// The shared video frame reader needs a DOM; the download, Action and draft owners are the real ones.
import 'fake-indexeddb/auto';
import { Platform } from 'react-native';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

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

describe('received video frame annotation', () => {
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

    it('marks a received video frame with numbered steps through the same Action and copies it with its time and notes', async () => {
        harness = await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([0, 0, 0, 24]) });
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
        const media = SessionMediaItemV1Schema.parse({ id: 'source-video', mediaKind: 'video', name: 'checkout-1440.mp4',
            path: '.happier/media/clip.mp4', mimeType: 'video/mp4', sizeBytes: 4, category: 'attachment', role: 'input', origin: { source: 'user-upload' } });
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
        // jsdom's Blob lacks arrayBuffer; use the platform encoder's real Blob contract.
        vi.stubGlobal('Blob', NodeBlob);
        // Browser video decoder boundary (the shared frame reader's seek, paint and 2D draw); frame choice stays real.
        const create = document.createElement.bind(document);
        const seeks: number[] = [];
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
            const element = create(tag);
            if (tag === 'video') {
                const video = element as HTMLVideoElement;
                let currentTime = 0;
                Object.defineProperties(video, { readyState: { value: 2 }, paused: { value: true }, seeking: { value: false },
                    videoWidth: { value: 4 }, videoHeight: { value: 4 }, currentTime: { get: () => currentTime, set: (value: number) => {
                        currentTime = value; seeks.push(value);
                        queueMicrotask(() => video.dispatchEvent(new Event('seeked')));
                    } } });
                vi.spyOn(video, 'load').mockImplementation(() => {});
                vi.spyOn(video, 'pause').mockImplementation(() => {});
                vi.spyOn(video, 'play').mockImplementation(async () => {});
            }
            return element;
        }) as typeof document.createElement);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => kind === '2d'
            ? { drawImage: () => {} } : null) as unknown as HTMLCanvasElement['getContext']);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID');
        // jsdom's URL has no object-URL functions; the browser boundary supplies them here.
        const revoke = vi.fn();
        vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'blob:annotation-source', revokeObjectURL: revoke }));
        try {
            expect(storage.getState().profileScope).toEqual(scope);
            expect(storage.getState().sessions['annotation-source']?.access?.capabilities.readTranscript).toBe(true);
            const { readTranscriptSessionMediaMeta } = await import('@/components/sessions/transcript/structured/happierMetaEnvelope');
            expect(readTranscriptSessionMediaMeta(transcript.messagesById.message!.meta)?.inlineMedia[0]?.id).toBe('source-video');
            const { resolveWorkspaceTargetForSession } = await import('@/sync/domains/session/resolveWorkspaceTargetForSession');
            expect(resolveWorkspaceTargetForSession({ ...scope, sessionId: 'annotation-source' })).toMatchObject(harness.scope);
            const executor = createDefaultActionExecutor();
            const outcome = await executor.execute('media.annotation.apply', { scope,
                target: { kind: 'sessionVideoFrame', sessionId: 'annotation-source', mediaId: 'source-video', timeMs: 18_000 },
                into: { sessionId: destination.sessionId },
                operations: [
                    { kind: 'mark.add', mark: { id: 'pay', kind: 'step', at: { x: 1, y: 2 }, color: 'red', size: 's', note: 'Pay slides over the card edge' } },
                    { kind: 'mark.add', mark: { id: 'total', kind: 'step', at: { x: 3, y: 2 }, color: 'red', size: 's' } },
                ],
            }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId });
            expect(storage.getState().profileScope).toEqual(scope);
            expect(storage.getState().sessionMessages['annotation-source']).toBe(transcript);
            expect(harness.rpcRequests.length, 'The admitted source must reach the real download boundary').toBeGreaterThan(0);
            expect(seeks, 'The frame is read at the addressed time').toContain(18);
            expect(revoke, 'The temporary original is disposed after copy').toHaveBeenCalledWith('blob:annotation-source');
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { status: 'appended', imageNumber: 1 } });
            expect(readSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(destination))).toHaveLength(1);
            const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
            expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: destination.sessionId })?.text)
                .toContain('0:18\nNumbered marks:\n1. Pay slides over the card edge\n2. (no note)');
            expect(storage.getState().sessionMessages['annotation-source']).toBe(transcript);
            expect(canvas.encodeCount()).toBe(1);
            const requests = harness.rpcRequests.length;
            expect(await executor.execute('media.annotation.read', { scope: { ...scope, accountId: 'other-account' },
                target: { kind: 'sessionVideoFrame', sessionId: 'annotation-source', mediaId: 'source-video', timeMs: 18_000 } },
                { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId }))
                .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
            expect(harness.rpcRequests).toHaveLength(requests);
            expect(canvas.encodeCount()).toBe(1);
        } finally { clearSessionAttachmentDrafts(resolveSessionAttachmentDraftScope(destination)); storage.setState(originalState, true); }
    });

});
