import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '../../rpc/index.js';

import {
  UiBrowserRecordingCaptureFrameRequestV1Schema,
  UiBrowserRecordingCaptureFrameResponseV1Schema,
} from './reverseCaptureV1.js';

/**
 * Contract round-trip for the reverse (daemon -> UI) native-view capture channel (W2C-BA-1). Both
 * endpoints (daemon reverse-invoke adapter + UI reverse handler) validate against THIS shared schema,
 * so the round-trip here is the cross-package contract guarantee that the two halves fit.
 */
describe('UiBrowserRecordingCaptureFrame contract (W2C-BA-1)', () => {
  it('exposes the canonical reverse-channel RPC method literal', () => {
    expect(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME).toBe('ui.browser.recording.captureFrame');
  });

  it('round-trips a reference-only capture request', () => {
    const request = {
      protocolVersion: 1 as const,
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 3,
      captureRequestId: 'capture_1',
      outputPath: '/tmp/recordings/rec.capture_1.native-view.png',
      maxBytes: 16_000_000,
    };
    const parsed = UiBrowserRecordingCaptureFrameRequestV1Schema.parse(request);
    expect(parsed).toEqual(request);
  });

  it('rejects an unbounded (non-positive) byte cap', () => {
    expect(
      UiBrowserRecordingCaptureFrameRequestV1Schema.safeParse({
        protocolVersion: 1,
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        captureRequestId: 'capture_1',
        outputPath: '/tmp/x.png',
        maxBytes: 0,
      }).success,
    ).toBe(false);
  });

  it('round-trips a reference-only success response (no inline bytes)', () => {
    const response = {
      protocolVersion: 1 as const,
      result: {
        ok: true as const,
        frame: {
          mimeType: 'image/png',
          width: 800,
          height: 600,
          sizeBytes: 4_096,
          path: '/tmp/recordings/rec.capture_1.native-view.png',
        },
      },
    };
    const parsed = UiBrowserRecordingCaptureFrameResponseV1Schema.parse(response);
    expect(parsed).toEqual(response);
  });

  it('round-trips a reference-only failure response', () => {
    const response = {
      protocolVersion: 1 as const,
      result: { ok: false as const, errorCode: 'captureWriteFailed' },
    };
    expect(UiBrowserRecordingCaptureFrameResponseV1Schema.parse(response)).toEqual(response);
  });

  it('rejects a success response that smuggles inline pixel bytes', () => {
    expect(
      UiBrowserRecordingCaptureFrameResponseV1Schema.safeParse({
        protocolVersion: 1,
        result: {
          ok: true,
          frame: {
            mimeType: 'image/png',
            width: 800,
            height: 600,
            sizeBytes: 4_096,
            path: '/tmp/x.png',
            bytesBase64: 'AAAA',
          },
        },
      }).success,
    ).toBe(false);
  });
});
