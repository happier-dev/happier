import { describe, expect, it } from 'vitest';

import { definePluginUiCompatibility } from './compatibility.js';

describe('plugin UI compatibility metadata', () => {
  it('normalizes host, React, React Native, platform, and channel requirements', () => {
    expect(definePluginUiCompatibility({
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      expoRuntimeVersion: '0.2.0-native',
      platforms: ['ios', 'android'],
      channels: ['development', 'internal'],
    })).toEqual({
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      expoRuntimeVersion: '0.2.0-native',
      platforms: ['ios', 'android'],
      channels: ['development', 'internal'],
    });
  });
});
