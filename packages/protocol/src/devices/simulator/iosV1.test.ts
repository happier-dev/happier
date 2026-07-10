import { describe, expect, it } from 'vitest';

import {
  IosSimulatorAdapterCapabilitiesV1Schema,
  IosSimulatorAdapterHealthV1Schema,
} from './iosV1.js';

describe('iOS simulator adapter protocol', () => {
  it('describes the signed private-framework helper capability contract', () => {
    expect(IosSimulatorAdapterCapabilitiesV1Schema.parse({
      v: 1,
      platform: 'ios',
      usesPrivateFrameworks: true,
      helperDistribution: 'prebuilt-signed',
      requiredPrivateFrameworks: ['CoreSimulator', 'SimulatorKit'],
      supportedCodecs: ['image.mjpeg', 'h264.avcc'],
      supportedInputKinds: ['tap', 'swipe', 'keyboard_text', 'hardware_button'],
    })).toMatchObject({
      platform: 'ios',
      helperDistribution: 'prebuilt-signed',
    });
  });

  it('keeps private helper drift as a typed unavailable diagnostic', () => {
    expect(IosSimulatorAdapterHealthV1Schema.parse({
      v: 1,
      platform: 'ios',
      status: 'unavailable',
      reasonCode: 'private_framework_symbol_mismatch',
      diagnostics: [{
        code: 'missing_symbol',
        framework: 'SimulatorKit',
        symbol: 'IndigoHIDMessageForMouseNSEvent',
      }],
    })).toEqual({
      v: 1,
      platform: 'ios',
      status: 'unavailable',
      reasonCode: 'private_framework_symbol_mismatch',
      diagnostics: [{
        code: 'missing_symbol',
        framework: 'SimulatorKit',
        symbol: 'IndigoHIDMessageForMouseNSEvent',
      }],
    });
  });
});
