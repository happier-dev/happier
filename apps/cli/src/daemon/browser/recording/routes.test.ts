import type {
  BrowserEvidenceSessionMediaReferenceV1,
  BrowserRecordingCapabilities,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const recordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: ['simulatorPreview'],
  maxFps: 12,
  audioSupported: false,
  cursorOverlaySupported: true,
  actionTimelineChaptersSupported: true,
  supportedRetentionClasses: ['preSend', 'attached'],
  disabledReasons: [],
  policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const mediaRef = {
  refKind: 'sessionMedia',
  mediaId: 'media_recording_1',
  mediaKind: 'video',
  mimeType: 'video/webm',
  sizeBytes: 800_000,
} satisfies BrowserEvidenceSessionMediaReferenceV1;

const recordingArtifactSource = {
  kind: 'local-file',
  path: '/tmp/happier-browser-recording.webm',
  mimeType: 'video/webm',
  fileNameHint: 'recording.webm',
} as const;

function createStartInput(viewId = 'view_1') {
  return {
    browserSessionId: 'browser_session_1',
    viewId,
    profileId: 'profile_1',
    targetKind: 'simulatorPreview' as const,
    adapterKind: 'simulatorPreview' as const,
    renderEngineKind: 'streamedSurface' as const,
    captureKind: 'streamFrameCapture' as const,
    fidelity: 'streamFrame' as const,
    navigationGeneration: 7,
    mimeType: 'video/webm',
    retentionClass: 'preSend' as const,
    captureSource: {
      kind: 'machineLiveStream' as const,
      streamFamily: 'simulator.preview',
      sourceId: 'source_1',
    },
  };
}

describe('browser recording daemon routes', () => {
  it.each(['capture', 'persistence'] as const)('carries %s failure and invocation identity through the strict Stop reader and replay', async phase => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const { createBrowserRecordingRoutes } = await import('./routes');
    const { createBrowserRecordingActionRoutes } = await import('./actionRoutes');
    const service = createBrowserRecordingDaemonService({ now: () => 10_000,
      captureAdapters: [{ captureKind: 'streamFrameCapture', start: async () => ({ status: 'started' }),
        stop: async () => {
          if (phase === 'capture') throw Object.assign(new Error('private external detail'), { code: 'EPIPE' });
          return { durationMs: 1_000, byteSize: 800_000, frameCount: 12, fps: 12, mimeType: 'video/webm',
            source: recordingArtifactSource, cleanup: async () => { throw new Error('cleanup failed'); } };
        }, discard: async () => {} }],
      mediaWriter: { persistRecording: async () => { throw Object.assign(new Error('private external detail'), { code: 'EPIPE' }); }, discardRecording: async () => {} },
    });
    const routes = createBrowserRecordingRoutes({ service, resolveStartContext: () => ({ browserRecordingEnabled: true, recordingCapabilities }) });
    const started = await routes.startRecording(createStartInput());
    if (started.status !== 'started') throw new Error('Expected started');
    const actions = createBrowserRecordingActionRoutes({ routes });
    const request = { recordingId: started.recording.recordingId, navigationGenerationEnd: 7 };
    const stopped = await actions.dispatch('browser.recording.stop', request, { actionRequestId: 'actual-stop' });
    expect(stopped).toMatchObject({ status: 'failed', requestId: 'actual-stop',
      failureCause: { phase: phase === 'capture' ? 'recording.capture_stop' : 'recording.media_persistence', errorCode: 'EPIPE' } });
    expect(JSON.stringify(stopped)).not.toContain('private external detail');
    expect(await actions.dispatch('browser.recording.stop', request, { actionRequestId: 'replay-stop' })).toEqual(stopped);
  });

  it('resolves daemon recording context before starting and exposes status/list/stop through protocol-safe envelopes', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const { createBrowserRecordingRoutes } = await import('./routes');
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 2_000,
        byteSize: 800_000,
        frameCount: 24,
        fps: 12,
        mimeType: 'video/webm',
        source: recordingArtifactSource,
      })),
      discard: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });
    const resolveStartContext = vi.fn(async () => ({
      browserRecordingEnabled: true,
      recordingCapabilities,
    }));
    const routes = createBrowserRecordingRoutes({
      service,
      resolveStartContext,
      now: () => 20_000,
    });

    const started = await routes.startRecording(createStartInput());

    expect(resolveStartContext).toHaveBeenCalledWith(createStartInput());
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    expect(started.recording).toMatchObject({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      status: 'recording',
    });
    expect('mediaRef' in started.recording).toBe(false);

    expect(await routes.getRecordingStatus({ recordingId: started.recording.recordingId })).toMatchObject({
      recordingId: started.recording.recordingId,
      status: 'recording',
    });
    expect(await routes.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toHaveLength(1);

    const stopped = await routes.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 20_000,
    });

    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;
    expect(stopped.recording).toMatchObject({
      recordingId: started.recording.recordingId,
      status: 'finalized',
      mediaRef: { mediaId: 'media_recording_1' },
    });
  });

  it('fails closed when daemon context disables browser recording before capture starts', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const { createBrowserRecordingRoutes } = await import('./routes');
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => {
        throw new Error('unexpected stop');
      }),
      discard: vi.fn(async () => {}),
    };
    const routes = createBrowserRecordingRoutes({
      service: createBrowserRecordingDaemonService({
        captureAdapters: [captureAdapter],
        mediaWriter: {
          persistRecording: vi.fn(async () => mediaRef),
          discardRecording: vi.fn(async () => {}),
        },
      }),
      resolveStartContext: vi.fn(async () => ({
        browserRecordingEnabled: false,
        recordingCapabilities,
      })),
    });

    const started = await routes.startRecording(createStartInput('view_disabled'));

    expect(started).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_disabled' },
    });
    expect(captureAdapter.start).not.toHaveBeenCalled();
  });

  it('uses daemon time for retention cleanup when callers omit nowMs', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const { createBrowserRecordingRoutes } = await import('./routes');
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      // The media boundary checks admission immediately before its destructive effect.
      discardRecording: vi.fn(async ({ beforeEffect }: { beforeEffect?: () => Promise<void> }) => {
        await beforeEffect?.();
      }),
    };
    const routes = createBrowserRecordingRoutes({
      service: createBrowserRecordingDaemonService({
        captureAdapters: [{
          captureKind: 'streamFrameCapture' as const,
          start: vi.fn(async () => ({ status: 'started' as const })),
          stop: vi.fn(async () => ({
            durationMs: 2_000,
            byteSize: 800_000,
            frameCount: 24,
            fps: 12,
            mimeType: 'video/webm',
            source: recordingArtifactSource,
          })),
          discard: vi.fn(async () => {}),
        }],
        mediaWriter,
        now: () => 10_000,
      }),
      resolveStartContext: vi.fn(async () => ({
        browserRecordingEnabled: true,
        recordingCapabilities,
      })),
      now: () => 13_001,
    });
    const started = await routes.startRecording(createStartInput('view_expiring'));
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    await routes.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 13_000,
    });

    const denied = new Error('maintenance admission withdrawn');
    await expect(routes.cleanupExpiredRecordings({}, {
      beforeEffect: async () => { throw denied; },
    })).resolves.toEqual({
      discardedRecordingIds: [],
      failedRecordingIds: [started.recording.recordingId],
    });
    expect(await routes.getRecordingStatus({ recordingId: started.recording.recordingId })).toMatchObject({
      status: 'finalized',
    });

    await expect(Reflect.apply(routes.cleanupExpiredRecordings, undefined, [{ beforeEffect: async () => {} }]))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'unrecognized_keys', path: [], keys: ['beforeEffect'] })]) });

    const cleanup = await routes.cleanupExpiredRecordings({});

    expect(cleanup).toEqual({
      discardedRecordingIds: [started.recording.recordingId],
      failedRecordingIds: [],
    });
    expect(mediaWriter.discardRecording).toHaveBeenCalledWith(expect.objectContaining({
      recording: expect.objectContaining({ recordingId: started.recording.recordingId }),
      reason: 'retention_limit',
    }));
  });
});
