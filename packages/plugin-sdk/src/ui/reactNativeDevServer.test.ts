import { describe, expect, it } from 'vitest';

import { defineReactNativeBundleDevServer } from './reactNativeDevServer';

describe('React Native bundle dev server SDK helper', () => {
    it('binds dev hot reload to a local service and the canonical feature gate', () => {
        const binding = defineReactNativeBundleDevServer({
            contributionId: 'native-preview',
            platform: 'ios',
            service: {
                id: 'native-preview-dev-server',
                launch: {
                    kind: 'binary',
                    executablePath: 'native-preview-dev-server',
                    args: ['--host', '127.0.0.1'],
                },
                launchMode: {
                    kind: 'assignAndInject',
                    portPolicy: { kind: 'allocated', preferredPort: 8082 },
                    environment: { inject: ['PORT', 'HOST', 'HAPPIER_URL'] },
                },
                hostPolicy: { kind: 'loopback' },
                name: { strategy: 'derived', base: 'native-preview' },
                healthCheck: { kind: 'http', path: '/status' },
                restart: { kind: 'never' },
                cleanup: { staleAfterMs: 60_000 },
            },
        });

        expect(binding).toMatchObject({
            contributionId: 'native-preview',
            platform: 'ios',
            requiredFeatureId: 'plugins.ui.reactNativeBundles.devHotReload',
            devHotReload: {
                kind: 'reactNativeBundleDevHotReload',
                localServiceId: 'native-preview-dev-server',
                platform: 'ios',
            },
        });
        expect(binding.localService.id).toBe('native-preview-dev-server');
        expect(Object.isFrozen(binding)).toBe(true);
    });

    it('accepts a web platform binding (LEDGER DEC-6 RN-web dev-server variant)', () => {
        const binding = defineReactNativeBundleDevServer({
            contributionId: 'native-preview',
            platform: 'web',
            service: {
                id: 'native-preview-dev-server-web',
                launch: {
                    kind: 'binary',
                    executablePath: 'native-preview-dev-server',
                    args: ['--host', '127.0.0.1'],
                },
                launchMode: {
                    kind: 'assignAndInject',
                    portPolicy: { kind: 'allocated', preferredPort: 8083 },
                    environment: { inject: ['PORT', 'HOST', 'HAPPIER_URL'] },
                },
                hostPolicy: { kind: 'loopback' },
                name: { strategy: 'derived', base: 'native-preview-web' },
                healthCheck: { kind: 'http', path: '/status' },
                restart: { kind: 'never' },
                cleanup: { staleAfterMs: 60_000 },
            },
        });

        expect(binding).toMatchObject({
            platform: 'web',
            devHotReload: {
                kind: 'reactNativeBundleDevHotReload',
                localServiceId: 'native-preview-dev-server-web',
                platform: 'web',
            },
        });
    });
});
