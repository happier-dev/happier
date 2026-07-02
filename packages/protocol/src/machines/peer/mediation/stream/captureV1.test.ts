import { describe, expect, it } from 'vitest';

describe('Machine live-stream capture metadata V1', () => {
  it('validates a registered capture source with codec and control capabilities', async () => {
    const mod = await import('./captureV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('MachineLiveStreamCaptureSourceV1Schema');
    if (!('MachineLiveStreamCaptureSourceV1Schema' in mod)) return;

    const parsed = mod.MachineLiveStreamCaptureSourceV1Schema.parse({
      v: 1,
      sourceId: 'source_1',
      sourceKind: 'simulator',
      displayName: 'iPhone 16 Pro',
      supportedCodecs: ['image.mjpeg', 'h264.avcc'],
      maxWidth: 1290,
      maxHeight: 2796,
      maxFramesPerSecond: 30,
      inputMode: 'exclusive',
      sidebands: ['accessibility_tree', 'logs', 'capture_health'],
      health: {
        status: 'available',
      },
    });

    expect(parsed).toMatchObject({
      sourceId: 'source_1',
      supportedCodecs: ['image.mjpeg', 'h264.avcc'],
      inputMode: 'exclusive',
    });
  });

  it('rejects capture diagnostics that include frame payload material', async () => {
    const mod = await import('./captureV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('MachineLiveStreamCaptureUnavailableV1Schema');
    if (!('MachineLiveStreamCaptureUnavailableV1Schema' in mod)) return;

    const result = mod.MachineLiveStreamCaptureUnavailableV1Schema.safeParse({
      v: 1,
      sourceId: 'source_1',
      reasonCode: 'capture_unavailable',
      payloadBase64: 'AQID',
    });

    expect(result.success).toBe(false);
  });
});
