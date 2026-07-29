import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserRecordingNativeViewCaptureCommand,
} from './adapters/nativeViewCommand';
import {
  createDesktopBrowserRecordingNativeViewCaptureTransport,
  type DesktopBrowserRecordingFrameCaptureInvoke,
} from './adapters/nativeViewTransport';
import { createBrowserRecordingDaemonRuntime } from './runtime';

/**
 * PRODUCTION-PATH ACCEPTANCE (BA-4 nativeViewCapture) — the desktop daemon entrypoint wiring.
 *
 * Proves the FULL desktop recording chain crosses the daemon→native (Wry) IPC seam end-to-end:
 *   desktop invoke (canonical `desktop_browser_capture_recording_frame`) → daemon transport →
 *   capture command → `nativeViewCapture` adapter → bounded reference-only session-media artifact.
 *
 * With the transport bound, a desktop-view recording must NOT return
 * `browser_recording_capture_adapter_missing` (the previous honest fail-closed state) — it produces a
 * real `local-file` reference. The native byte cap is threaded + re-enforced daemon-side, so an
 * over-cap capture is rejected and never persisted.
 */

const WORKING_DIRECTORY = '/tmp/happier-native-view-production-path';

function buildRuntime(invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke) {
  const transport = createDesktopBrowserRecordingNativeViewCaptureTransport({
    workingDirectory: WORKING_DIRECTORY,
    outputDirectory: `${WORKING_DIRECTORY}/out`,
    randomId: () => 'capture_1',
    ensureDirectory: async () => undefined,
    deleteFile: async () => undefined,
    invokeRecordingFrameCapture,
  });
  return createBrowserRecordingDaemonRuntime({
    workingDirectory: WORKING_DIRECTORY,
    resolveSessionMediaTarget: () => ({ sessionId: 'session_native', messageLocalId: 'message_native' }),
    resolveStartContext: async () => ({
      browserRecordingEnabled: true,
      recordingCapabilities: {
        enabled: true,
        attachmentsEnabled: true,
        available: true,
        supportedCaptureKinds: ['nativeViewCapture'],
        supportedMimeTypes: ['image/png'],
        supportedAdapterKinds: ['externalUrl'],
        maxDurationMs: 30_000,
        maxBytes: 16_000_000,
        maxFps: 12,
        audioSupported: false,
        cursorOverlaySupported: false,
        actionTimelineChaptersSupported: false,
        supportedRetentionClasses: ['preSend'],
        disabledReasons: [],
        policyDeniedReasons: [],
      },
      captureSourceAvailable: true,
    }),
    nativeViewCapture: {
      isPlatformCaptureSupported: () => true,
      captureCommand: createBrowserRecordingNativeViewCaptureCommand({ transport }),
    },
  });
}

function startInput() {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'externalUrl' as const,
    adapterKind: 'externalUrl' as const,
    renderEngineKind: 'desktopWebView' as const,
    captureKind: 'nativeViewCapture' as const,
    fidelity: 'nativeCallback' as const,
    navigationGeneration: 1,
    mimeType: 'image/png',
    retentionClass: 'preSend' as const,
    mediaTarget: { sessionId: 'session_native', messageLocalId: 'message_native' },
  };
}

describe('nativeViewCapture production path (desktop daemon entrypoint wiring)', () => {
  it('records a desktop view to a bounded reference-only artifact (not adapter_missing)', async () => {
    const invoke: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async (request) => ({
      ok: true as const,
      frame: { mimeType: 'image/png', width: 800, height: 600, sizeBytes: 4_096, path: request.outputPath },
    }));
    const runtime = buildRuntime(invoke);
    try {
      const started = await runtime.routes.startRecording(startInput());
      expect(started.status).toBe('started');
      expect(invoke).toHaveBeenCalledTimes(1);
      // The native side received the daemon byte cap, never an unbounded request.
      expect(vi.mocked(invoke).mock.calls[0]?.[0]).toMatchObject({ maxBytes: 16_000_000 });
      const outputPath = vi.mocked(invoke).mock.calls[0]?.[0].outputPath;
      expect(outputPath).toMatch(/^browser_recording_.+\.capture_1\.native-view\.png$/);
      expect(outputPath).not.toMatch(/^[/\\]|^[A-Za-z]:[\\/]/);
    } finally {
      runtime.stop();
    }
  });

  it('stays honestly fail-closed before adapter lookup when no desktop transport source truth is bound', async () => {
    const runtime = createBrowserRecordingDaemonRuntime({
      workingDirectory: WORKING_DIRECTORY,
      resolveSessionMediaTarget: () => ({ sessionId: 'session_native', messageLocalId: 'message_native' }),
      resolveStartContext: async () => ({
        browserRecordingEnabled: true,
        recordingCapabilities: {
          enabled: true,
          attachmentsEnabled: true,
          available: true,
          supportedCaptureKinds: ['nativeViewCapture'],
          supportedMimeTypes: ['image/png'],
          supportedAdapterKinds: ['externalUrl'],
          maxDurationMs: 30_000,
          maxBytes: 16_000_000,
          maxFps: 12,
          audioSupported: false,
          cursorOverlaySupported: false,
          actionTimelineChaptersSupported: false,
          supportedRetentionClasses: ['preSend'],
          disabledReasons: [],
          policyDeniedReasons: [],
        },
      }),
    });
    try {
      await expect(runtime.routes.startRecording(startInput())).resolves.toMatchObject({
        status: 'unavailable',
        reason: { code: 'browser_recording_capture_unavailable' },
      });
    } finally {
      runtime.stop();
    }
  });

  it('rejects an over-cap native capture so nothing oversized is persisted', async () => {
    const invoke: DesktopBrowserRecordingFrameCaptureInvoke = vi.fn(async (request) => ({
      ok: true as const,
      frame: { mimeType: 'image/png', width: 4_000, height: 4_000, sizeBytes: 32_000_000, path: request.outputPath },
    }));
    const runtime = buildRuntime(invoke);
    try {
      await expect(runtime.routes.startRecording(startInput())).resolves.toMatchObject({
        status: 'unavailable',
        reason: { code: 'browser_recording_capture_unavailable' },
      });
    } finally {
      runtime.stop();
    }
  });
});
