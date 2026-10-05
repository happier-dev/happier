import { describe, expect, it } from 'vitest';
import * as typedModule from './vitestRnShim.fixture';
import { loadVitestModuleForNodeRequire } from './vitestRnShim';

const nodeRuntime = globalThis as typeof globalThis & { require: (id: string) => unknown };

describe('vitestRnShim', () => {
    it('resolves aliased asset requires in Node test runtime', () => {
        const asset = nodeRuntime.require('@/assets/images/logo-black.png');
        expect(typeof asset).toBe('string');
        expect(asset).toContain('logo-black.png');
    });

    it('treats generated bundled Plugin UI CJS paths as Metro assets instead of executing them', () => {
        const request = '@happier-dev/plugins-channels/happier-plugin-ui/react-native/channels-app-native/entry.cjs.bundle';
        const asset = nodeRuntime.require(request);

        expect(asset).toBe(request);
    });

    it('fails loudly for non-asset aliased requires outside the allowlist', () => {
        expect(() => nodeRuntime.require('@/sync/storageStore')).toThrow(
            /Unsupported alias require/i,
        );
    });

    it('keeps relative CJS requires in the successfully imported Vitest module graph', async () => {
        const bridge = await loadVitestModuleForNodeRequire(
            new URL('./vitestRnShim.fixture.ts', import.meta.url),
            () => import('./vitestRnShim.fixture'),
        );
        try {
            const loaded: unknown = require('./vitestRnShim.fixture.ts');
            expect(loaded).toBe(typedModule);
            expect(loaded).toBe(bridge.module);
            expect(require('./vitestRnShim.fixture.ts')).toBe(loaded);
            expect(require('./vitestRnShim.fixture')).toBe(loaded);
        } finally {
            bridge.dispose();
        }
        expect(() => require('./vitestRnShim.fixture.ts')).toThrow();
    });

    it('does not expose partial exports from a rejected Vitest module evaluation', async () => {
        await expect(loadVitestModuleForNodeRequire(
            new URL('./vitestRnShim.failure.fixture.ts', import.meta.url),
            () => import('./vitestRnShim.failure.fixture'),
        )).rejects.toThrow('fixture evaluation failed');

        expect(() => require('./vitestRnShim.failure.fixture.ts')).toThrow();
    });

    it('names the escaping first-party require when a relative source require fails to load', () => {
        // `require()` inside a Vite-transformed first-party module is Node's CJS require
        // (vite-node injects `createRequire(<module href>)`), so it loads the target through
        // Node's loader instead of the Vitest module graph. This fixture rejects evaluation;
        // the shim must name the first-party require rather than report only the nested error.
        expect(() => require('./vitestRnShim.failure.fixture.ts')).toThrow(
            /\[vitestRnShim\] require\("\.\/vitestRnShim\.failure\.fixture\.ts"\)/,
        );
    });

    it('stubs posthog-react-native requires in the Node test runtime', () => {
        const posthogModule = nodeRuntime.require('posthog-react-native') as {
            __isHappierPostHogReactNativeStub?: unknown;
            default?: unknown;
            PostHogProvider?: unknown;
        };

        expect(posthogModule.__isHappierPostHogReactNativeStub).toBe(true);
        expect(typeof posthogModule.default).toBe('function');
        expect(typeof posthogModule.PostHogProvider).toBe('function');
    });

    it('stubs lazy Expo notification and task-manager requires in the Node test runtime', () => {
        const notifications = nodeRuntime.require('expo-notifications') as {
            registerTaskAsync?: unknown;
        };
        const taskManager = nodeRuntime.require('expo-task-manager') as {
            isTaskRegisteredAsync?: unknown;
        };

        expect(typeof notifications.registerTaskAsync).toBe('function');
        expect(typeof taskManager.isTaskRegisteredAsync).toBe('function');
    });
});
