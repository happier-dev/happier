import {
  UiBrowserRecordingCaptureFrameRequestV1Schema,
  UiBrowserRecordingCaptureFrameResponseV1Schema,
  type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import type {
  DesktopBrowserRecordingFrameCaptureInvoke,
  DesktopBrowserRecordingFrameCaptureRequest,
  DesktopBrowserRecordingFrameCaptureResult,
} from './nativeViewTransport';

/**
 * Cross-process reverse-channel transport (W2C-BA-1). The spawned cli daemon runs in a SEPARATE OS
 * process from the Tauri GUI, so it cannot `invokeTauri` to capture the desktop Wry WebView. This is
 * the generic "call the connected desktop UI" seam: it carries the validated
 * `UiBrowserRecordingCaptureFrameRequestV1` over the existing daemon<->UI session RPC channel
 * (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`) and returns the UI's raw (already-decrypted)
 * response for THIS adapter to validate. The concrete socket/encryption wiring is injected by the
 * daemon entrypoint — never opened here — so this module stays free of any socket/auth coupling and
 * is unit-testable against a fake transport.
 */
export type ReverseDesktopBrowserRecordingCaptureUiCall = (
  request: UiBrowserRecordingCaptureFrameRequestV1,
) => Promise<unknown>;

export type CreateReverseDesktopBrowserRecordingNativeViewCaptureInvokeOptions = Readonly<{
  callUi: ReverseDesktopBrowserRecordingCaptureUiCall;
}>;

/** No desktop UI is registered to handle the reverse capture (headless host, or only a mobile UI). */
const UI_UNAVAILABLE_ERROR_CODE = 'desktop_browser_recording_capture_ui_unavailable';
/** The desktop UI answered with a payload that does not match the reference-only contract. */
const INVALID_RESPONSE_ERROR_CODE = 'desktop_browser_recording_capture_ui_invalid_response';

/**
 * Builds the desktop `nativeViewCapture` invoke from a reverse daemon->UI RPC transport. The daemon's
 * `nativeViewTransport` calls this exactly like the in-process `invokeTauri` seam, but the frame is
 * actually captured by the connected desktop UI:
 *   daemon producer -> reverse invoke -> callUi (daemon<->UI session RPC) -> UI handler ->
 *   `desktop_browser_capture_recording_frame` (A2-registered) -> reference-only frame.
 *
 * Reference-only end to end (BRW-15): only a local `path` + metadata cross back; no pixel bytes. When
 * no desktop UI is reachable (RPC method-not-found / transport throw) the invoke fails closed, so the
 * recording producer honestly reports `browser_recording_capture_adapter_missing` rather than
 * pretending a frame exists.
 */
export function createReverseDesktopBrowserRecordingNativeViewCaptureInvoke(
  options: CreateReverseDesktopBrowserRecordingNativeViewCaptureInvokeOptions,
): DesktopBrowserRecordingFrameCaptureInvoke {
  return async (
    request: DesktopBrowserRecordingFrameCaptureRequest,
  ): Promise<DesktopBrowserRecordingFrameCaptureResult> => {
    const payload = UiBrowserRecordingCaptureFrameRequestV1Schema.parse({
      protocolVersion: 1,
      browserSessionId: request.browserSessionId,
      viewId: request.viewId,
      navigationGeneration: request.navigationGeneration,
      captureRequestId: request.captureRequestId,
      outputPath: request.outputPath,
      maxBytes: request.maxBytes,
    });

    let raw: unknown;
    try {
      raw = await options.callUi(payload);
    } catch {
      return { ok: false, errorCode: UI_UNAVAILABLE_ERROR_CODE };
    }

    if (isRpcMethodNotFoundResult(raw)) {
      return { ok: false, errorCode: UI_UNAVAILABLE_ERROR_CODE };
    }

    const parsed = UiBrowserRecordingCaptureFrameResponseV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, errorCode: INVALID_RESPONSE_ERROR_CODE };
    }

    const result = parsed.data.result;
    if (!result.ok) {
      return { ok: false, errorCode: result.errorCode };
    }

    return {
      ok: true,
      frame: {
        mimeType: result.frame.mimeType,
        width: result.frame.width,
        height: result.frame.height,
        sizeBytes: result.frame.sizeBytes,
        path: result.frame.path,
      },
    };
  };
}
