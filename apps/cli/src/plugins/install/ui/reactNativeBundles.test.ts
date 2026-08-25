import { describe, expect, it } from 'vitest';

import {
    deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1,
    type DaemonPluginReactNativeBundleCacheIdentityV1 as ReactNativeBundleCacheIdentity,
} from '@happier-dev/protocol';

import {
    deriveReactNativeNativeCapabilitiesDigest,
} from './reactNativeBundles';

const NATIVE_CAPABILITIES_DIGEST = deriveReactNativeNativeCapabilitiesDigest(['clipboard', 'haptics']);

const BASE_IDENTITY: ReactNativeBundleCacheIdentity = {
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
    nativeCapabilitiesDigest: NATIVE_CAPABILITIES_DIGEST,
    projectionGeneration: 12,
};

/**
 * One materially different value per cache-identity field. Typed as an
 * exhaustive record so a field added to `ReactNativeBundleCacheIdentity` cannot
 * be introduced without deciding how it varies — which is what forces the
 * participation assertion below to cover it.
 */
const VARIANT_BY_FIELD: {
    readonly [K in keyof Required<ReactNativeBundleCacheIdentity>]: Required<ReactNativeBundleCacheIdentity>[K];
} = {
    pluginId: 'acme.other',
    contributionId: 'other-preview',
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    hostAppVersion: '2.0.1',
    hostUiApiVersion: '1.1.0',
    reactVersion: '19.1.0',
    reactNativeVersion: '0.84.0',
    expoRuntimeVersion: '0.3.0-native',
    hermesVersion: '0.16.0',
    platform: 'android',
    channel: 'development',
    nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest(['clipboard']),
    projectionGeneration: 13,
};

describe('generated React Native artifact runtime identity', () => {
    it('derives the cache key from the artifact owner and the full host runtime identity', () => {
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
            NATIVE_CAPABILITIES_DIGEST,
            '12',
        ].join(':'));
    });

    // A field that stops participating lets two genuinely different host
    // runtimes share one cached artifact entry, so the wrong bundle is served
    // for the resolved runtime. The previous assertion here only matched the
    // owner prefix and still passed with ten of the thirteen fields removed.
    it('binds every cache-identity field into the derived runtime cache key', () => {
        const baseKey = deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(BASE_IDENTITY);
        const fields = Object.keys(VARIANT_BY_FIELD) as ReadonlyArray<keyof ReactNativeBundleCacheIdentity>;

        expect(fields.length).toBe(Object.keys(BASE_IDENTITY).length);
        for (const field of fields) {
            const mutated = { ...BASE_IDENTITY, [field]: VARIANT_BY_FIELD[field] };
            expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(mutated), field).not.toBe(baseKey);
        }
    });

    // `expoRuntimeVersion` / `hermesVersion` are optional and serialize as ''.
    // An absent value must not collide with a runtime that declares one.
    it('separates an absent optional runtime version from a declared one', () => {
        const { expoRuntimeVersion: _expo, ...withoutExpo } = BASE_IDENTITY;

        expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(withoutExpo))
            .not.toBe(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(BASE_IDENTITY));
    });
});
