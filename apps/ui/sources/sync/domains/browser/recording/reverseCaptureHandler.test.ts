import {
    UiBrowserRecordingCaptureFrameResponseV1Schema,
    type UiBrowserRecordingCaptureFrameRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
    DesktopBrowserCaptureRecordingFrameRequest,
    DesktopBrowserCaptureRecordingFrameResult,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import { handleUiBrowserRecordingCaptureFrameRequest } from './reverseCaptureHandler';

const REQUEST: UiBrowserRecordingCaptureFrameRequestV1 = {
    protocolVersion: 1,
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    captureRequestId: 'capture_1',
    outputPath: '/tmp/recordings/rec.capture_1.native-view.png',
    maxBytes: 16_000_000,
};

function availability() {
    return { supported: true, reason: null } as unknown as DesktopBrowserCaptureRecordingFrameResult['availability'];
}

describe('handleUiBrowserRecordingCaptureFrameRequest (W2C-BA-1 UI reverse handler)', () => {
    it('forwards the daemon request to the native capture and returns a reference-only success response', async () => {
        const capture = vi.fn(async (request: DesktopBrowserCaptureRecordingFrameRequest): Promise<DesktopBrowserCaptureRecordingFrameResult> => ({
            ok: true,
            availability: availability(),
            frame: {
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                navigationGeneration: request.navigationGeneration,
                captureRequestId: request.captureRequestId,
                capturedAtMs: 1_000,
                mimeType: 'image/png',
                width: 800,
                height: 600,
                sizeBytes: 4_096,
                path: request.outputPath,
            },
        }));

        const response = await handleUiBrowserRecordingCaptureFrameRequest(REQUEST, { capture });

        // The daemon-owned outputPath + byte cap reached the native capture seam unchanged.
        expect(capture).toHaveBeenCalledWith(
            expect.objectContaining({ outputPath: REQUEST.outputPath, maxBytes: 16_000_000, viewId: 'view_1' }),
        );
        // Reference-only contract — a local path + metadata, never inline pixel bytes.
        expect(UiBrowserRecordingCaptureFrameResponseV1Schema.safeParse(response).success).toBe(true);
        expect(response.result).toEqual({
            ok: true,
            frame: { mimeType: 'image/png', width: 800, height: 600, sizeBytes: 4_096, path: REQUEST.outputPath },
        });
    });

    it('maps a native capture failure to a contract-valid failure response', async () => {
        const capture = vi.fn(async (): Promise<DesktopBrowserCaptureRecordingFrameResult> => ({
            ok: false,
            availability: availability(),
            errorCode: 'captureWriteFailed',
        }));

        const response = await handleUiBrowserRecordingCaptureFrameRequest(REQUEST, { capture });

        expect(response.result).toEqual({ ok: false, errorCode: 'captureWriteFailed' });
    });

    it('rejects a malformed daemon request without touching the native capture', async () => {
        const capture = vi.fn();

        const response = await handleUiBrowserRecordingCaptureFrameRequest(
            { protocolVersion: 1, browserSessionId: '', viewId: 'view_1' },
            { capture },
        );

        expect(capture).not.toHaveBeenCalled();
        expect(response.result).toEqual({ ok: false, errorCode: 'captureRequestInvalid' });
    });
});
