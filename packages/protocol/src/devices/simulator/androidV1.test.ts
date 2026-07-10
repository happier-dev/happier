import { describe, expect, it } from 'vitest';

import {
  AndroidSimulatorAdapterCapabilitiesV1Schema,
  AndroidSimulatorAdapterHealthV1Schema,
} from './androidV1.js';

describe('Android simulator adapter protocol', () => {
  it('describes the pinned scrcpy-compatible emulator bridge contract', () => {
    expect(AndroidSimulatorAdapterCapabilitiesV1Schema.parse({
      v: 1,
      platform: 'android',
      transport: 'scrcpy-local-sockets-over-pms',
      physicalDevicesSupported: false,
      supportedCodecs: ['h264.avcc', 'image.mjpeg'],
      supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'orientation'],
      clipboardSyncDefault: 'disabled',
    })).toMatchObject({
      platform: 'android',
      physicalDevicesSupported: false,
      clipboardSyncDefault: 'disabled',
    });
  });

  it('keeps physical devices disabled as a typed V1 unavailable diagnostic', () => {
    expect(AndroidSimulatorAdapterHealthV1Schema.parse({
      v: 1,
      platform: 'android',
      status: 'unavailable',
      reasonCode: 'physical_device_not_supported_v1',
      diagnostics: [{
        code: 'physical_device_detected',
        serial: 'device-123',
      }],
    })).toEqual({
      v: 1,
      platform: 'android',
      status: 'unavailable',
      reasonCode: 'physical_device_not_supported_v1',
      diagnostics: [{
        code: 'physical_device_detected',
        serial: 'device-123',
      }],
    });
  });
});
