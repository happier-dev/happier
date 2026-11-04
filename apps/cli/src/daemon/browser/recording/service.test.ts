import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BrowserEvidenceSessionMediaReferenceV1,
  BrowserRecordingCapabilities,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';

import { createSurfaceInputControl } from '../../surfaces/inputControl';
import type { BrowserRecordingRuntimeStartInput } from './service';
import { createDeferred } from '@/testkit/async/deferred';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

const recordingCapabilities = {
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: ['streamedBrowserSurface'],
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

  it.each([
    { name: 'permission', overrides: { policyState: 'permissionDenied' }, code: 'browser_recording_policy_denied' },
    { name: 'policy', overrides: { policyState: 'policyDenied' }, code: 'browser_recording_policy_denied' },
    { name: 'feature', overrides: { browserRecordingEnabled: false }, code: 'browser_recording_disabled' },
    { name: 'capability', overrides: { recordingCapabilities: { ...recordingCapabilities, available: false } }, code: 'browser_recording_capability_unavailable' },
    { name: 'adapter', overrides: { adapterKind: 'externalUrl' }, code: 'browser_recording_adapter_unavailable' },
    { name: 'capture', overrides: { captureKind: 'cdpScreencast' }, code: 'browser_recording_capture_unavailable' },
    { name: 'source', overrides: { captureSource: undefined, captureSourceAvailable: false }, code: 'browser_recording_capture_unavailable' },
    { name: 'mime', overrides: { mimeType: 'image/png' }, code: 'browser_recording_mime_unavailable' },
    { name: 'retention', overrides: { retentionClass: 'diagnosticsOnly' }, code: 'browser_recording_retention_unavailable' },
  ] satisfies readonly { name: string; overrides: Partial<BrowserRecordingRuntimeStartInput>; code: string }[])(
    'shares the UI availability reason for $name', async ({ overrides, code }) => {
      const { createBrowserRecordingDaemonService } = await import('./service');
      const { resolveBrowserRecordingAvailability } = await import('../../../../../ui/sources/sync/domains/browser/recording/state');
      const service = createBrowserRecordingDaemonService({
        captureAdapters: [],
        mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
      });
      const input = { ...confidentialStartInput, captureSourceAvailable: true, ...overrides };
      const ui = resolveBrowserRecordingAvailability(input);
      const daemon = await service.startRecording(input);
      expect(daemon).toMatchObject({ status: 'unavailable', reason: { code } });
      if (daemon.status !== 'unavailable') throw new Error('Recording must be unavailable');
      expect(ui?.reasonCode).toBe(daemon.reason.code);
    });

  it('isolates recordings and retirement for two Sessions sharing one view id', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const service = createBrowserRecordingDaemonService({
      now: () => 10_000,
      // The capture encoder and media persistence are external process/storage boundaries.
      captureAdapters: [{ captureKind: 'streamFrameCapture', start: async () => ({ status: 'started' }),
        stop: async () => ({ durationMs: 1_000, byteSize: 800_000, frameCount: 12, fps: 12,
          mimeType: 'video/webm', source: recordingArtifactSource }), discard: async () => {} }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    const viewA = { browserSessionId: 'session_a', viewId: 'main' };
    const viewB = { browserSessionId: 'session_b', viewId: 'main' };
    const first = await service.startRecording({ ...confidentialStartInput, ...viewA });
    const second = await service.startRecording({ ...confidentialStartInput, ...viewB });
    expect(first.status).toBe('started');
    expect(second.status).toBe('started');
    if (first.status !== 'started' || second.status !== 'started') throw new Error('Both Sessions must record');
    expect(first.recording.recordingId).not.toBe(second.recording.recordingId);
    expect(service.listRecordingsForView(viewA)).toEqual([first.recording]);
    expect(service.listRecordingsForView(viewB)).toEqual([second.recording]);
    expect(await service.startRecording({ ...confidentialStartInput, ...viewA }))
      .toMatchObject({ status: 'unavailable', reason: { code: 'browser_recording_already_active' } });

    expect(await service.cancelRecording({ recordingId: first.recording.recordingId, reason: 'session_closed' }))
      .toMatchObject({ recording: { recordingId: first.recording.recordingId, outcomeReason: 'session_closed' } });
    expect(service.getRecordingStatus(second.recording.recordingId)).toEqual(second.recording);
    const restarted = await service.startRecording({ ...confidentialStartInput, ...viewA });
    expect(restarted.status).toBe('started');
    if (restarted.status !== 'started') throw new Error('Retired Session must restart');
    expect(await service.cancelRecording({ recordingId: restarted.recording.recordingId, reason: 'user_canceled' }))
      .toMatchObject({ status: 'canceled', recording: { browserSessionId: viewA.browserSessionId } });
    expect(service.getRecordingStatus(second.recording.recordingId)).toEqual(second.recording);
    expect(await service.stopRecording({ recordingId: second.recording.recordingId, navigationGenerationEnd: 8 }))
      .toMatchObject({ status: 'finalized', recording: { browserSessionId: viewB.browserSessionId } });
    expect(service.listRecordingsForView(viewA).every(recording => recording.browserSessionId === viewA.browserSessionId)).toBe(true);
    expect(service.listRecordingsForView(viewB)).toMatchObject([{ status: 'finalized' }]);
  });

  it('keeps failed terminal records transportable and returns their cause on repeated stop', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const service = createBrowserRecordingDaemonService({ now: () => 10_000,
      captureAdapters: [{ captureKind: 'streamFrameCapture', start: async () => ({ status: 'started' }),
        stop: async () => { throw new Error('encoder exited'); }, discard: async () => {} }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    const started = await service.startRecording(confidentialStartInput);
    if (started.status !== 'started') throw new Error('Expected admitted recording');
    const input = { recordingId: started.recording.recordingId, navigationGenerationEnd: 7 };
    const stopped = await service.stopRecording(input);
    expect(StrictJsonValueSchema.safeParse(stopped).success).toBe(true);
    expect(stopped).toMatchObject({ status: 'failed', reason: 'capture_failed' });
    expect(await service.stopRecording(input)).toEqual(stopped);
    expect(StrictJsonValueSchema.safeParse(service.getRecordingStatus(input.recordingId)).success).toBe(true);
    expect(StrictJsonValueSchema.safeParse(service.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: confidentialStartInput.viewId })).success).toBe(true);
  });

  it.each([false, true])('projects retained recording paths and expiry with transcript custody=%s', async (attached) => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const { createBrowserRecordingSessionMediaWriter } = await import('./sessionMediaWriter');
    const workspace = await mkdtemp(join(tmpdir(), 'happier-recording-storage-'));
    const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]), Buffer.from('recording fixture')]);
    try {
      const sourcePath = join(workspace, 'capture.webm');
      await writeFile(sourcePath, bytes);
      // Capture is the external encoder boundary; persistence and recording lifecycle stay real.
      const service = createBrowserRecordingDaemonService({
        now: () => 10_000,
        captureAdapters: [{
          captureKind: 'streamFrameCapture',
          start: async () => ({ status: 'started' }),
          stop: async () => ({ durationMs: 2_000, byteSize: bytes.length, frameCount: 24, fps: 12, mimeType: 'video/webm', source: { kind: 'local-file', path: sourcePath, fileNameHint: 'capture.webm' } }),
          discard: async () => {},
        }],
        mediaWriter: createBrowserRecordingSessionMediaWriter({
          workingDirectory: workspace,
          pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
          resolveSessionMediaTarget: (recording) => ({ sessionId: `session_${recording.viewId}`, messageLocalId: recording.recordingId }),
          // Transcript admission is the process/network boundary.
          commitAttachment: attached ? async () => {} : undefined,
        }),
      });
      const changes: unknown[] = [];
      const release = service.subscribeStorageChanges(() => changes.push(service.listStorageRecordings()));
      expect(service.listStorageRecordings()).toEqual([]);
      for (const [viewId, expiresAtMs] of [['view_a', 20_000], ['view_b', 30_000]] as const) {
        const recordingId = `recording_${viewId}`;
        expect((await service.startRecording({ ...confidentialStartInput, recordingId, viewId })).status).toBe('started');
        expect((await service.stopRecording({ recordingId, navigationGenerationEnd: 8, stoppedAtMs: 12_000, expiresAtMs })).status).toBe('finalized');
      }
      const stored = service.listStorageRecordings();
      expect(service.nextExpiryAtMs()).toBe(20_000);
      if (attached) {
        expect(stored).toEqual([]);
        const recording = service.getRecordingStatus('recording_view_a');
        expect(recording?.mediaRef).toBeTruthy();
        const attachedPath = join(workspace, '.happier', 'uploads', 'artifacts', 'session_view_a', 'recording_view_a', `${recording?.mediaRef?.mediaId.slice(0, 12)}-capture.webm`);
        expect(await readFile(attachedPath)).toEqual(bytes);
        await expect(service.discardStorageRecording({ recordingId: 'recording_view_a' })).rejects.toMatchObject({ code: 'browser_recording_missing' });
        await service.cancelRecording({ recordingId: 'recording_view_a', reason: 'user_discarded' });
        expect(await readFile(attachedPath)).toEqual(bytes);
        release();
        return;
      }
      expect(stored).toHaveLength(2);
      expect(stored).toEqual([
        expect.objectContaining({ recordingId: 'recording_view_a', expiresAtMs: 20_000, active: false }),
        expect.objectContaining({ recordingId: 'recording_view_b', expiresAtMs: 30_000, active: false }),
      ]);
      for (const item of stored) {
        expect(item.path).toContain(join('.happier', 'uploads', 'artifacts', `session_${item.recordingId.slice('recording_'.length)}`, item.recordingId));
        expect(await readFile(item.path)).toEqual(bytes);
      }
      expect(changes).toContainEqual(stored);
      expect(await service.cleanupExpiredRecordings({ nowMs: 20_000 })).toEqual({ discardedRecordingIds: ['recording_view_a'], failedRecordingIds: [] });
      expect(service.listStorageRecordings()).toEqual([stored[1]]);
      expect(service.nextExpiryAtMs()).toBe(30_000);
      expect(changes.at(-1)).toEqual([stored[1]]);
      await expect(readFile(stored[0].path)).rejects.toThrow();
      release();
      const beforeCancel = changes.length;
      const denied = Object.assign(new Error('approval changed'), { code: 'changed_since_review' });
      await expect(service.discardStorageRecording({ recordingId: 'recording_view_b', beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
      expect(service.listStorageRecordings()).toEqual([stored[1]]);
      expect(await readFile(stored[1].path)).toEqual(bytes);
      await service.discardStorageRecording({ recordingId: 'recording_view_b' });
      expect(service.getRecordingStatus('recording_view_b')).toMatchObject({ status: 'discarded', outcomeReason: 'user_discarded' });
      await expect(readFile(stored[1].path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(service.listStorageRecordings()).toEqual([]);
      expect(service.nextExpiryAtMs()).toBeNull();
      expect(changes).toHaveLength(beforeCancel);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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

  it.each(['starting', 'stopping', 'stopping_error', 'persisting'] as const)('drains %s before confidential delivery and keeps only a successfully stopped prefix', async (phase) => {
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

    const safePrefix = phase === 'stopping' || phase === 'persisting';
    if (safePrefix) {
      expect(discard).not.toHaveBeenCalled();
      expect(persistRecording).toHaveBeenCalled();
      expect(discardRecording).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'finalized', recording: {
        outcomeReason: phase === 'persisting' ? 'user_stopped' : 'policy_revoked', mediaRef,
      } });
    } else {
      expect(discard).toHaveBeenCalled();
      expect(persistRecording).not.toHaveBeenCalled();
    }
    if (phase === 'stopping' || phase === 'persisting') expect(cleanup).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('D26-recording-fixture-secret');
    expect(service.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).not.toContainEqual(expect.objectContaining({ status: 'recording' }));
    expect(service.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })[0].mediaRef).toEqual(safePrefix ? mediaRef : undefined);
  });

  it('finalizes the pre-private prefix while an unrelated view keeps recording', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const control = createSurfaceInputControl();
    const safeControl = createSurfaceInputControl();
    const discardedViews: string[] = [];
    const service = createBrowserRecordingDaemonService({
      resolveInputControl: ({ viewId }) => viewId === 'view_1' ? control : safeControl,
      captureAdapters: [{
        captureKind: 'streamFrameCapture',
        start: async () => ({ status: 'started' }),
        stop: async () => ({ durationMs: 100, byteSize: 20, frameCount: 1, fps: 1, mimeType: 'video/webm', source: recordingArtifactSource }),
        discard: async ({ recording }) => { discardedViews.push(recording.viewId); },
      }],
      mediaWriter: { persistRecording: async () => mediaRef, discardRecording: async () => {} },
    });
    await service.startRecording(confidentialStartInput);
    await service.startRecording({ ...confidentialStartInput, viewId: 'safe_view' });
    await control.beginConfidentialityHold();

    expect(discardedViews).toEqual([]);
    expect(service.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })[0]).toMatchObject({ status: 'finalized', outcomeReason: 'policy_revoked', mediaRef });
    expect(service.listRecordingsForView({ browserSessionId: 'browser_session_1', viewId: 'safe_view' })[0]).toMatchObject({ status: 'recording' });
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

  it.each(['user_canceled', 'session_closed'] as const)('keeps %s capture cleanup reachable after the input target closes', async (reason) => {
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
    await service.cancelRecording({ recordingId: 'closed_capture', reason });

    expect(capturing).toBe(false);
  });

  it('persists stopped recordings even when reported fps exceeds the requested rate and stores only a reference envelope', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const cleanup = vi.fn(async () => {});
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 2_000,
        byteSize: 800_000,
        frameCount: 24,
        fps: 24,
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
      fps: 24,
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

  it('persists valid captured artifacts beyond the former byte default', async () => {
    const { createBrowserRecordingDaemonService } = await import('./service');
    const cleanup = vi.fn(async () => {});
    const captureAdapter = {
      captureKind: 'streamFrameCapture' as const,
      start: vi.fn(async () => ({ status: 'started' as const })),
      stop: vi.fn(async () => ({
        durationMs: 2_000,
        byteSize: 16_000_001,
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
      status: 'finalized',
      recording: { status: 'finalized', outcomeReason: 'user_stopped', byteSize: 16_000_001, mediaRef },
    });
    expect(mediaWriter.persistRecording).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('discards temporary capture artifacts with explicit outcomes on user cancel and Session close', async () => {
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
      recording: { status: 'canceled', outcomeReason: 'user_canceled' },
    });
    expect(canceled).not.toHaveProperty('recording.mediaRef');

    const sessionCloseStart = await service.startRecording({
      browserRecordingEnabled: true,
      recordingCapabilities,
      browserSessionId: 'browser_session_1',
      viewId: 'view_session_closed',
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
    expect(sessionCloseStart.status).toBe('started');
    if (sessionCloseStart.status !== 'started') return;

    const sessionClosed = await service.cancelRecording({
      recordingId: sessionCloseStart.recording.recordingId,
      atMs: 11_500,
      reason: 'session_closed',
    });

    expect(sessionClosed).toMatchObject({
      status: 'discarded',
      recording: { status: 'discarded', outcomeReason: 'session_closed' },
    });
    expect(sessionClosed).not.toHaveProperty('recording.mediaRef');
    expect(captureAdapter.discard).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: cancelStart.recording.recordingId,
      reason: 'user_canceled',
    }));
    expect(captureAdapter.discard).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: sessionCloseStart.recording.recordingId,
      reason: 'session_closed',
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
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).not.toHaveProperty('mediaRef');
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
      },
    });
    expect(service.getRecordingStatus(started.recording.recordingId)).toMatchObject({
      status: 'discarded',
    });
    expect(discarded).not.toHaveProperty('recording.mediaRef');
    expect(service.getRecordingStatus(started.recording.recordingId)).not.toHaveProperty('mediaRef');
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
