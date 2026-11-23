// No DOM here, as on iOS and Android: the frame owner resolves to its native module, the way Metro resolves it.
// Skia's platform video decoder is the boundary; the download, Action, flatten and draft owners are the real ones.
import 'fake-indexeddb/auto';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { SkiaMockBoundary } from '@/dev/testkit/mocks/skia';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Image: {
      getSize: (
        _uri: string,
        success: (width: number, height: number) => void,
      ) => success(40, 30),
    },
  }),
);
const nativeFiles = vi.hoisted(() => ({
  current: null as ReturnType<
    typeof import('@/dev/testkit/mocks/expoFileSystem').createExpoFileSystemFileMock
  > | null,
  skia: null as SkiaMockBoundary | null,
}));
vi.mock('expo-file-system', async () => {
  const fixture = (
    await import('@/dev/testkit/mocks/expoFileSystem')
  ).createExpoFileSystemFileMock();
  nativeFiles.current = fixture;
  return fixture.module;
});
vi.mock('@shopify/react-native-skia', async () => {
  const mock = (
    await import('@/dev/testkit/mocks/skia')
  ).createSkiaModuleMock();
  nativeFiles.skia = mock.boundary;
  return mock.module;
});
vi.mock(
  '@/components/workspaces/files/file/videoFrameAccess',
  () => import('@/components/workspaces/files/file/videoFrameAccess.native'),
);

await loadSyncSingletonForTests();
await import('expo-file-system');

