import { describe, expect, it } from 'vitest';

import { createReactNativeBundleReloadInvalidation } from './reactNativeBundles';

describe('React Native bundle runtime reload invalidation', () => {
    it('publishes generation-bound invalidation for installed artifacts and dev hot reload', () => {
        expect(createReactNativeBundleReloadInvalidation({
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            generation: 42,
            reason: 'devHotReload',
        })).toEqual({
            kind: 'plugin.ui.reactNativeBundle.invalidate',
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            generation: 42,
            reason: 'devHotReload',
        });
    });
});
