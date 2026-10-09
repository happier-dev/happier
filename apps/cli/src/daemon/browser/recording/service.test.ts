import type {
  BrowserEvidenceSessionMediaReferenceV1,
  BrowserRecordingCapabilities,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createSurfaceInputControl } from '../../surfaces/inputControl';
import type { BrowserRecordingRuntimeStartInput } from './service';
import { createDeferred } from '@/testkit/async/deferred';

const recordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: ['streamedBrowserSurface'],
  maxDurationMs: 30_000,
  maxBytes: 16_000_000,
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

const streamCaptureSource = {
  kind: 'machineLiveStream',
  streamFamily: 'browser.streamed',
  sourceId: 'stream_1',
  targetMachineId: 'machine_1',
} as const;

const broadRecordingCapabilities = {
  ...recordingCapabilities,
  supportedCaptureKinds: ['nativeViewCapture', 'cdpScreencast', 'streamFrameCapture'],
  supportedMimeTypes: ['image/png', 'video/webm'],
  supportedAdapterKinds: ['externalUrl', 'chromiumSidecar', 'streamedBrowserSurface', 'simulatorPreview'],
} satisfies BrowserRecordingCapabilities;

describe('browser recording daemon service', () => {
  const confidentialStartInput = {
    browserRecordingEnabled: true,
    recordingCapabilities,
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'streamedBrowser',
    adapterKind: 'streamedBrowserSurface',
    renderEngineKind: 'streamedSurface',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    navigationGeneration: 7,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    captureSource: streamCaptureSource,
  } satisfies BrowserRecordingRuntimeStartInput;

  it('refuses recording a held view before starting capture', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    await control.beginConfidentialityHold();
    const start = vi.fn(async () => ({ status: 'started' as const }));
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [{ captureKind: 'streamFrameCapture', start, stop: async () => { throw new Error('unused'); }, discard: async () => {} }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
      resolveInputControl: () => control,
    });

    expect(await service.startRecording(confidentialStartInput)).toMatchObject({
      status: 'unavailable', reason: { code: 'browser_recording_policy_denied' },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['starting', 'stopping', 'stopping_error', 'persisting'] as const)('drains %s capture before confidential materialization and suppresses its output', async (phase) => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const deferred = createDeferred<void>();
    const entered = createDeferred<void>();
    const cleanup = vi.fn(async () => {});
    const discard = vi.fn(async () => {});
    const discardRecording = vi.fn(async () => {});
    const persistRecording = vi.fn(async () => {
      if (phase === 'persisting') { entered.resolve(); await deferred.promise; }
      return mediaRef;
    });
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: () => control,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        async start() {
          if (phase === 'starting') { entered.resolve(); await deferred.promise; }
          return { status: 'started' };
        },
        async stop() {
          if (phase === 'stopping' || phase === 'stopping_error') { entered.resolve(); await deferred.promise; }
          if (phase === 'stopping_error') throw new Error('D26-recording-fixture-secret');
          return { durationMs: 100, byteSize: 20, frameCount: 1, fps: 1, mimeType: 'video/webm', source: recordingArtifactSource, cleanup };
        },
        discard,
      }],
      mediaWriter: { persistRecording, discardRecording },
    });
    const started = service.startRecording(confidentialStartInput);
    const operation = phase === 'starting' ? started : (async () => {
      const result = await started;
      if (result.status !== 'started') throw new Error('recording did not start');
      return service.stopRecording({ recordingId: result.recording.recordingId, navigationGenerationEnd: 7 });
    })();
    await entered.promise;
    let drained = false;
    const hold = control.beginConfidentialityHold().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    deferred.resolve();
    const result = await operation;
    await hold;

    expect(discard).toHaveBeenCalled();
    if (phase === 'persisting') expect(discardRecording).toHaveBeenCalledWith(expect.objectContaining({ recording: expect.objectContaining({ mediaRef }) }));
    else expect(persistRecording).not.toHaveBeenCalled();
    if (phase === 'stopping' || phase === 'persisting') expect(cleanup).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('D26-recording-fixture-secret');
    expect(service.listRecordingsForView({ viewId: 'view_1' })).not.toContainEqual(expect.objectContaining({ status: 'recording' }));
    expect(service.listRecordingsForView({ viewId: 'view_1' })).not.toContainEqual(expect.objectContaining({ mediaRef }));
  });

  it('discards an active held view while an unrelated view keeps recording', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const safeControl = createSurfaceInputControl();
    const discardedViews: string[] = [];
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: ({ viewId }) => viewId === 'view_1' ? control : safeControl,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        start: async () => ({ status: 'started' }),
        stop: async () => { throw new Error('unused'); },
        discard: async ({ recording }) => { discardedViews.push(recording.viewId); },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    await service.startRecording(confidentialStartInput);
    await service.startRecording({ ...confidentialStartInput, viewId: 'safe_view' });
    await control.beginConfidentialityHold();

    expect(discardedViews).toEqual(['view_1']);
    expect(service.listRecordingsForView({ viewId: 'view_1' })[0]).toMatchObject({ status: 'failed', outcomeReason: 'policy_revoked' });
    expect(service.listRecordingsForView({ viewId: 'safe_view' })[0]).toMatchObject({ status: 'recording' });
  });

  it.each(['known', 'failed'] as const)('handles %s cleanup of a capture canceled during startup while confidentiality drains it', async (completion) => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let capturing = false;
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: () => control,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        async start() { entered.resolve(); await release.promise; capturing = true; return { status: 'started' }; },
        stop: async () => { throw new Error('unused'); },
        discard: async () => {
          if (capturing && completion === 'failed') throw new Error('capture shutdown failed');
          capturing = false;
        },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    const starting = service.startRecording({ ...confidentialStartInput, recordingId: 'canceled_start' });
    await entered.promise;
    await service.cancelRecording({ recordingId: 'canceled_start', reason: 'user_canceled' });
    const hold = control.beginConfidentialityHold().then(() => true, () => false);
    release.resolve();
    expect(await starting).toMatchObject({ status: 'unavailable' });
    expect(await hold).toBe(completion === 'known');
    expect(capturing).toBe(completion === 'failed');
  });

  it('refuses confidential delivery when the recording capture cannot be drained', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: () => control,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        start: async () => ({ status: 'started' }),
        stop: async () => { throw new Error('unused'); },
        discard: async () => { throw new Error('capture could not stop'); },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    await service.startRecording(confidentialStartInput);

    await expect(control.beginConfidentialityHold()).rejects.toThrow();
    expect(control.isObservationHeld()).toBe(true);
    expect(control.clearConfidentialityHold()).toBe(false);
  });

  it.each(['known', 'failed'] as const)('waits for %s cancellation instead of treating duplicate discard as drained', async (completion) => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let stopping = false;
    let capturing = true;
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: () => control,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        start: async () => ({ status: 'started' }),
        stop: async () => { throw new Error('unused'); },
        async discard() {
          // The capture boundary retires its handle before producer shutdown settles.
          if (stopping) return;
          stopping = true;
          entered.resolve();
          await release.promise;
          if (completion === 'failed') throw new Error('capture shutdown failed');
          capturing = false;
        },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    const start = await service.startRecording({ ...confidentialStartInput, recordingId: 'canceling_capture' });
    expect(start.status).toBe('started');
    const cancel = service.cancelRecording({ recordingId: 'canceling_capture', reason: 'user_canceled' });
    await entered.promise;
    let drained = false;
    const hold = control.beginConfidentialityHold().then(() => { drained = true; return true; }, () => false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const drainedBeforeStop = drained;
    release.resolve();
    await cancel;
    expect(await hold).toBe(completion === 'known');

    expect(drainedBeforeStop).toBe(false);
    expect(capturing).toBe(completion === 'failed');
  });

  it.each(['cancel', 'lifecycle'] as const)('keeps %s capture cleanup reachable after the input target closes', async (operation) => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    let capturing = true;
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: () => control,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        start: async () => ({ status: 'started' }),
        stop: async () => { throw new Error('unused'); },
        discard: async () => { capturing = false; },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    await service.startRecording({ ...confidentialStartInput, recordingId: 'closed_capture' });
    await control.close();
    if (operation === 'cancel') await service.cancelRecording({ recordingId: 'closed_capture', reason: 'user_canceled' });
    else await service.applyLifecycleOutcome({ browserSessionId: 'browser_session_1', viewId: 'view_1', reason: 'view_closed' });

    expect(capturing).toBe(false);
  });

  it('persists stopped recordings through the session-media writer and stores only a reference envelope', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const cleanup = vi.fn(async () => {});
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
        cleanup,
      })),
      discard: vi.fn(async () => {}),
    };
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });

    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 42_000,
    });

    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;
    expect(mediaWriter.persistRecording).toHaveBeenCalledWith(expect.objectContaining({
      recording: expect.objectContaining({ recordingId: started.recording.recordingId }),
      artifact: expect.objectContaining({ byteSize: 800_000, mimeType: 'video/webm' }),
    }));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(stopped.recording).toMatchObject({
      status: 'finalized',
      outcomeReason: 'user_stopped',
      mediaRef: { mediaId: 'media_recording_1' },
      retentionClass: 'preSend',
    });
    expect(JSON.stringify(stopped.recording)).not.toContain('base64');
    expect(JSON.stringify(stopped.recording)).not.toContain('temporary');
    expect(service.getRecordingStatus(started.recording.recordingId)?.mediaRef).toEqual(mediaRef);
  });

  it('rejects a reused finalized recording id without replacing the retained recording', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
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
    const startInput = {
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_reused_recording_id',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser' as const,
      adapterKind: 'streamedBrowserSurface' as const,
      renderEngineKind: 'streamedSurface' as const,
      captureKind: 'streamFrameCapture' as const,
      fidelity: 'streamFrame' as const,
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend' as const,
      captureSource: streamCaptureSource,
      recordingId: 'recording_reused',
      startedAtMs: 10_000,
    };

    const first = await service.startRecording(startInput);
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;
    const finalized = await service.stopRecording({
      recordingId: first.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
    });
    expect(finalized.status).toBe('finalized');
    if (finalized.status !== 'finalized') return;

    const reused = await service.startRecording({
      ...startInput,
      navigationGeneration: 9,
      startedAtMs: 20_000,
    });

    expect(reused).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_id_conflict' },
    });
    expect(captureAdapter.start).toHaveBeenCalledTimes(1);
    expect(service.getRecordingStatus('recording_reused')).toMatchObject({
      browserSessionId: 'browser_session_1',
      viewId: 'view_reused_recording_id',
      startedAtMs: 10_000,
      status: 'finalized',
      mediaRef,
    });
  });

  it('fails closed before capture when gates, capabilities, or adapters are unavailable', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const disabled = await service.startRecording({
      browserRecordingEnabled: false,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(disabled).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_disabled' },
    });

    const missingAdapter = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(missingAdapter).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_adapter_missing' },
    });
  });

  it('rejects impossible adapter/capture/mime cross-products before reaching a capture adapter', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const cdpAdapter = {
      captureKind: 'cdpScreencast' as const,
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
      captureAdapters: [cdpAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const result = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities: broadRecordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_invalid_profile',
      profileId: 'profile_1',
      targetKind: 'externalUrl',
      adapterKind: 'externalUrl',
      renderEngineKind: 'webIframe',
      captureKind: 'cdpScreencast',
      fidelity: 'cdp',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(cdpAdapter.start).not.toHaveBeenCalled();
  });

  it('rejects stream-frame starts without a capture source before reaching a capture adapter', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const streamAdapter = {
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
      captureAdapters: [streamAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const result = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_missing_source',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(streamAdapter.start).not.toHaveBeenCalled();
  });

  it('rejects native-view starts without handler-backed source truth before reaching a capture adapter', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const nativeAdapter = {
      captureKind: 'nativeViewCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 0,
        byteSize: 512,
        frameCount: 1,
        fps: 1,
        mimeType: 'image/png',
        source: { ...recordingArtifactSource, mimeType: 'image/png' },
      })),
      discard: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [nativeAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const result = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities: broadRecordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_missing_native_handler',
      profileId: 'profile_1',
      targetKind: 'externalUrl',
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureKind: 'nativeViewCapture',
      fidelity: 'nativeCallback',
      navigationGeneration: 7,
      mimeType: 'image/png',
      retentionClass: 'preSend',
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(nativeAdapter.start).not.toHaveBeenCalled();
  });

  it('accepts native-view starts when handler-backed source truth is present', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const nativeAdapter = {
      captureKind: 'nativeViewCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 0,
        byteSize: 512,
        frameCount: 1,
        fps: 1,
        mimeType: 'image/png',
        source: { ...recordingArtifactSource, mimeType: 'image/png' },
      })),
      discard: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [nativeAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const result = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities: broadRecordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_native_handler_present',
      profileId: 'profile_1',
      targetKind: 'externalUrl',
      adapterKind: 'externalUrl',
      renderEngineKind: 'desktopWebView',
      captureKind: 'nativeViewCapture',
      fidelity: 'nativeCallback',
      navigationGeneration: 7,
      mimeType: 'image/png',
      retentionClass: 'preSend',
      captureSourceAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'started',
      recording: { captureKind: 'nativeViewCapture' },
    });
    expect(nativeAdapter.start).toHaveBeenCalledTimes(1);
  });

  it('rejects native-view starts for non-desktop engines before reaching a capture adapter', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const nativeAdapter = {
      captureKind: 'nativeViewCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 0,
        byteSize: 512,
        frameCount: 1,
        fps: 1,
        mimeType: 'image/png',
        source: { ...recordingArtifactSource, mimeType: 'image/png' },
      })),
      discard: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [nativeAdapter],
      mediaWriter: {
        persistRecording: vi.fn(async () => mediaRef),
        discardRecording: vi.fn(async () => {}),
      },
      now: () => 10_000,
    });

    const result = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities: broadRecordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_missing_engine',
      profileId: 'profile_1',
      targetKind: 'externalUrl',
      adapterKind: 'externalUrl',
      renderEngineKind: 'webIframe',
      captureKind: 'nativeViewCapture',
      fidelity: 'nativeCallback',
      navigationGeneration: 7,
      mimeType: 'image/png',
      retentionClass: 'preSend',
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(nativeAdapter.start).not.toHaveBeenCalled();
  });

  it('rejects over-cap captured artifacts before media persistence', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const cleanup = vi.fn(async () => {});
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 2_000,
        byteSize: recordingCapabilities.maxBytes + 1,
        frameCount: 24,
        fps: 12,
        mimeType: 'video/webm',
        source: recordingArtifactSource,
        cleanup,
      })),
      discard: vi.fn(async () => {}),
    };
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });
    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_over_cap',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;

    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 7,
    });

    expect(stopped).toMatchObject({
      status: 'failed',
      reason: 'size_cap',
      recording: { status: 'failed', outcomeReason: 'size_cap', mediaRef: undefined },
    });
    expect(mediaWriter.persistRecording).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('discards temporary capture artifacts with explicit lifecycle outcomes on cancel and host loss', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => {
        throw new Error('unexpected stop');
      }),
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

    const cancelStart = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_cancel',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(cancelStart.status).toBe('started');
    if (cancelStart.status !== 'started') return;

    const canceled = await service.cancelRecording({
      recordingId: cancelStart.recording.recordingId,
      atMs: 11_000,
      reason: 'user_canceled',
    });
    expect(canceled).toMatchObject({
      status: 'canceled',
      recording: { status: 'canceled', outcomeReason: 'user_canceled', mediaRef: undefined },
    });

    const hostLossStart = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_host_lost',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 8,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(hostLossStart.status).toBe('started');
    if (hostLossStart.status !== 'started') return;

    const hostLost = await service.applyLifecycleOutcome({
      browserSessionId: 'browser_session_1',
      viewId: 'view_host_lost',
      atMs: 11_500,
      reason: 'host_lost',
    });

    expect(hostLost).toMatchObject({
      status: 'failed',
      recording: { status: 'failed', outcomeReason: 'host_lost', mediaRef: undefined },
    });
    expect(captureAdapter.discard).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: cancelStart.recording.recordingId,
      reason: 'user_canceled',
    }));
    expect(captureAdapter.discard).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: hostLossStart.recording.recordingId,
      reason: 'host_lost',
    }));
  });

  it('expires finalized recordings only after the session-media writer acknowledges durable discard', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
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
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });
    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_expire',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 13_000,
    });
    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;

    const cleanup = await service.cleanupExpiredRecordings({ nowMs: 13_001 });

    expect(mediaWriter.discardRecording).toHaveBeenCalledWith({
      recording: expect.objectContaining({
        recordingId: started.recording.recordingId,
        mediaRef,
      }),
      reason: 'retention_limit',
    });
    expect(cleanup).toEqual({
      discardedRecordingIds: [started.recording.recordingId],
      failedRecordingIds: [],
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).toMatchObject({
      status: 'discarded',
      outcomeReason: 'retention_limit',
      mediaRef: undefined,
    });
  });

  it('keeps finalized media references when durable discard fails during expiry cleanup', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
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
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {
        throw new Error('media cleanup failed');
      }),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });
    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_expire_failure',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 13_000,
    });
    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;

    const cleanup = await service.cleanupExpiredRecordings({ nowMs: 13_001 });

    expect(cleanup).toEqual({
      discardedRecordingIds: [],
      failedRecordingIds: [started.recording.recordingId],
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).toMatchObject({
      status: 'finalized',
      mediaRef,
    });
  });

  it('discards finalized stored media only after durable discard acknowledgement', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
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
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {}),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });
    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_discard_finalized',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 30_000,
    });
    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;

    const discarded = await service.cancelRecording({
      recordingId: started.recording.recordingId,
      atMs: 13_000,
      reason: 'user_discarded',
    });

    expect(mediaWriter.discardRecording).toHaveBeenCalledWith({
      recording: expect.objectContaining({
        recordingId: started.recording.recordingId,
        mediaRef,
      }),
      reason: 'user_discarded',
    });
    expect(discarded).toMatchObject({
      status: 'discarded',
      recording: {
        status: 'discarded',
        outcomeReason: 'user_discarded',
        mediaRef: undefined,
      },
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).toMatchObject({
      status: 'discarded',
      mediaRef: undefined,
    });
  });

  it('preserves finalized stored media when durable user discard fails', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
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
    const mediaWriter = {
      persistRecording: vi.fn(async () => mediaRef),
      discardRecording: vi.fn(async () => {
        throw new Error('durable discard failed');
      }),
    };
    const service = createBrowserRecordingDaemonService({
      captureAdapters: [captureAdapter],
      mediaWriter,
      now: () => 10_000,
    });
    const started = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_discard_finalized_failure',
      profileId: 'profile_1',
      targetKind: 'streamedBrowser',
      adapterKind: 'streamedBrowserSurface',
      renderEngineKind: 'streamedSurface',
      captureKind: 'streamFrameCapture',
      fidelity: 'streamFrame',
      navigationGeneration: 7,
      mimeType: 'video/webm',
      retentionClass: 'preSend',
      captureSource: streamCaptureSource,
    });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    const stopped = await service.stopRecording({
      recordingId: started.recording.recordingId,
      stoppedAtMs: 12_000,
      navigationGenerationEnd: 8,
      expiresAtMs: 30_000,
    });
    expect(stopped.status).toBe('finalized');
    if (stopped.status !== 'finalized') return;

    const discard = await service.cancelRecording({
      recordingId: started.recording.recordingId,
      atMs: 13_000,
      reason: 'user_discarded',
    });

    expect(discard).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_media_discard_failed' },
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).toMatchObject({
      status: 'finalized',
      mediaRef,
    });
  });
});