describe('received video frame annotation without a DOM', () => {
  const previousPlatform = Platform.OS;
  let harness: Awaited<
    ReturnType<typeof createWorkspaceFileDownloadHarness>
  > | null;
  let connection: Awaited<
    ReturnType<typeof restoreServerAccountForTest>
  > | null;
  beforeEach(() => {
    harness = null;
    connection = null;
    // The download boundary stays the desktop one this harness models; only frame access is native.
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const credentials = createDesktopSecureStorageBoundary();
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: async (
        command: string,
        args?: Readonly<Record<string, unknown>>,
      ) => {
        if (command.startsWith('desktop_secure_storage_'))
          return await credentials.invoke(command, args);
        if (command === 'iroh_get_availability') return { available: true };
        if (command === 'iroh_get_application_endpoint')
          return { endpointId: 'b'.repeat(64) };
        if (command === 'iroh_start_machine_tunnel')
          return { leaseId: 'preview-desktop-lease', localPort: 48126 };
        if (command === 'iroh_stop_machine_tunnel') return undefined;
        throw new Error(`Unexpected desktop IPC command: ${command}`);
      },
    });
    nativeFiles.current!.files.clear();
    nativeFiles.skia!.videos.length = 0;
  });
  afterEach(async () => {
    await connection?.dispose();
    await harness?.reset();
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: previousPlatform,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('copies the addressed frame with its time and numbered notes', async () => {
    expect(typeof globalThis.document).toBe('undefined');
    harness = await createWorkspaceFileDownloadHarness({
      name: 'clip.mp4',
      bytes: new Uint8Array([0, 0, 0, 24]),
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(
      'https://workspace-download.example.test',
      { serverId: harness.scope.serverId },
    );
    if (!credentials)
      throw new Error('Expected the synthetic download Account');
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://workspace-download.example.test',
      serverIdentityId: 'srv_workspace_download',
      credentials,
      request: harness.request,
      additionalRequestOrigins: [
        'http://127.0.0.1:46001',
        'http://127.0.0.1:48126',
      ],
    });
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await sync.awaitBootstrapForegroundAcquisition();
    const { SessionMediaItemV1Schema } = await import('@happier-dev/protocol');
    const { createDefaultActionExecutor } =
      await import('@/sync/ops/actions/defaultActionExecutor');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionFixture } =
      await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createSessionMessagesFixture } =
      await import('@/dev/testkit/fixtures/transcriptFixtures');
    const { installImageAnnotationCanvasBoundary } =
      await import('@/dev/testkit/mocks/imageAnnotationCanvas');
    await (
      await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')
    ).prepareSessionDraftPersistenceStorage();
    const { writeExistingSessionDraft } =
      await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const {
      readSessionAttachmentDrafts,
      resolveSessionAttachmentDraftScope,
      clearSessionAttachmentDrafts,
    } =
      await import('@/components/sessions/attachments/sessionAttachmentDraftStore');
    const scope = {
      serverId: harness.scope.serverId,
      accountId: 'workspace-download-account',
    };
    const destination = { ...scope, sessionId: 'annotation-destination' };
    const originalState = storage.getState();
    storage.getState().activateProfileScope(scope);
    storage.getState().activateSessionLocalStateScope(scope);
    const media = SessionMediaItemV1Schema.parse({
      id: 'source-video',
      mediaKind: 'video',
      name: 'checkout-1440.mp4',
      path: '.happier/media/clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4,
      category: 'attachment',
      role: 'input',
      origin: { source: 'user-upload' },
    });
    const transcript = createSessionMessagesFixture({
      isLoaded: true,
      messageIdsOldestFirst: ['message'],
      messagesById: {
        message: {
          kind: 'user-text',
          id: 'message',
          localId: null,
          createdAt: 1,
          text: 'Original message',
          meta: {
            happier: { kind: 'session_media.v1', payload: { media: [media] } },
          },
        },
      },
    });
    storage.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        'annotation-source': createSessionFixture({
          id: 'annotation-source',
          serverId: scope.serverId,
          metadata: {
            path: '/repo',
            host: 'test.local',
            machineId: harness!.scope.machineId,
          },
        }),
        [destination.sessionId]: createSessionFixture({
          id: destination.sessionId,
          serverId: scope.serverId,
        }),
      },
      sessionMessages: {
        ...state.sessionMessages,
        'annotation-source': transcript,
      },
    }));
    writeExistingSessionDraft({
      scope,
      sessionId: destination.sessionId,
      patch: { text: '' },
    });
    installImageAnnotationCanvasBoundary();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    );
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: () => 'blob:annotation-source',
        revokeObjectURL: revoke,
      }),
    );
    try {
      const outcome = await createDefaultActionExecutor().execute(
        'media.annotation.apply',
        {
          scope,
          target: {
            kind: 'sessionVideoFrame',
            sessionId: 'annotation-source',
            mediaId: 'source-video',
            timeMs: 18_000,
          },
          into: { sessionId: destination.sessionId },
          operations: [
            {
              kind: 'mark.add',
              mark: {
                id: 'pay',
                kind: 'step',
                at: { x: 1, y: 2 },
                color: 'red',
                size: 's',
                note: 'Pay slides over the card edge',
              },
            },
            {
              kind: 'mark.add',
              mark: {
                id: 'total',
                kind: 'step',
                at: { x: 3, y: 2 },
                color: 'red',
                size: 's',
              },
            },
          ],
        },
        {
          surface: 'ui',
          authority: 'present_user',
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
        },
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: true,
        result: { status: 'appended', imageNumber: 1 },
      });
      expect(
        nativeFiles.skia!.videos,
        'The platform decoder reads the addressed time and is released',
      ).toEqual([
        expect.objectContaining({
          uri: 'blob:annotation-source',
          seeks: [18_000],
          disposed: true,
        }),
      ]);
      expect(revoke).toHaveBeenCalledWith('blob:annotation-source');
      expect(
        readSessionAttachmentDrafts(
          resolveSessionAttachmentDraftScope(destination),
        ),
      ).toHaveLength(1);
      const { readComposerPresentationSnapshot } =
        await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
      expect(
        readComposerPresentationSnapshot({
          kind: 'session',
          sessionId: destination.sessionId,
        })?.text,
      ).toContain(
        '0:18\nNumbered marks:\n1. Pay slides over the card edge\n2. (no note)',
      );
      expect(storage.getState().sessionMessages['annotation-source']).toBe(
        transcript,
      );
    } finally {
      clearSessionAttachmentDrafts(
        resolveSessionAttachmentDraftScope(destination),
      );
      storage.setState(originalState, true);
    }
  });
});
