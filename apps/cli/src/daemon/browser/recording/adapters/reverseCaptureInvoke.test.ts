import {
  UiBrowserRecordingCaptureFrameRequestV1Schema,
  type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopBrowserRecordingFrameCaptureRequest } from './nativeViewTransport';
import { createReverseDesktopBrowserRecordingNativeViewCaptureInvoke } from './reverseCaptureInvoke';

function captureRequest(): DesktopBrowserRecordingFrameCaptureRequest {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    captureRequestId: 'capture_1',
    outputPath: '/tmp/recordings/rec.capture_1.native-view.png',
    maxBytes: 16_000_000,
  };
}

describe('createReverseDesktopBrowserRecordingNativeViewCaptureInvoke', () => {
  it('threads a contract-valid reference-only request to the UI and reshapes the success response', async () => {
    const callUi = vi.fn(async (request: UiBrowserRecordingCaptureFrameRequestV1) => ({
      protocolVersion: 1 as const,
      result: {
        ok: true as const,
        frame: {
          mimeType: 'image/png',
          width: 800,
          height: 600,
          sizeBytes: 4_096,
          path: request.outputPath,
        },
      },
    }));
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi });

    const result = await invoke(captureRequest());

    // The daemon byte cap + view identity crossed the reverse channel (validated against the contract).
    const sent = callUi.mock.calls[0]?.[0];
    expect(UiBrowserRecordingCaptureFrameRequestV1Schema.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({ maxBytes: 16_000_000, viewId: 'view_1', navigationGeneration: 2 });

    expect(result).toEqual({
      ok: true,
      frame: {
        mimeType: 'image/png',
        width: 800,
        height: 600,
        sizeBytes: 4_096,
        path: '/tmp/recordings/rec.capture_1.native-view.png',
      },
    });
  });

  it('fails closed (ui_unavailable) when no desktop UI registered the reverse method', async () => {
    const callUi = vi.fn(async () => ({
      error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    }));
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi });

    await expect(invoke(captureRequest())).resolves.toEqual({
      ok: false,
      errorCode: 'desktop_browser_recording_capture_ui_unavailable',
    });
  });

  it('fails closed (ui_unavailable) when the reverse transport throws', async () => {
    const callUi = vi.fn(async () => {
      throw new Error('socket disconnected');
    });
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi });

    await expect(invoke(captureRequest())).resolves.toEqual({
      ok: false,
      errorCode: 'desktop_browser_recording_capture_ui_unavailable',
    });
  });

  it('rejects an off-contract UI response (no inline-bytes / shape smuggling)', async () => {
    const callUi = vi.fn(async () => ({
      protocolVersion: 1,
      result: { ok: true, frame: { mimeType: 'image/png', bytesBase64: 'AAAA' } },
    }));
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi });

    await expect(invoke(captureRequest())).resolves.toEqual({
      ok: false,
      errorCode: 'desktop_browser_recording_capture_ui_invalid_response',
    });
  });

  it('passes a UI-reported failure errorCode straight through', async () => {
    const callUi = vi.fn(async () => ({
      protocolVersion: 1 as const,
      result: { ok: false as const, errorCode: 'captureWriteFailed' },
    }));
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({ callUi });

    await expect(invoke(captureRequest())).resolves.toEqual({ ok: false, errorCode: 'captureWriteFailed' });
  });
});
