import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingNativeViewCaptureAdapter } from './nativeView';

function createRecording(overrides: Partial<BrowserRecordingSessionV1> = {}): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'browser_recording_native_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'streamedBrowser',
    adapterKind: 'localPreview',
    renderEngineKind: 'desktopWebView',
    captureKind: 'nativeViewCapture',
    fidelity: 'nativeCallback',
    startedAtMs: 1000,
    status: 'recording',
    navigationGenerationStart: 1,
    durationMs: 0,
    byteSize: 0,
    frameCount: 0,
    fps: 1,
    mimeType: 'image/png',
    retentionClass: 'preSend',
    redactionLevel: 'metadataOnly',
    policyState: 'allowed',
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    actionChapters: [],
    relatedReferences: [],
    ...overrides,
  };
}

describe('browser recording native-view capture adapter', () => {
  it('advertises the nativeViewCapture kind', () => {
    const adapter = createBrowserRecordingNativeViewCaptureAdapter({
      isPlatformCaptureSupported: () => true,
    });
    expect(adapter.captureKind).toBe('nativeViewCapture');
  });

  it('rejects (typed-unavailable) when the platform does not report capture support', async () => {
    const adapter = createBrowserRecordingNativeViewCaptureAdapter({
      isPlatformCaptureSupported: () => false,
    });
    const result = await adapter.start({ recording: createRecording() });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason.code).toBe('browser_recording_capture_unavailable');
  });

  it('stays typed-unavailable when no native capture command is bound (no daemon->native producer)', async () => {
    const adapter = createBrowserRecordingNativeViewCaptureAdapter({
      isPlatformCaptureSupported: () => true,
      // captureCommand intentionally omitted — no daemon->native path exists today.
    });
    const result = await adapter.start({ recording: createRecording() });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason.code).toBe('browser_recording_capture_adapter_missing');
  });

  it('produces a reference-only artifact (never inline bytes) when a native command is bound', async () => {
    const captureCommand = vi.fn(async () => ({
      ok: true as const,
      source: {
        kind: 'local-file' as const,
        path: '/tmp/native-capture.png',
        mimeType: 'image/png',
        fileNameHint: 'native-capture.png',
      },
      byteSize: 4096,
      width: 800,
      height: 600,
    }));
    const adapter = createBrowserRecordingNativeViewCaptureAdapter({
      isPlatformCaptureSupported: () => true,
      captureCommand,
      nowMs: () => 5000,
    });

    const recording = createRecording();
    const started = await adapter.start({ recording });
    expect(started.status).toBe('started');

    const artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
    expect(artifact.mimeType).toBe('image/png');
    expect(artifact.byteSize).toBe(4096);
    expect(artifact.source).toMatchObject({ kind: 'local-file', path: '/tmp/native-capture.png' });
    // Reference-only: the artifact carries a local-file source, never inline base64 bytes.
    expect(Object.keys(artifact.source)).not.toContain('bytesBase64');
    expect(captureCommand).toHaveBeenCalledTimes(1);
  });
});
