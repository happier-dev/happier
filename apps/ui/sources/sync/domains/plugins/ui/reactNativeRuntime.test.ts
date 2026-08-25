import { describe, expect, it } from 'vitest';

import { deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1 } from '@happier-dev/protocol';

describe('React Native runtime sync domain', () => {
    it('keys the daemon-owned cache identity without re-deciding runtime admission', () => {
        const identity = {
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            expoRuntimeVersion: '0.2.0-native',
            hermesVersion: '0.15.0',
            platform: 'ios',
            channel: 'internal',
            nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            projectionGeneration: 12,
        } as const;

        expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(identity)).toContain('sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
        expect(deriveDaemonPluginReactNativeBundleCacheIdentityKeyV1(identity)).toContain(':12');
    });
});
