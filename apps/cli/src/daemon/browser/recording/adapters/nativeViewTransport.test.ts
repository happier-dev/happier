import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingNativeViewCaptureCommand } from './nativeViewCommand';
import {
  createDesktopBrowserRecordingNativeViewCaptureTransport,
  type DesktopBrowserRecordingFrameCaptureInvoke,
  type DesktopBrowserRecordingFrameCaptureRequest,
} from './nativeViewTransport';

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
    navigationGenerationStart: 7,
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

const TRANSPORT_SEAMS = {
  workingDirectory: '/tmp/happier-home',
  outputDirectory: '/tmp/happier-home/recordings',
  randomId: () => 'capture_1',
} as const;

describe('desktop browser recording native-view capture transport (daemon->native invoke)', () => {
  it('threads a root-relative artifact path + maxBytes cap + view identity to the canonical invoke', async () => {
    const ensureDirectory = vi.fn(async () => undefined);
    const deleteFile = vi.fn(async () => undefined);
    let captured: DesktopBrowserRecordingFrameCaptureRequest | undefined;
    const invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async (request) => {
      captured = request;
      return {
        ok: true as const,
        frame: {
          mimeType: 'image/png',
          width: 800,
          height: 600,
          sizeBytes: 4096,
          path: `/native-browser-recordings/${request.outputPath}`,
        },
      };
    });

    const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
      ...TRANSPORT_SEAMS,
      ensureDirectory,
      deleteFile,
      invokeRecordingFrameCapture,
    });

    const recording = createRecording({ maxBytes: 12_000_000 });
    const result = await transport.captureFrame({ recording, maxBytes: 12_000_000 });

    expect(ensureDirectory).toHaveBeenCalledWith('/tmp/happier-home/recordings');
    expect(captured).toEqual({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 7,
      captureRequestId: 'capture_1',
      outputPath: 'browser_recording_native_1.capture_1.native-view.png',
      maxBytes: 12_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      path: '/native-browser-recordings/browser_recording_native_1.capture_1.native-view.png',
      mimeType: 'image/png',
      byteSize: 4096,
      width: 800,
      height: 600,
    });
    await result.cleanup?.();
    expect(deleteFile).toHaveBeenCalledWith(
      '/native-browser-recordings/browser_recording_native_1.capture_1.native-view.png',
    );
    // Reference-only: the transport never carries inline pixel bytes.
    expect(Object.keys(result)).not.toContain('bytesBase64');
    expect(Object.keys(result)).not.toContain('data');
  });

  it('does not delete a caller-guessed path when the native invoke reports an error', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'staleNavigation',
    }));

    const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
      ...TRANSPORT_SEAMS,
      ensureDirectory: async () => undefined,
      deleteFile,
      invokeRecordingFrameCapture,
    });

    const result = await transport.captureFrame({ recording: createRecording(), maxBytes: 16_000_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('staleNavigation');
    expect(deleteFile).not.toHaveBeenCalledWith(
      '/tmp/happier-home/recordings/browser_recording_native_1.capture_1.native-view.png',
    );
  });

  it('rethrows invoke channel failures without guessing the native output path', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async () => {
      throw new Error('ipc channel closed');
    });

    const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
      ...TRANSPORT_SEAMS,
      ensureDirectory: async () => undefined,
      deleteFile,
      invokeRecordingFrameCapture,
    });

    // Driven through the canonical command so the transport throw becomes the documented reason code.
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });
    const result = await command({ recording: createRecording() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('native_view_capture_transport_failed');
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('produces a reference-only artifact end-to-end through the canonical capture command', async () => {
    const deleteFile = vi.fn(async () => undefined);
    const invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async (request) => ({
      ok: true as const,
      frame: { mimeType: 'image/png', width: 1024, height: 768, sizeBytes: 8192, path: request.outputPath },
    }));

    const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
      ...TRANSPORT_SEAMS,
      ensureDirectory: async () => undefined,
      deleteFile,
      invokeRecordingFrameCapture,
    });
    const command = createBrowserRecordingNativeViewCaptureCommand({ transport });

    const result = await command({ recording: createRecording() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toMatchObject({
      kind: 'local-file',
      path: 'browser_recording_native_1.capture_1.native-view.png',
      mimeType: 'image/png',
    });
    expect(result.byteSize).toBe(8192);
  });
});
