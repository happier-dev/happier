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
