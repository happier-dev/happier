import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserRecordingNativeViewCaptureCommand,
  type BrowserRecordingNativeViewCaptureTransport,
  type BrowserRecordingNativeViewCaptureTransportResult,
} from './nativeViewCommand';

function createRecording(overrides: Partial<BrowserRecordingSessionV1> = {}): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'browser_recording_native_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'streamedBrowser',
    adapterKind: 'externalUrl',
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
    actionChapters: [],
    relatedReferences: [],
    ...overrides,
  };
}

function createTransport(
  result: BrowserRecordingNativeViewCaptureTransportResult,
): { transport: BrowserRecordingNativeViewCaptureTransport; captureFrame: ReturnType<typeof vi.fn> } {
  const captureFrame = vi.fn(async () => result);
  return { transport: { captureFrame }, captureFrame };
}

describe('browser recording native-view capture command (daemon->native IPC driver)', () => {
  it('drives the native transport and returns a reference-only artifact', async () => {
    const { transport, captureFrame } = createTransport({
      ok: true,
      path: '/tmp/happier-recording/native-frame.png',
      mimeType: 'image/png',
      byteSize: 4096,
      width: 800,
      height: 600,
    });
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const recording = createRecording();
    const result = await command({ recording });

    expect(captureFrame).toHaveBeenCalledTimes(1);
    expect(captureFrame).toHaveBeenCalledWith({ recording });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toMatchObject({
      kind: 'local-file',
      path: '/tmp/happier-recording/native-frame.png',
      mimeType: 'image/png',
    });
    expect(result.byteSize).toBe(4096);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    // Reference-only: never inline base64 bytes.
    expect(Object.keys(result.source)).not.toContain('data');
    expect(Object.keys(result.source)).not.toContain('bytesBase64');
  });

  it('passes through a native unavailable reason code', async () => {
    const { transport } = createTransport({ ok: false, reasonCode: 'capture_unsupported' });
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const result = await command({ recording: createRecording() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('capture_unsupported');
  });

  it('accepts a native frame beyond the former recording byte default', async () => {
    const cleanup = vi.fn(async () => undefined);
    const { transport } = createTransport({
      ok: true,
      path: '/tmp/happier-recording/oversized.png',
      mimeType: 'image/png',
      byteSize: 32_000_000,
      cleanup,
    });
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const result = await command({ recording: createRecording() });

    expect(result).toMatchObject({ ok: true, byteSize: 32_000_000 });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('fails closed on an empty (zero-byte) native capture', async () => {
    const cleanup = vi.fn(async () => undefined);
    const { transport } = createTransport({
      ok: true,
      path: '/tmp/happier-recording/empty.png',
      mimeType: 'image/png',
      byteSize: 0,
      cleanup,
    });
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const result = await command({ recording: createRecording() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('native_view_capture_empty');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('treats a transport throw as fail-closed, not a crash', async () => {
    const transport: BrowserRecordingNativeViewCaptureTransport = {
      captureFrame: vi.fn(async () => {
        throw new Error('ipc channel closed');
      }),
    };
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const result = await command({ recording: createRecording() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('native_view_capture_transport_failed');
  });
});
