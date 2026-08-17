import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogConstructorSpy = vi.hoisted(() => vi.fn<(apiKey: string, options?: Record<string, unknown>) => void>());
const posthogOptInSpy = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const posthogOptOutSpy = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const kvStore = vi.hoisted(() => new Map<string, string>());
const posthogConfig = vi.hoisted(() => ({
    postHogKey: 'ph_test_key',
    postHogHost: 'https://example.posthog.test' as string | undefined,
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }

        set(key: string, value: string) {
            kvStore.set(key, value);
        }

        delete(key: string) {
            kvStore.delete(key);
        }
    }

    return { MMKV };
});

vi.mock('posthog-react-native', () => ({
    default: class PostHogMock {
        constructor(apiKey: string, options?: Record<string, unknown>) {
            posthogConstructorSpy(apiKey, options);
        }

        optIn() {
            return posthogOptInSpy();
        }

        optOut() {
            return posthogOptOutSpy();
        }
    },
}));

vi.mock('@/config', () => ({
    config: posthogConfig,
}));

describe('tracking (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        posthogConstructorSpy.mockClear();
        posthogOptInSpy.mockClear();
        posthogOptOutSpy.mockClear();
        kvStore.clear();
        posthogConfig.postHogHost = 'https://example.posthog.test';
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.analytics';
    });

    afterEach(() => {
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('does not initialize PostHog when analytics are disabled by build policy', async () => {
        const mod = await import('./tracking');
        expect(mod.tracking).toBeNull();
        expect(posthogConstructorSpy).not.toHaveBeenCalled();
    });

    it('initializes PostHog with the configured host when analytics are allowed', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        vi.resetModules();

        await import('./tracking');
        expect(posthogConstructorSpy).toHaveBeenCalledTimes(1);
        const firstCall = posthogConstructorSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('expected PostHog constructor to be called');
        }
        const [apiKey, options] = firstCall;
        expect(apiKey).toBe('ph_test_key');
        expect(options).toEqual(expect.objectContaining({
            host: 'https://example.posthog.test',
        }));
        expect(posthogOptInSpy).toHaveBeenCalledTimes(1);
        expect(posthogOptOutSpy).not.toHaveBeenCalled();
    });

    it('defaults mobile analytics to the project PostHog region when no host is configured', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        posthogConfig.postHogHost = undefined;
        vi.resetModules();

        await import('./tracking');

        expect(posthogConstructorSpy).toHaveBeenCalledTimes(1);
        expect(posthogConstructorSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            host: 'https://eu.i.posthog.com',
        }));
    });

    it('applies persisted analytics opt-out before sync bootstrap runs', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = '';
        kvStore.set('settings', JSON.stringify({
            settings: { analyticsOptOut: true },
            version: 7,
        }));
        vi.resetModules();

        const mod = await import('./tracking');
        expect(mod.tracking).not.toBeNull();
        expect(posthogConstructorSpy).toHaveBeenCalledTimes(1);
        const firstCall = posthogConstructorSpy.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('expected PostHog constructor to be called');
        }
        const [, options] = firstCall;
        expect(options).toEqual(expect.objectContaining({
            defaultOptIn: false,
        }));
        expect(posthogOptOutSpy).toHaveBeenCalledTimes(1);
        expect(posthogOptInSpy).not.toHaveBeenCalled();
    });
});
