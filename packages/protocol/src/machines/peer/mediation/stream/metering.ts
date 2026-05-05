import {
  getMachineLiveStreamPayloadDecodedByteLength,
  type MachineLiveStreamCapsV1,
  type MachineLiveStreamFrameV1,
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
}>;

function sumRecent(samples: readonly FrameSample[], nowMs: number): Readonly<{ bytes: number; frames: number }> {
  const windowStartMs = nowMs - 999;
  let bytes = 0;
  let frames = 0;
  for (const sample of samples) {
    if (sample.atMs < windowStartMs) continue;
    bytes += sample.bytes;
    frames += 1;
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

  const snapshot = (nowMs: number, nextBytes = 0, nextFrame = 0): MachineLiveStreamMeterSnapshot => {
    const recent = sumRecent(samples, nowMs);
    const bytes = recent.bytes + nextBytes;
    const frames = recent.frames + nextFrame;
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
      if (frameBytes > input.caps.maxFrameBytes) {
        return { ok: false, reasonCode: 'max_frame_bytes_exceeded', metering: snapshot(nowMs) };
      }
      if (nowMs - input.startedAtMs > input.caps.maxDurationMs) {
        return { ok: false, reasonCode: 'max_duration_ms_exceeded', metering: snapshot(nowMs) };
      }

      const nextSnapshot = snapshot(nowMs, frameBytes, 1);
      if (nextSnapshot.framesPerSecond > input.caps.maxFramesPerSecond) {
        return { ok: false, reasonCode: 'max_frames_per_second_exceeded', metering: snapshot(nowMs) };
      }
      if (nextSnapshot.movingBitrateBps > input.caps.maxBitrateBps) {
        return { ok: false, reasonCode: 'max_bitrate_bps_exceeded', metering: snapshot(nowMs) };
      }
      if (typeof input.caps.maxTotalBytes === 'number' && nextSnapshot.bytesSent > input.caps.maxTotalBytes) {
        return { ok: false, reasonCode: 'max_total_bytes_exceeded', metering: snapshot(nowMs) };
      }

      samples.push({ atMs: nowMs, bytes: frameBytes });
      while (samples.length > 0 && samples[0]!.atMs < nowMs - 999) {
        samples.shift();
      }
      bytesSent += frameBytes;
      framesSent += 1;
      return { ok: true, metering: nextSnapshot };
    },
  };
}

export function applyMachineLiveStreamDropPolicy(input: Readonly<{
  frames: readonly MachineLiveStreamFrameV1[];
  maxWindowFrames: number;
  maxWindowBytes: number;
}>): Readonly<{
  frames: readonly MachineLiveStreamFrameV1[];
  framesDropped: number;
  bytesDropped: number;
  requiresKeyframeResync: boolean;
}> {
  const frames = [...input.frames];
  let framesDropped = 0;
  let bytesDropped = 0;

  const frameBytes = (frame: MachineLiveStreamFrameV1) => getMachineLiveStreamPayloadDecodedByteLength(frame.payloadBase64);
  const totalBytes = () => frames.reduce((sum, frame) => sum + frameBytes(frame), 0);
  const overLimit = () => frames.length > input.maxWindowFrames || totalBytes() > input.maxWindowBytes;

  while (frames.length > 0 && overLimit()) {
    let dropIndex = frames.findIndex((frame) => frame.payloadKind === 'image_delta');
    if (dropIndex < 0) {
      const newestKeyframeIndex = (() => {
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          if (frames[index]?.payloadKind === 'image_keyframe') return index;
        }
        return -1;
      })();
      dropIndex = newestKeyframeIndex > 0 ? 0 : frames.length - 1;
    }
    const [dropped] = frames.splice(dropIndex, 1);
    if (!dropped) break;
    framesDropped += 1;
    bytesDropped += frameBytes(dropped);
  }

  return {
    frames,
    framesDropped,
    bytesDropped,
    requiresKeyframeResync: !frames.some((frame) => frame.payloadKind === 'image_keyframe'),
  };
}
