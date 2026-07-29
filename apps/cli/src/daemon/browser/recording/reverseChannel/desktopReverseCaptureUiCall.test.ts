import {
  RPC_METHODS,
  UiBrowserRecordingCaptureFrameResponseV1Schema,
  type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createReverseDesktopBrowserRecordingNativeViewCaptureInvoke } from '../adapters/reverseCaptureInvoke';
import type { DesktopBrowserRecordingFrameCaptureRequest } from '../adapters/nativeViewTransport';

import {
  createDesktopReverseBrowserRecordingCaptureUiCall,
  type ReverseCaptureMachineRpcClient,
} from './desktopReverseCaptureUiCall';

function captureRequest(): DesktopBrowserRecordingFrameCaptureRequest {
    return {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      captureRequestId: 'capture_1',
      outputPath: 'rec.capture_1.native-view.png',
      maxBytes: 16_000_000,
    };
  }

describe('createDesktopReverseBrowserRecordingCaptureUiCall', () => {
  it('routes the capture over the machine socket via the canonical reverse RPC method', async () => {
    const callConnectedClientRpc = vi.fn(
      async (_method: string, params: unknown) => ({
        ok: true as const,
        result: UiBrowserRecordingCaptureFrameResponseV1Schema.parse({
          protocolVersion: 1,
          result: {
            ok: true,
            frame: {
              mimeType: 'image/png',
              width: 800,
              height: 600,
              sizeBytes: 4_096,
              path: (params as UiBrowserRecordingCaptureFrameRequestV1).outputPath,
            },
          },
        }),
      }),
    );
    const client: ReverseCaptureMachineRpcClient = { callConnectedClientRpc };

    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
      callUi: createDesktopReverseBrowserRecordingCaptureUiCall({ getMachineClient: () => client }),
    });
    const result = await invoke(captureRequest());

    expect(callConnectedClientRpc).toHaveBeenCalledWith(
      RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
      expect.objectContaining({ outputPath: captureRequest().outputPath, maxBytes: 16_000_000 }),
      undefined,
    );
    expect(result).toMatchObject({ ok: true, frame: { path: captureRequest().outputPath } });
  });

  it('fails closed (ui_unavailable) when no machine client is connected', async () => {
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
      callUi: createDesktopReverseBrowserRecordingCaptureUiCall({ getMachineClient: () => null }),
    });
    await expect(invoke(captureRequest())).resolves.toEqual({
      ok: false,
      errorCode: 'desktop_browser_recording_capture_ui_unavailable',
    });
  });

  it('fails closed (ui_unavailable) when the reverse RPC reports no registered client', async () => {
    const client: ReverseCaptureMachineRpcClient = {
      callConnectedClientRpc: async () => ({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
    };
    const invoke = createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
      callUi: createDesktopReverseBrowserRecordingCaptureUiCall({ getMachineClient: () => client }),
    });
    await expect(invoke(captureRequest())).resolves.toEqual({
      ok: false,
      errorCode: 'desktop_browser_recording_capture_ui_unavailable',
    });
  });
});
