import { describe, expect, it } from 'vitest';

import { defineReactNativeBundleUi } from './reactNativeBundles';

describe('React Native bundle UI SDK helpers', () => {
    it('requires fallback-oriented RN bundle descriptors', () => {
        const descriptor = defineReactNativeBundleUi({
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
        });

        expect(descriptor.fallback).toEqual({ kind: 'hostedWeb', contributionId: 'preview-web' });
    });
});
