import { describe, expect, it } from 'vitest';

import { definePluginUiSurface } from './targets.js';

describe('plugin UI target declarations', () => {
  it('preserves declared contribution ids and fallback metadata', () => {
    const surface = definePluginUiSurface({
      id: 'review-panel',
      hostApi: {
        minVersion: '1.0.0',
        methods: ['requestSessionResource', 'subscribeResource', 'dispatchAction'],
      },
      targets: {
        descriptor: { contributionId: 'review-summary-card' },
        hostedWeb: { contributionId: 'review-panel-web' },
        reactNative: { contributionId: 'review-panel-native', optional: true },
      },
      fallback: { kind: 'hostRenderer', rendererId: 'pluginDescriptorFallback' },
    });

    expect(surface.targets.hostedWeb?.contributionId).toBe('review-panel-web');
    expect(surface.targets.reactNative?.optional).toBe(true);
    expect(surface.fallback).toEqual({
      kind: 'hostRenderer',
      rendererId: 'pluginDescriptorFallback',
    });
  });

  it('rejects removed embedded-web target declarations', () => {
    expect(() => definePluginUiSurface({
      id: 'removed-embedded-web',
      hostApi: {
        minVersion: '1.0.0',
        methods: ['dispatchAction'],
      },
      targets: {
        descriptor: { contributionId: 'fallback' },
        embeddedWeb: { contributionId: 'removed-embedded-web' },
      },
      fallback: { kind: 'descriptor', contributionId: 'fallback' },
    } as never)).toThrow();
  });

  it('rejects executable target declarations without a descriptor or hosted fallback', () => {
    expect(() => definePluginUiSurface({
      id: 'native-only',
      hostApi: {
        minVersion: '1.0.0',
        methods: ['dispatchAction'],
      },
      targets: {
        reactNative: { contributionId: 'native-only' },
      },
    })).toThrow(/fallback/);
  });
});
