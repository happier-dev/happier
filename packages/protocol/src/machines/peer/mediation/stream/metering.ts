import {
  getMachineLiveStreamPayloadDecodedByteLength,
  type MachineLiveStreamCapsV1,
  type MachineLiveStreamFrameV1,
  type MachineLiveStreamWireFrameV1,
} from './v1.js';

export type MachineLiveStreamCapReasonCode =
  | 'max_frame_bytes_exceeded'
  | 'max_duration_ms_exceeded'
  | 'max_total_bytes_exceeded'
  | 'max_frames_per_second_exceeded'
  | 'max_bitrate_bps_exceeded';

export type MachineLiveStreamMeterSnapshot = Readonly<{
  bytesSent: number;
  framesSent: number;
  movingBitrateBps: number;
  framesPerSecond: number;
}>;

export type MachineLiveStreamMeterResult =
  | Readonly<{ ok: true; metering: MachineLiveStreamMeterSnapshot }>
  | Readonly<{ ok: false; reasonCode: MachineLiveStreamCapReasonCode; metering: MachineLiveStreamMeterSnapshot }>;

type FrameSample = Readonly<{
  atMs: number;
  bytes: number;
  mediaFrame: boolean;
}>;

function sumRecent(samples: readonly FrameSample[], nowMs: number): Readonly<{ bytes: number; frames: number }> {
  const windowStartMs = nowMs - 999;
  let bytes = 0;
  let frames = 0;
  for (const sample of samples) {
    if (sample.atMs < windowStartMs) continue;
    bytes += sample.bytes;
    if (sample.mediaFrame) frames += 1;
  }
  return { bytes, frames };
}

export function createMachineLiveStreamMeter(input: Readonly<{
  caps: MachineLiveStreamCapsV1;
  startedAtMs: number;
}>): Readonly<{
  recordFrame: (frame: MachineLiveStreamFrameV1, nowMs: number) => MachineLiveStreamMeterResult;
}> {
  const samples: FrameSample[] = [];
  let bytesSent = 0;
  let framesSent = 0;

  const snapshot = (nowMs: number, nextBytes = 0, nextFrame = 0, nextMediaFrame = nextFrame): MachineLiveStreamMeterSnapshot => {
    const recent = sumRecent(samples, nowMs);
    const bytes = recent.bytes + nextBytes;
    const frames = recent.frames + nextMediaFrame;
    return {
      bytesSent: bytesSent + nextBytes,
      framesSent: framesSent + nextFrame,
      movingBitrateBps: bytes * 8,
      framesPerSecond: frames,
    };
  };

  return {
    recordFrame: (frame, nowMs) => {
      const frameBytes = getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
      if (typeof input.caps.maxFrameBytes === 'number' && frameBytes > input.caps.maxFrameBytes) {
        return { ok: false, reasonCode: 'max_frame_bytes_exceeded', metering: snapshot(nowMs) };
      }
      if (typeof input.caps.maxDurationMs === 'number' && nowMs - input.startedAtMs > input.caps.maxDurationMs) {
        return { ok: false, reasonCode: 'max_duration_ms_exceeded', metering: snapshot(nowMs) };
      }

      // Metadata uses the same byte budgets and transport credit as media, but status changes
      // are not image cadence. framesSent remains the count of all admitted transport frames.
      const mediaFrame = frame.payloadKind !== 'metadata';
      const nextSnapshot = snapshot(nowMs, frameBytes, 1, mediaFrame ? 1 : 0);
      if (typeof input.caps.maxFramesPerSecond === 'number' && nextSnapshot.framesPerSecond > input.caps.maxFramesPerSecond) {
        return { ok: false, reasonCode: 'max_frames_per_second_exceeded', metering: snapshot(nowMs) };
      }
      if (typeof input.caps.maxBitrateBps === 'number' && nextSnapshot.movingBitrateBps > input.caps.maxBitrateBps) {
        return { ok: false, reasonCode: 'max_bitrate_bps_exceeded', metering: snapshot(nowMs) };
      }
      if (typeof input.caps.maxTotalBytes === 'number' && nextSnapshot.bytesSent > input.caps.maxTotalBytes) {
        return { ok: false, reasonCode: 'max_total_bytes_exceeded', metering: snapshot(nowMs) };
      }

      samples.push({ atMs: nowMs, bytes: frameBytes, mediaFrame });
      while (samples.length > 0 && samples[0]!.atMs < nowMs - 999) {
        samples.shift();
      }
      bytesSent += frameBytes;
      framesSent += 1;
      return { ok: true, metering: nextSnapshot };
    },
  };
}

export function applyMachineLiveStreamDropPolicy<TFrame extends MachineLiveStreamFrameV1 | MachineLiveStreamWireFrameV1>(input: Readonly<{
  frames: readonly TFrame[];
  maxWindowFrames: number;
  maxWindowBytes: number;
}>): Readonly<{
  frames: readonly TFrame[];
  framesDropped: number;
  bytesDropped: number;
  requiresKeyframeResync: boolean;
}> {
  const frames = [...input.frames];
  let framesDropped = 0;
  let bytesDropped = 0;

  const frameBytes = (frame: MachineLiveStreamFrameV1 | MachineLiveStreamWireFrameV1) => {
    const payloadBase64 = 'payloadBase64' in frame ? frame.payloadBase64
      : frame.payload.t === 'plain' ? frame.payload.v : frame.payload.c;
    return getMachineLiveStreamPayloadDecodedByteLength(payloadBase64);
  };
  const totalBytes = () => frames.reduce((sum, frame) => sum + frameBytes(frame), 0);
  const overLimit = () => frames.length > input.maxWindowFrames || totalBytes() > input.maxWindowBytes;
  const dropFrame = (index: number): void => {
    const [dropped] = frames.splice(index, 1);
    if (!dropped) return;
    framesDropped += 1;
    bytesDropped += frameBytes(dropped);
  };

  while (frames.length > 0 && overLimit()) {
    let dropIndex = frames.findIndex((frame) => frame.payloadKind === 'image_delta');
    if (dropIndex >= 0) {
      const nextKeyframeIndex = frames.findIndex((frame, index) => index > dropIndex && frame.payloadKind === 'image_keyframe');
      // A dropped delta invalidates its dependent tail. Only a later keyframe can
      // establish a new baseline; an older retained keyframe cannot repair the gap.
      if (nextKeyframeIndex < 0) {
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          if (frames[index]?.payloadKind !== 'metadata') dropFrame(index);
        }
      } else {
        for (let index = nextKeyframeIndex - 1; index >= dropIndex; index -= 1) {
          if (frames[index]?.payloadKind === 'image_delta') dropFrame(index);
        }
      }
      continue;
    }
    if (dropIndex < 0) {
      const newestKeyframeIndex = (() => {
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          if (frames[index]?.payloadKind === 'image_keyframe') return index;
        }
        return -1;
      })();
      dropIndex = newestKeyframeIndex > 0 ? 0 : frames.length - 1;
    }
    dropFrame(dropIndex);
  }

  return {
    frames,
    framesDropped,
    bytesDropped,
    requiresKeyframeResync: !frames.some((frame) => frame.payloadKind === 'image_keyframe'),
  };
}
