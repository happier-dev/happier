import { describe, expect, it } from 'vitest';

import { PluginReactNativeBundleContributionV1Schema } from './reactNativeBundles.js';

const validContribution = {
  id: 'native-preview',
  bundle: {
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: 'sha256:bundle' },
  },
  entry: { exportName: 'renderSurface' },
  compatibility: {
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.79.0',
    supportedPlatforms: ['ios'],
    supportedChannels: ['internal'],
  },
  hostApi: { minVersion: '1.0.0' },
  fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
  display: { titleKey: 'preview.title' },
} as const;

describe('React Native bundle UI contributions', () => {
  it('requires bundle and source-map digests to use the executable artifact digest contract', () => {
    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      bundle: {
        ...validContribution.bundle,
        integrity: { digest: 'bundle' },
      },
    }).success).toBe(false);

    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      bundle: {
        ...validContribution.bundle,
        sourceMap: { digest: 'bundle-map' },
      },
    }).success).toBe(false);
  });
});
