import { describe, expect, it } from 'vitest';

import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('device capabilities payload', () => {
  it('defaults simulator preview capabilities to disabled and unavailable', async () => {
    const mod = await import('./deviceCapabilities.js').catch(() => null);

    const result = mod?.DeviceCapabilitiesSchema.safeParse({});

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.simulatorPreview).toEqual({
        enabled: false,
        available: false,
        supportedPlatforms: [],
        availableDevices: [],
        captureSupported: false,
        inputSupported: false,
        sidebandKinds: [],
        disabledReasons: [],
      });
    }
  });

  it('carries unavailable simulator resources and disabled reasons as capabilities', async () => {
    const parsed = CapabilitiesSchema.parse({
      devices: {
        simulatorPreview: {
          enabled: true,
          available: false,
          supportedPlatforms: ['ios', 'android'],
          availableDevices: [
            {
              v: 1,
              simulatorId: 'sim_1',
              platform: 'ios',
              deviceId: 'E4B5B8D6-0000-0000-0000-000000000001',
              displayName: 'iPhone 16 Pro',
              capture: {
                status: 'unavailable',
                sourceId: 'sim_1:screen',
                reasonCode: 'ios_private_helper_unavailable',
              },
            },
          ],
          disabledReasons: ['pms_8_not_accepted', 'ios_private_helper_unavailable'],
        },
      },
    });

    expect(parsed.devices.simulatorPreview.available).toBe(false);
    expect(parsed.devices.simulatorPreview.availableDevices[0]?.capture).toEqual({
      status: 'unavailable',
      sourceId: 'sim_1:screen',
      reasonCode: 'ios_private_helper_unavailable',
    });
    expect(parsed.devices.simulatorPreview.disabledReasons).toEqual([
      'pms_8_not_accepted',
      'ios_private_helper_unavailable',
    ]);
  });

  it('normalizes simulator sideband capabilities to producer-backed kinds only', async () => {
    const parsed = CapabilitiesSchema.parse({
      devices: {
        simulatorPreview: {
          enabled: true,
          available: true,
          sidebandKinds: [
            'logs',
            'capture_health',
            'route',
            'accessibility_tree',
            'device_config',
            'app_metadata',
            'network_diagnostics',
            'capture_health',
            'future_sideband',
          ],
        },
      },
    });

    expect(parsed.devices.simulatorPreview.sidebandKinds).toEqual(['capture_health']);
  });

  it('preserves producer-backed simulator stream controls and filters unbacked input kinds', async () => {
    const parsed = CapabilitiesSchema.parse({
      devices: {
        simulatorPreview: {
          enabled: true,
          available: true,
          availableDevices: [
            {
              v: 1,
              simulatorId: 'sim_android',
              platform: 'android',
              deviceId: 'emulator-5554',
              displayName: 'Pixel 9',
              capture: {
                status: 'available',
                sourceId: 'source_android',
                supportedCodecs: ['h264.avcc'],
                inputMode: 'exclusive',
                supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'keyboard_key', 'hardware_button', 'orientation'],
                streamControls: {
                  requestKeyframe: true,
                  snapshot: true,
                  setQuality: true,
                  setFps: true,
                  setScale: true,
                },
              },
            },
          ],
        },
      },
    });

    expect(parsed.devices.simulatorPreview.availableDevices[0]?.capture).toMatchObject({
      status: 'available',
      supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'keyboard_key', 'hardware_button'],
      streamControls: {
        requestKeyframe: true,
        snapshot: true,
        setQuality: true,
        setFps: true,
        setScale: true,
      },
    });
  });
});
