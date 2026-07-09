import { describe, expect, it } from 'vitest';

import { defineSurfaceContribution } from '../ui';
import { deriveReactNativeBundleCacheIdentityKey } from './reactNativeBundles';

describe('React Native bundle UI SDK helpers', () => {
    it('requires fallback-oriented RN bundle descriptors', () => {
        const descriptor = defineSurfaceContribution({
            mode: 'reactNative',
            contribution: {
                id: 'native-preview',
                bundle: {
                    platform: 'ios',
                    channel: 'internal',
                    integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
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
            },
        });

        expect(descriptor.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
    });

    it('derives cache identity keys from host and native runtime dimensions', () => {
        const base = {
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
        } as const;

        expect(deriveReactNativeBundleCacheIdentityKey(base)).toContain('sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
        expect(deriveReactNativeBundleCacheIdentityKey({
            ...base,
            hostAppVersion: '2.1.0',
        })).not.toBe(deriveReactNativeBundleCacheIdentityKey(base));
    });
});
