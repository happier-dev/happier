import { describe, expect, it } from 'vitest';

import {
  applyMachineLiveStreamDropPolicy,
  createMachineLiveStreamMeter,
} from './metering';
import type { MachineLiveStreamFrameV1, MachineLiveStreamWireFrameV1 } from './v1';

function frame(
  sequence: number,
  payloadKind: MachineLiveStreamFrameV1['payloadKind'],
  payloadSizeBytes: number,
  payloadBase64 = Buffer.from(new Uint8Array(payloadSizeBytes)).toString('base64'),
): MachineLiveStreamFrameV1 {
  return {
    v: 1,
    streamId: 'stream_1',
    sequence,
    timestampMs: 1_000 + sequence,
    payloadKind,
    payloadEncoding: 'binary_base64',
    payloadBase64,
    payloadSizeBytes,
  };
}

describe('machine live-stream metering', () => {
  it('admits metadata outside media cadence while preserving payload byte budgets', () => {
    const meter = createMachineLiveStreamMeter({
      caps: { maxFramesPerSecond: 2, maxBitrateBps: 96, maxFrameBytes: 3, maxTotalBytes: 12 },
      startedAtMs: 1_000,
    });
    expect(meter.recordFrame(frame(1, 'image_keyframe', 3), 1_000)).toMatchObject({ ok: true });
    expect(meter.recordFrame(frame(2, 'metadata', 3), 1_010)).toMatchObject({
      ok: true, metering: { framesPerSecond: 1, bytesSent: 6, movingBitrateBps: 48 },
    });
    expect(meter.recordFrame(frame(3, 'image_delta', 3), 1_020)).toMatchObject({
      ok: true, metering: { framesPerSecond: 2, bytesSent: 9, movingBitrateBps: 72 },
    });
    expect(meter.recordFrame(frame(4, 'metadata', 3), 1_025)).toMatchObject({
      ok: true, metering: { framesPerSecond: 2, framesSent: 4, bytesSent: 12, movingBitrateBps: 96 },
    });
    expect(meter.recordFrame(frame(5, 'image_delta', 1), 1_030)).toMatchObject({
      ok: false, reasonCode: 'max_frames_per_second_exceeded',
    });
    expect(meter.recordFrame(frame(5, 'metadata', 1), 1_030)).toMatchObject({
      ok: false, reasonCode: 'max_bitrate_bps_exceeded',
    });
    expect(meter.recordFrame(frame(5, 'metadata', 1), 3_000)).toMatchObject({
      ok: false, reasonCode: 'max_total_bytes_exceeded',
    });
    expect(meter.recordFrame(frame(5, 'metadata', 4), 3_000)).toMatchObject({
      ok: false, reasonCode: 'max_frame_bytes_exceeded',
    });
  });

  it('bounds plain and encrypted relay payload bytes without reading decoded content', () => {
    for (const payload of [{ t: 'plain', v: 'AQID' }, { t: 'encrypted', c: 'AQID' }] as const) {
      const { payloadBase64: _decoded, ...header } = frame(1, 'image_keyframe', 3);
      const wireFrame: MachineLiveStreamWireFrameV1 = { ...header, payload };
      const result = applyMachineLiveStreamDropPolicy({ frames: [wireFrame], maxWindowFrames: 1, maxWindowBytes: 2 });
      expect(result.frames).toEqual([]);
      expect(result.bytesDropped).toBe(3);
      expect(result.requiresKeyframeResync).toBe(true);
    }
  });

  it('meters source-driven capture without imposing implicit caps', () => {
    const meter = createMachineLiveStreamMeter({ caps: {}, startedAtMs: 0 });
    expect(meter.recordFrame(frame(1, 'image_keyframe', 3_000_000), 2_000_000)).toMatchObject({ ok: true });
    for (let sequence = 2; sequence <= 40; sequence += 1) {
      expect(meter.recordFrame(frame(sequence, 'image_keyframe', 10), 2_000_000)).toMatchObject({ ok: true });
    }
  });
  it('enforces frame size, FPS, duration, and total byte caps', () => {
    const meter = createMachineLiveStreamMeter({
      caps: {
        maxBitrateBps: 80,
        maxFramesPerSecond: 2,
        maxFrameBytes: 4,
        maxDurationMs: 1_000,
        maxTotalBytes: 6,
      },
      startedAtMs: 1_000,
    });

    expect(meter.recordFrame(frame(1, 'image_keyframe', 3), 1_000)).toMatchObject({ ok: true });
    expect(meter.recordFrame(frame(2, 'image_delta', 3), 1_100)).toMatchObject({ ok: true });
    expect(meter.recordFrame(frame(3, 'image_delta', 1), 1_200)).toMatchObject({
      ok: false,
      reasonCode: 'max_frames_per_second_exceeded',
    });
    expect(meter.recordFrame(frame(4, 'image_delta', 5), 2_100)).toMatchObject({
      ok: false,
      reasonCode: 'max_frame_bytes_exceeded',
    });
    expect(meter.recordFrame(frame(5, 'image_delta', 1), 2_001)).toMatchObject({
      ok: false,
      reasonCode: 'max_duration_ms_exceeded',
    });
  });

  it('meters decoded payload bytes instead of advisory frame sizes', () => {
    const meter = createMachineLiveStreamMeter({
      caps: {
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 4,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startedAtMs: 1_000,
    });

    expect(meter.recordFrame(
      frame(1, 'image_keyframe', 1, Buffer.from(new Uint8Array(16)).toString('base64')),
      1_000,
    )).toMatchObject({
      ok: false,
      reasonCode: 'max_frame_bytes_exceeded',
    });
  });

  it('drops oldest deltas first while preserving the newest keyframe', () => {
    const result = applyMachineLiveStreamDropPolicy({
      frames: [
        frame(1, 'image_keyframe', 4),
        frame(2, 'image_delta', 4),
        frame(3, 'image_delta', 4),
        frame(4, 'image_keyframe', 4),
        frame(5, 'image_delta', 4),
      ],
      maxWindowFrames: 3,
      maxWindowBytes: 12,
    });

    expect(result.frames.map((item) => [item.sequence, item.payloadKind])).toEqual([
      [1, 'image_keyframe'],
      [4, 'image_keyframe'],
      [5, 'image_delta'],
    ]);
    expect(result.framesDropped).toBe(2);
    expect(result.bytesDropped).toBe(8);
    expect(result.requiresKeyframeResync).toBe(false);
  });

  it('discards an incomplete delta chain and requires a fresh keyframe', () => {
    const result = applyMachineLiveStreamDropPolicy({
      frames: [frame(1, 'image_keyframe', 3), frame(2, 'image_delta', 3), frame(3, 'image_delta', 3)],
      maxWindowFrames: 2,
      maxWindowBytes: 6,
    });
    expect(result.frames).toEqual([]);
    expect(result.bytesDropped).toBe(9);
    expect(result.requiresKeyframeResync).toBe(true);
  });

  it('requires keyframe resync when pressure leaves no keyframe', () => {
    const result = applyMachineLiveStreamDropPolicy({
      frames: [
        frame(2, 'image_delta', 4),
        frame(3, 'image_delta', 4),
      ],
      maxWindowFrames: 1,
      maxWindowBytes: 4,
    });

    expect(result.frames).toEqual([]);
    expect(result.requiresKeyframeResync).toBe(true);
  });
});
