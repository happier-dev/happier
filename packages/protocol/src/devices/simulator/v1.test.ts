import { describe, expect, it } from 'vitest';

describe('Simulator device protocol V1', () => {
  it('validates simulator resources with platform, device id, app id, and capture capabilities', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const parsed = mod.SimulatorDeviceResourceV1Schema.parse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      appId: 'dev.happier.app',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
      },
    });

    expect(parsed.platform).toBe('ios');
    expect(parsed.capture.supportedCodecs).toEqual(['image.mjpeg']);
  });

  it('rejects ad hoc simulator sideband fields outside typed schemas', async () => {
    const mod = await import('./v1').catch((error: unknown) => ({ importError: error }));

    expect(mod).toHaveProperty('SimulatorDeviceResourceV1Schema');
    if (!('SimulatorDeviceResourceV1Schema' in mod)) return;

    const result = mod.SimulatorDeviceResourceV1Schema.safeParse({
      v: 1,
      simulatorId: 'sim_1',
      platform: 'ios',
      deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
      displayName: 'iPhone 16 Pro',
      capture: {
        sourceId: 'sim_1:screen',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        rawSideband: { logs: true },
      },
      rawSideband: { logs: true },
    });

    expect(result.success).toBe(false);
  });
});
