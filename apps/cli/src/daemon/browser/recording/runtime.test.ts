import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BrowserRecordingCapabilities } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const webmBytes = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]),
  Buffer.from('browser recording runtime bytes', 'utf8'),
]);

const recordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: ['simulatorPreview'],
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: true,
  actionTimelineChaptersSupported: true,
  supportedRetentionClasses: ['preSend'],
  disabledReasons: [],
  policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

function createStartInput() {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'simulatorPreview' as const,
    adapterKind: 'simulatorPreview' as const,
    renderEngineKind: 'streamedSurface' as const,
    captureKind: 'streamFrameCapture' as const,
    fidelity: 'streamFrame' as const,
    navigationGeneration: 7,
    mimeType: 'video/webm',
    retentionClass: 'preSend' as const,
  };
}

describe('browser recording daemon runtime', () => {
  it('keeps start fail-closed when capture adapters exist without durable media target policy', async () => {
    const { createBrowserRecordingDaemonRuntime } = await import('./runtime');
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => {
        throw new Error('unexpected stop');
      }),
      discard: vi.fn(async () => {}),
    };
    const runtime = createBrowserRecordingDaemonRuntime({
      workingDirectory: '/tmp/happier-browser-recording-runtime-test',
      captureAdapters: [captureAdapter],
      resolveStartContext: vi.fn(async () => ({
        browserRecordingEnabled: true,
        recordingCapabilities,
      })),
    });

    try {
      await expect(runtime.routes.startRecording(createStartInput())).resolves.toMatchObject({
        status: 'unavailable',
        reason: {
          code: 'browser_recording_disabled',
        },
      });
      expect(captureAdapter.start).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
    }
  });

  it('keeps PMS stream capture latent when no recording start-context resolver enables it', async () => {
    const [
      { createBrowserRecordingDaemonRuntime },
      { createMachineLiveStreamCaptureRegistry },
    ] = await Promise.all([
      import('./runtime'),
      import('../../peer/mediation/stream/captureRegistry'),
    ]);
    const sourceStart = vi.fn(async () => ({ ok: true as const, session: { stop: vi.fn(async () => {}) } }));
    const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
    liveStreamCaptureRegistry.register({
      sourceId: 'source_1',
      streamFamily: 'simulator.preview',
      capabilities: {
        v: 1,
        sourceId: 'source_1',
        sourceKind: 'simulator',
        supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 30,
        inputMode: 'none',
        sidebands: [],
        health: { status: 'available' },
      },
      adapter: { start: sourceStart },
    });
    const runtime = createBrowserRecordingDaemonRuntime({
      workingDirectory: '/tmp/happier-browser-recording-runtime-test',
      liveStreamCaptureRegistry,
      streamFrameEncoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard: vi.fn(async () => {}),
      }),
    });

    try {
      await expect(runtime.routes.startRecording({
        ...createStartInput(),
        mediaTarget: {
          sessionId: 'session_1',
          messageLocalId: 'message_1',
        },
        captureSource: {
          kind: 'machineLiveStream',
          streamFamily: 'simulator.preview',
          sourceId: 'source_1',
        },
      })).resolves.toMatchObject({
        status: 'unavailable',
        reason: {
          code: 'browser_recording_disabled',
        },
      });
      expect(sourceStart).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
    }
  });

  it('wires a PMS machine-live-stream adapter through the runtime when explicit policy and targets are supplied', async () => {
    const [
      { createBrowserRecordingDaemonRuntime },
      { createMachineLiveStreamCaptureRegistry },
    ] = await Promise.all([
      import('./runtime'),
      import('../../peer/mediation/stream/captureRegistry'),
    ]);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-runtime-pms-'));
    const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-runtime-pms-capture-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const outputPath = join(captureDirectory, 'recording.webm');
      const encodedFrames: Buffer[] = [];
      let offerFailure: string | null = null;
      const sourceStop = vi.fn(async () => {});
      const sourceStart = vi.fn(async (input: {
        streamId: string;
        offerFrame: (frame: {
          v: 1;
          streamId: string;
          sequence: number;
          timestampMs: number;
          payloadKind: 'image_keyframe';
          payloadEncoding: 'binary_base64';
          payloadBase64: string;
          payloadSizeBytes: number;
        }) => Readonly<{ ok: true } | { ok: false; reasonCode: string }>;
      }) => {
        const payload = Buffer.from('runtime-pms-frame');
        const offered = input.offerFrame({
          v: 1,
          streamId: input.streamId,
          sequence: 1,
          timestampMs: 10_000,
          payloadKind: 'image_keyframe',
          payloadEncoding: 'binary_base64',
          payloadBase64: payload.toString('base64'),
          payloadSizeBytes: payload.byteLength,
        });
        if (!offered.ok) {
          offerFailure = offered.reasonCode;
          throw new Error(`Expected PMS frame to be accepted, got ${offered.reasonCode}.`);
        }
        return { ok: true as const, session: { stop: sourceStop } };
      });
      const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
      liveStreamCaptureRegistry.register({
        sourceId: 'source_1',
        streamFamily: 'simulator.preview',
        capabilities: {
          v: 1,
          sourceId: 'source_1',
          sourceKind: 'simulator',
          supportedCodecs: ['image.mjpeg'],
          maxFramesPerSecond: 30,
          inputMode: 'none',
          sidebands: [],
          health: { status: 'available' },
        },
        adapter: { start: sourceStart },
      });

      const runtime = createBrowserRecordingDaemonRuntime({
        workingDirectory,
        liveStreamCaptureRegistry,
        streamFrameEncoderFactory: async () => ({
          appendFrame: (input) => {
            encodedFrames.push(input.payload);
          },
          finish: async () => {
            if (encodedFrames.length !== 1 || !encodedFrames[0]?.equals(Buffer.from('runtime-pms-frame'))) {
              throw new Error('Expected PMS frame payload to reach the encoder.');
            }
            const output = webmBytes;
            await writeFile(outputPath, output);
            return {
              source: {
                kind: 'local-file' as const,
                path: outputPath,
                mimeType: 'video/webm',
                fileNameHint: 'recording.webm',
              },
              byteSize: output.byteLength,
              cleanup: async () => {
                await rm(outputPath, { force: true });
              },
            };
          },
          discard: vi.fn(async () => {}),
        }),
        resolveStartContext: vi.fn(async () => ({
          browserRecordingEnabled: true,
          recordingCapabilities,
        })),
        now: () => 10_000,
      });

      try {
        const started = await runtime.routes.startRecording({
          ...createStartInput(),
          mediaTarget: {
            sessionId: 'session_pms',
            messageLocalId: 'message_pms',
          },
          captureSource: {
            kind: 'machineLiveStream',
            streamFamily: 'simulator.preview',
            sourceId: 'source_1',
          },
        });
        expect(offerFailure).toBe(null);
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;
        expect(sourceStart).toHaveBeenCalledTimes(1);

        const stopped = await runtime.routes.stopRecording({
          recordingId: started.recording.recordingId,
          stoppedAtMs: 12_000,
          navigationGenerationEnd: 8,
        });

        expect(sourceStop).toHaveBeenCalledTimes(1);
        expect(stopped.status).toBe('finalized');
        if (stopped.status !== 'finalized') return;
        expect(stopped.recording.mediaRef).toMatchObject({
          refKind: 'sessionMedia',
          mediaKind: 'video',
          mimeType: 'video/webm',
          sizeBytes: webmBytes.byteLength,
        });
        const mediaRef = stopped.recording.mediaRef;
        if (!mediaRef) return;
        const persistedFile = resolve(
          workingDirectory,
          '.happier',
          'uploads',
          'artifacts',
          'session_pms',
          'message_pms',
          `${mediaRef.mediaId.slice(0, 12)}-recording.webm`,
        );
        await expect(readFile(persistedFile)).resolves.toEqual(webmBytes);
        await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        runtime.stop();
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  });

  it('flips recording on via the production stream-frame start-context resolver', async () => {
    const [
      { createBrowserRecordingDaemonRuntime },
      { resolveBrowserRecordingStreamFrameStartContext },
    ] = await Promise.all([
      import('./runtime'),
      import('./startContext'),
    ]);
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => {
        throw new Error('unexpected stop');
      }),
      discard: vi.fn(async () => {}),
    };
    const runtime = createBrowserRecordingDaemonRuntime({
      workingDirectory: '/tmp/happier-browser-recording-runtime-prod-resolver',
      captureAdapters: [captureAdapter],
      resolveSessionMediaTarget: () => ({ sessionId: 'session_1', messageLocalId: 'message_1' }),
      resolveStartContext: resolveBrowserRecordingStreamFrameStartContext({
        hasLiveStreamCaptureRegistry: true,
      }),
    });

    try {
      const result = await runtime.routes.startRecording({
        ...createStartInput(),
        captureSource: {
          kind: 'machineLiveStream',
          streamFamily: 'simulator.preview',
          sourceId: 'source_1',
        },
      });
      // Must no longer be browser_recording_disabled / STARTUP_DISABLED.
      expect(result.status).toBe('started');
      expect(captureAdapter.start).toHaveBeenCalledTimes(1);
    } finally {
      runtime.stop();
    }
  });

  // BA-7 producer-mapping closure (daemon half of the engine×capability matrix). Each BUILD-NOW
  // capture kind MUST map to a live producer when its dependency is bound, and stay honestly
  // fail-closed (`browser_recording_capture_adapter_missing`) when absent — never silently dark.
  describe('producer matrix (BA-7)', () => {
    const cdpScreencastCapabilities = {
      ...recordingCapabilities,
      supportedCaptureKinds: ['cdpScreencast'],
      supportedAdapterKinds: ['chromiumSidecar'],
    } satisfies BrowserRecordingCapabilities;

    function createCdpScreencastStartInput() {
      return {
        ...createStartInput(),
        adapterKind: 'chromiumSidecar' as const,
        renderEngineKind: 'unavailable' as const,
        captureKind: 'cdpScreencast' as const,
        fidelity: 'streamFrame' as const,
        mediaTarget: { sessionId: 'session_cdp', messageLocalId: 'message_cdp' },
      };
    }

    it('maps the cdpScreencast BUILD-NOW cell to a live producer when a CDP screencast transport is bound', async () => {
      const { createBrowserRecordingDaemonRuntime } = await import('./runtime');
      const transportStart = vi.fn(async () => ({ ackFrame: vi.fn(), stop: vi.fn(async () => {}) }));
      const runtime = createBrowserRecordingDaemonRuntime({
        workingDirectory: '/tmp/happier-browser-recording-cdp-matrix',
        cdpScreencast: { transport: { start: transportStart } },
        streamFrameEncoderFactory: async () => ({
          appendFrame: vi.fn(),
          finish: vi.fn(async () => {
            throw new Error('unexpected finish');
          }),
          discard: vi.fn(async () => {}),
        }),
        resolveSessionMediaTarget: () => ({ sessionId: 'session_cdp', messageLocalId: 'message_cdp' }),
        resolveStartContext: vi.fn(async () => ({
          browserRecordingEnabled: true,
          recordingCapabilities: cdpScreencastCapabilities,
        })),
      });

      try {
        const result = await runtime.routes.startRecording(createCdpScreencastStartInput());
        expect(result.status).toBe('started');
        expect(transportStart).toHaveBeenCalledTimes(1);
      } finally {
        runtime.stop();
      }
    });

    it('stays fail-closed with adapter_missing when the cdpScreencast producer is not bound', async () => {
      const { createBrowserRecordingDaemonRuntime } = await import('./runtime');
      const runtime = createBrowserRecordingDaemonRuntime({
        workingDirectory: '/tmp/happier-browser-recording-cdp-matrix-absent',
        resolveSessionMediaTarget: () => ({ sessionId: 'session_cdp', messageLocalId: 'message_cdp' }),
        resolveStartContext: vi.fn(async () => ({
          browserRecordingEnabled: true,
          recordingCapabilities: cdpScreencastCapabilities,
        })),
      });

      try {
        await expect(runtime.routes.startRecording(createCdpScreencastStartInput())).resolves.toMatchObject({
          status: 'unavailable',
          reason: { code: 'browser_recording_capture_adapter_missing' },
        });
      } finally {
        runtime.stop();
      }
    });

    it('maps the nativeViewCapture BUILD-NOW cell to a live producer when a native capture command is bound', async () => {
      const { createBrowserRecordingDaemonRuntime } = await import('./runtime');
      const captureCommand = vi.fn(async () => ({
        ok: true as const,
        source: {
          kind: 'local-file' as const,
          path: '/tmp/native-view.png',
          mimeType: 'image/png',
          fileNameHint: 'native-view.png',
        },
        byteSize: 2_048,
      }));
      const runtime = createBrowserRecordingDaemonRuntime({
        workingDirectory: '/tmp/happier-browser-recording-native-matrix',
        nativeViewCapture: {
          isPlatformCaptureSupported: () => true,
          captureCommand,
        },
        resolveSessionMediaTarget: () => ({ sessionId: 'session_native', messageLocalId: 'message_native' }),
        resolveStartContext: vi.fn(async () => ({
          browserRecordingEnabled: true,
          recordingCapabilities: {
            ...recordingCapabilities,
            supportedCaptureKinds: ['nativeViewCapture'],
            supportedAdapterKinds: ['externalUrl'],
            supportedMimeTypes: ['image/png'],
          } satisfies BrowserRecordingCapabilities,
          captureSourceAvailable: true,
        })),
      });

      try {
        const result = await runtime.routes.startRecording({
          ...createStartInput(),
          adapterKind: 'externalUrl' as const,
          renderEngineKind: 'desktopWebView',
          targetKind: 'externalUrl' as const,
          captureKind: 'nativeViewCapture' as const,
          mimeType: 'image/png',
          mediaTarget: { sessionId: 'session_native', messageLocalId: 'message_native' },
        });
        expect(result.status).toBe('started');
        expect(captureCommand).toHaveBeenCalledTimes(1);
      } finally {
        runtime.stop();
      }
    });

    it('produces durable desktop session-media via the native-view capture command + transport (BA-4/BA-7)', async () => {
      const [
        { createBrowserRecordingDaemonRuntime },
        { createBrowserRecordingNativeViewCaptureCommand },
      ] = await Promise.all([
        import('./runtime'),
        import('./adapters/nativeViewCommand'),
      ]);
      const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-native-durable-'));
      const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-native-durable-capture-'));

      try {
        await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
        const pngBytes = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('native-view-recording-frame', 'utf8'),
        ]);
        const capturePath = join(captureDirectory, 'native-frame.png');

        // The desktop-host transport (daemon->native IPC boundary) writes a reference-only PNG file
        // and returns its path + metadata — exactly the contract the real Tauri command satisfies.
        const transport = {
          captureFrame: vi.fn(async () => {
            await writeFile(capturePath, pngBytes);
            return {
              ok: true as const,
              path: capturePath,
              mimeType: 'image/png',
              byteSize: pngBytes.byteLength,
              width: 1024,
              height: 768,
              cleanup: async () => {
                await rm(capturePath, { force: true });
              },
            };
          }),
        };
        const captureCommand = createBrowserRecordingNativeViewCaptureCommand({ transport });

        const runtime = createBrowserRecordingDaemonRuntime({
          workingDirectory,
          nativeViewCapture: {
            isPlatformCaptureSupported: () => true,
            captureCommand,
          },
          resolveSessionMediaTarget: () => ({ sessionId: 'session_native', messageLocalId: 'message_native' }),
          resolveStartContext: vi.fn(async () => ({
            browserRecordingEnabled: true,
            recordingCapabilities: {
              ...recordingCapabilities,
              supportedCaptureKinds: ['nativeViewCapture'],
              supportedAdapterKinds: ['externalUrl'],
              supportedMimeTypes: ['image/png'],
            } satisfies BrowserRecordingCapabilities,
            captureSourceAvailable: true,
          })),
          now: () => 20_000,
        });

        try {
          const started = await runtime.routes.startRecording({
            ...createStartInput(),
            adapterKind: 'externalUrl' as const,
          renderEngineKind: 'desktopWebView',
            captureKind: 'nativeViewCapture' as const,
            mimeType: 'image/png',
            mediaTarget: { sessionId: 'session_native', messageLocalId: 'message_native' },
          });
          expect(started.status).toBe('started');
          if (started.status !== 'started') return;
          expect(transport.captureFrame).toHaveBeenCalledTimes(1);

          const stopped = await runtime.routes.stopRecording({
            recordingId: started.recording.recordingId,
            stoppedAtMs: 22_000,
            navigationGenerationEnd: 8,
          });

          // NOT browser_recording_capture_adapter_missing — a real durable artifact persisted.
          expect(stopped.status).toBe('finalized');
          if (stopped.status !== 'finalized') return;
          expect(stopped.recording.mediaRef).toMatchObject({
            refKind: 'sessionMedia',
            mediaKind: 'image',
            mimeType: 'image/png',
            sizeBytes: pngBytes.byteLength,
          });
          const mediaRef = stopped.recording.mediaRef;
          if (!mediaRef) return;
          const persistedFile = resolve(
            workingDirectory,
            '.happier',
            'uploads',
            'artifacts',
            'session_native',
            'message_native',
            `${mediaRef.mediaId.slice(0, 12)}-native-view-recording.png`,
          );
          await expect(readFile(persistedFile)).resolves.toEqual(pngBytes);
          // Reference-only source file released after ingestion.
          await expect(readFile(capturePath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          runtime.stop();
        }
      } finally {
        await rm(workingDirectory, { recursive: true, force: true });
        await rm(captureDirectory, { recursive: true, force: true });
      }
    });
  });

  it('uses command media targets to persist finalized recordings through session media', async () => {
    const { createBrowserRecordingDaemonRuntime } = await import('./runtime');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-runtime-'));
    const captureDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-recording-runtime-capture-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const sourcePath = join(captureDirectory, 'recording.webm');
      await writeFile(sourcePath, webmBytes);
      const captureAdapter = {
        captureKind: 'streamFrameCapture' as const,
        start: vi.fn(async () => ({ status: 'started' as const })),
        stop: vi.fn(async () => ({
          durationMs: 2_000,
          byteSize: webmBytes.byteLength,
          frameCount: 24,
          fps: 12,
          mimeType: 'video/webm',
          source: {
            kind: 'local-file' as const,
            path: sourcePath,
            mimeType: 'video/webm',
            fileNameHint: 'recording.webm',
          },
        })),
        discard: vi.fn(async () => {}),
      };
      const runtime = createBrowserRecordingDaemonRuntime({
        workingDirectory,
        captureAdapters: [captureAdapter],
        resolveStartContext: vi.fn(async () => ({
          browserRecordingEnabled: true,
          recordingCapabilities,
        })),
        now: () => 10_000,
      });

      try {
        const started = await runtime.routes.startRecording({
          ...createStartInput(),
          mediaTarget: {
            sessionId: 'session_1',
            messageLocalId: 'message_1',
          },
          captureSource: {
            kind: 'machineLiveStream',
            streamFamily: 'simulator.preview',
            sourceId: 'source_1',
          },
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;
        expect(captureAdapter.start).toHaveBeenCalledWith(expect.objectContaining({
          captureSource: {
            kind: 'machineLiveStream',
            streamFamily: 'simulator.preview',
            sourceId: 'source_1',
          },
        }));

        const stopped = await runtime.routes.stopRecording({
          recordingId: started.recording.recordingId,
          stoppedAtMs: 12_000,
          navigationGenerationEnd: 8,
          expiresAtMs: 12_000,
        });

        expect(stopped.status).toBe('finalized');
        if (stopped.status !== 'finalized') return;
        expect(stopped.recording.mediaRef).toMatchObject({
          refKind: 'sessionMedia',
          mediaKind: 'video',
          mimeType: 'video/webm',
          sizeBytes: webmBytes.byteLength,
        });
        const mediaRef = stopped.recording.mediaRef;
        if (!mediaRef) return;
        const mediaId = mediaRef.mediaId;
        const persistedFile = resolve(
          workingDirectory,
          '.happier',
          'uploads',
          'artifacts',
          'session_1',
          'message_1',
          `${mediaId.slice(0, 12)}-recording.webm`,
        );
        await expect(readFile(persistedFile)).resolves.toEqual(webmBytes);

        const cleanup = await runtime.routes.cleanupExpiredRecordings({ nowMs: 12_001 });

        expect(cleanup).toEqual({
          discardedRecordingIds: [started.recording.recordingId],
          failedRecordingIds: [],
        });
        await expect(readFile(persistedFile)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        runtime.stop();
      }
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  });
});
