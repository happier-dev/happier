import { describe, expect, it } from 'vitest';

import { PluginUiHostApiMethodV1Schema } from '../../ui/hostApi.js';
import { PluginReactNativeBundleContributionV1Schema } from './reactNativeBundles.js';

const VALID_DIGEST = `sha256:${'b'.repeat(64)}`;

const validContribution = {
  id: 'native-preview',
  bundle: {
    platform: 'ios',
    channel: 'internal',
    integrity: { digest: VALID_DIGEST },
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
  it('allows local development hot-reload bundle declarations without immutable artifact integrity', () => {
    expect(PluginReactNativeBundleContributionV1Schema.parse({
      ...validContribution,
      bundle: {
        platform: 'ios',
        channel: 'development',
      },
      compatibility: {
        ...validContribution.compatibility,
        supportedChannels: ['development'],
      },
      policy: { allowDevHotReload: true },
    }).bundle).toEqual({
      platform: 'ios',
      channel: 'development',
    });
  });

  it('requires immutable installed bundle declarations to carry integrity', () => {
    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      bundle: {
        platform: 'ios',
        channel: 'internal',
        assetPath: 'dist/native/ios.bundle.js',
      },
    }).success).toBe(false);
  });

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

  it('accepts a web bundle platform (LEDGER DEC-6: reactNative mode also renders on web via react-native-web)', () => {
    const parsed = PluginReactNativeBundleContributionV1Schema.parse({
      ...validContribution,
      bundle: {
        ...validContribution.bundle,
        platform: 'web',
      },
      compatibility: {
        ...validContribution.compatibility,
        supportedPlatforms: ['web'],
      },
    });

    expect(parsed.bundle.platform).toBe('web');
  });

  it('rejects Hermes bytecode artifacts and a bundle platform absent from its own supportedPlatforms', () => {
    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      bundle: {
        ...validContribution.bundle,
        bytecode: {
          kind: 'hermes',
          hermesVersion: '0.15.0',
        },
      },
    }).success).toBe(false);

    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      compatibility: {
        ...validContribution.compatibility,
        supportedPlatforms: ['android'],
      },
    }).success).toBe(false);
  });

  it('uses the canonical plugin UI Host API method vocabulary for RN requirements', () => {
    const canonicalMethods = PluginUiHostApiMethodV1Schema.options;

    expect(PluginReactNativeBundleContributionV1Schema.parse({
      ...validContribution,
      hostApi: {
        minVersion: '1.0.0',
        methods: canonicalMethods,
      },
    }).hostApi.methods).toEqual(canonicalMethods);

    expect(PluginReactNativeBundleContributionV1Schema.safeParse({
      ...validContribution,
      hostApi: {
        minVersion: '1.0.0',
        methods: ['requestSessionResource', 'rawStoreAccess'],
      },
    }).success).toBe(false);
  });

  it('carries the RN bundle entry ABI while preserving legacy renderSurface defaults', () => {
    expect(PluginReactNativeBundleContributionV1Schema.parse({
      ...validContribution,
      entry: {
        containerName: 'acmeNativePreview',
        modulePath: './PluginPanel',
        exportName: 'PluginPanel',
      },
    }).entry).toEqual({
      containerName: 'acmeNativePreview',
      modulePath: './PluginPanel',
      exportName: 'PluginPanel',
    });

    expect(PluginReactNativeBundleContributionV1Schema.parse({
      ...validContribution,
      entry: {},
    }).entry).toEqual({
      modulePath: './renderSurface',
      exportName: 'renderSurface',
    });
  });
});
