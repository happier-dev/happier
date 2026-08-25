import { describe, expect, it } from 'vitest';

import {
  deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1,
  type DaemonPluginReactNativeBundleCacheIdentityV1,
} from './contributionRegistryProjection.js';

const BASE_IDENTITY: DaemonPluginReactNativeBundleCacheIdentityV1 = {
  pluginId: 'acme.preview',
  contributionId: 'native-preview',
  artifactDigest: `sha256:${'b'.repeat(64)}`,
  hostAppVersion: '2.0.0',
  hostUiApiVersion: '1.0.0',
  reactVersion: '19.0.0',
  reactNativeVersion: '0.83.4',
  expoRuntimeVersion: '0.2.0-native',
  hermesVersion: '0.15.0',
  platform: 'ios',
  channel: 'internal',
  nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
  projectionGeneration: 12,
};

const VARIANT_BY_FIELD: {
  readonly [K in keyof Required<DaemonPluginReactNativeBundleCacheIdentityV1>]:
    Required<DaemonPluginReactNativeBundleCacheIdentityV1>[K];
} = {
  pluginId: 'acme.other',
  contributionId: 'other-preview',
  artifactDigest: `sha256:${'d'.repeat(64)}`,
  hostAppVersion: '2.0.1',
  hostUiApiVersion: '1.1.0',
  reactVersion: '19.1.0',
  reactNativeVersion: '0.84.0',
  expoRuntimeVersion: '0.3.0-native',
  hermesVersion: '0.16.0',
  platform: 'android',
  channel: 'development',
  nativeCapabilitiesDigest: `sha256:${'e'.repeat(64)}`,
  projectionGeneration: 13,
};

describe('daemon React Native bundle cache identity', () => {
  it('derives one stable key from the complete Protocol-owned identity', () => {
    expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(BASE_IDENTITY)).toBe([
      'acme.preview',
      'native-preview',
      `sha256:${'b'.repeat(64)}`,
      '2.0.0',
      '1.0.0',
      '19.0.0',
      '0.83.4',
      '0.2.0-native',
      '0.15.0',
      'ios',
      'internal',
      `sha256:${'c'.repeat(64)}`,
      '12',
    ].join(':'));
  });

  it('binds every identity field into the cache key', () => {
    const baseKey = deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(BASE_IDENTITY);
    const fields = Object.keys(VARIANT_BY_FIELD) as ReadonlyArray<
      keyof DaemonPluginReactNativeBundleCacheIdentityV1
    >;

    expect(fields.length).toBe(Object.keys(BASE_IDENTITY).length);
    for (const field of fields) {
      expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1({
        ...BASE_IDENTITY,
        [field]: VARIANT_BY_FIELD[field],
      }), field).not.toBe(baseKey);
    }
  });

  it('separates an absent optional runtime version from a declared one', () => {
    const { expoRuntimeVersion: _expo, ...withoutExpo } = BASE_IDENTITY;

    expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(withoutExpo))
      .not.toBe(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(BASE_IDENTITY));
  });
});
