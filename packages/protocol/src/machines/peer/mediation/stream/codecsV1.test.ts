import { describe, expect, it } from 'vitest';

describe('Machine live-stream codec negotiation V1', () => {
  it('chooses the mandatory image baseline when H.264 is unavailable', async () => {
    const mod = await import('./codecsV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('negotiateMachineLiveStreamCodecV1');
    if (!('negotiateMachineLiveStreamCodecV1' in mod)) return;

    const result = mod.negotiateMachineLiveStreamCodecV1({
      sourceCodecs: ['image.mjpeg'],
      viewerCodecs: ['image.mjpeg', 'h264.avcc'],
      preferredCodec: 'h264.avcc',
    });

    expect(result).toEqual({
      ok: true,
      codecId: 'image.mjpeg',
      fallbackReason: 'preferred_codec_unavailable',
    });
  });

  it('rejects H.264 AVCC payloads unless H.264 was negotiated', async () => {
    const mod = await import('./codecsV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('validateMachineLiveStreamPayloadCodecV1');
    if (!('validateMachineLiveStreamPayloadCodecV1' in mod)) return;

    expect(mod.validateMachineLiveStreamPayloadCodecV1({
      negotiatedCodecId: 'image.mjpeg',
      payload: {
        v: 1,
        streamId: 'stream_1',
        sequence: 1,
        timestampMs: 1_000,
        codecId: 'h264.avcc',
        payloadKind: 'h264_avcc',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
        keyframe: true,
      },
    })).toEqual({
      ok: false,
      reasonCode: 'codec_not_negotiated',
    });
  });

  it('documents the length-prefixed AVCC envelope tags used by viewers', async () => {
    const mod = await import('./codecsV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1');
    expect(mod).toHaveProperty('resolveMachineLiveStreamAvccChunkTypeV1');
    expect(mod).toHaveProperty('buildMachineLiveStreamAvcCodecStringV1');
    if (
      !('MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1' in mod)
      || !('resolveMachineLiveStreamAvccChunkTypeV1' in mod)
      || !('buildMachineLiveStreamAvcCodecStringV1' in mod)
    ) return;

    expect(mod.MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1).toEqual({
      description: 0x01,
      keyframe: 0x02,
      delta: 0x03,
      seed: 0x04,
    });
    expect(mod.resolveMachineLiveStreamAvccChunkTypeV1(0x02)).toBe('keyframe');
    expect(mod.resolveMachineLiveStreamAvccChunkTypeV1(0xff)).toBeNull();
    expect(mod.buildMachineLiveStreamAvcCodecStringV1(new Uint8Array([1, 0x64, 0, 0x28]))).toBe('avc1.640028');
    expect(mod.buildMachineLiveStreamAvcCodecStringV1(new Uint8Array([1]))).toBe('avc1.42E01E');
  });
});
