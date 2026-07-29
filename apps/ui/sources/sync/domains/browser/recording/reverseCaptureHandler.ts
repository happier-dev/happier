import {
    UiBrowserRecordingCaptureFrameRequestV1Schema,
    UiBrowserRecordingCaptureFrameResponseV1Schema,
    type UiBrowserRecordingCaptureFrameResponseV1,
} from '@happier-dev/protocol';

import {
    captureDesktopBrowserRecordingFrame,
    type DesktopBrowserCaptureRecordingFrameRequest,
    type DesktopBrowserCaptureRecordingFrameResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

/**
 * UI half of the reverse (daemon -> UI) native-view recording capture channel (W2C-BA-1).
 *
 * The spawned cli daemon cannot drive the desktop Wry WebView directly (separate OS process), so it
 * asks the connected desktop UI — over the daemon<->UI session RPC channel
 * (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`) — to capture one frame. This handler is the
 * binding the UI registers for that method: it forwards the daemon's reference-only request straight
 * to the A2-registered `captureDesktopBrowserRecordingFrame` Tauri command and answers a contract-valid
 * reference-only response (only a local `path` + metadata; never inline pixel bytes — BRW-15).
 */

const CAPTURE_UNAVAILABLE_ERROR_CODE = 'captureUnsupported';

export type DesktopBrowserRecordingFrameCapturer = (
    request: DesktopBrowserCaptureRecordingFrameRequest,
) => Promise<DesktopBrowserCaptureRecordingFrameResult>;

export type HandleUiBrowserRecordingCaptureFrameOptions = Readonly<{
    /** Injectable capture seam; defaults to the canonical `captureDesktopBrowserRecordingFrame` bridge. */
    capture?: DesktopBrowserRecordingFrameCapturer;
}>;

/**
 * Validates the daemon's reverse request, runs the desktop native capture, and reshapes the native
 * result into the shared `UiBrowserRecordingCaptureFrameResponseV1`. An invalid request, or a native
 * capture that produced no `frame`, becomes a contract-valid failure response so the daemon producer
 * fails closed instead of receiving an off-contract payload.
 */
export async function handleUiBrowserRecordingCaptureFrameRequest(
    rawRequest: unknown,
    options?: HandleUiBrowserRecordingCaptureFrameOptions,
): Promise<UiBrowserRecordingCaptureFrameResponseV1> {
    const parsed = UiBrowserRecordingCaptureFrameRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success) {
        return UiBrowserRecordingCaptureFrameResponseV1Schema.parse({
            protocolVersion: 1,
            result: { ok: false, errorCode: 'captureRequestInvalid' },
        });
    }

    const capture = options?.capture ?? captureDesktopBrowserRecordingFrame;
    const request = parsed.data;
    const result = await capture({
        browserSessionId: request.browserSessionId,
        viewId: request.viewId,
        navigationGeneration: request.navigationGeneration,
        captureRequestId: request.captureRequestId,
        outputPath: request.outputPath,
        maxBytes: request.maxBytes,
    });

    if (!result.ok || !result.frame) {
        return UiBrowserRecordingCaptureFrameResponseV1Schema.parse({
            protocolVersion: 1,
            result: { ok: false, errorCode: result.errorCode ?? CAPTURE_UNAVAILABLE_ERROR_CODE },
        });
    }

    return UiBrowserRecordingCaptureFrameResponseV1Schema.parse({
        protocolVersion: 1,
        result: {
            ok: true,
            frame: {
                mimeType: result.frame.mimeType,
                width: result.frame.width,
                height: result.frame.height,
                sizeBytes: result.frame.sizeBytes,
                path: result.frame.path,
            },
        },
    });
}
