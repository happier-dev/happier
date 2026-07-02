import { describe, expect, it } from 'vitest';

describe('Simulator input mapping V1', () => {
  it('maps normalized preview coordinates through orientation and letterboxing', async () => {
    const mod = await import('./inputV1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('mapSimulatorPreviewPointToDeviceV1');
    if (!('mapSimulatorPreviewPointToDeviceV1' in mod)) return;

    expect(mod.mapSimulatorPreviewPointToDeviceV1({
      x: 0.5,
      y: 0.5,
      orientation: 'portrait',
      viewport: { width: 400, height: 400 },
      content: { x: 100, y: 0, width: 200, height: 400 },
    })).toEqual({
      ok: true,
      x: 0.5,
      y: 0.5,
    });

    expect(mod.mapSimulatorPreviewPointToDeviceV1({
      x: 0.1,
      y: 0.5,
      orientation: 'portrait',
      viewport: { width: 400, height: 400 },
      content: { x: 100, y: 0, width: 200, height: 400 },
    })).toEqual({
      ok: false,
      reasonCode: 'outside_device_frame',
    });
  });
});
