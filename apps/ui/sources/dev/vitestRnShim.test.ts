import { describe, expect, it } from 'vitest';

describe('vitestRnShim', () => {
    it('resolves aliased asset requires in Node test runtime', () => {
        const asset = (globalThis as any).require('@/assets/images/logo-black.png');
        expect(typeof asset).toBe('string');
        expect(asset).toContain('logo-black.png');
    });

    it('fails loudly for non-asset aliased requires outside the allowlist', () => {
        expect(() => (globalThis as any).require('@/sync/storageStore')).toThrow(
            /Unsupported alias require/i,
        );
    });

    it('names the escaping first-party require when a relative source require fails to load', () => {
        // `require()` inside a Vite-transformed first-party module is Node's CJS require
        // (vite-node injects `createRequire(<module href>)`), so it loads the target through
        // Node's loader instead of the Vitest module graph. Its transitive React Native /
        // Expo / workspace imports then bypass every Vitest alias and stub. When that fails,
        // the raw loader error names an unrelated dependency, so the shim must name the
        // require that actually escaped.
        expect(() => require('../sync/sync.ts')).toThrow(
            /\[vitestRnShim\] require\("\.\.\/sync\/sync\.ts"\)/,
        );
    });

    it('stubs posthog-react-native requires in the Node test runtime', () => {
        const posthogModule = (globalThis as any).require('posthog-react-native') as {
            __isHappierPostHogReactNativeStub?: unknown;
            default?: unknown;
            PostHogProvider?: unknown;
        };

        expect(posthogModule.__isHappierPostHogReactNativeStub).toBe(true);
        expect(typeof posthogModule.default).toBe('function');
        expect(typeof posthogModule.PostHogProvider).toBe('function');
    });

    it('stubs lazy Expo notification and task-manager requires in the Node test runtime', () => {
        const notifications = (globalThis as any).require('expo-notifications') as {
            registerTaskAsync?: unknown;
        };
        const taskManager = (globalThis as any).require('expo-task-manager') as {
            isTaskRegisteredAsync?: unknown;
        };

        expect(typeof notifications.registerTaskAsync).toBe('function');
        expect(typeof taskManager.isTaskRegisteredAsync).toBe('function');
    });
});
