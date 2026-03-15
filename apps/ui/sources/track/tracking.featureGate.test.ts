import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogConstructorSpy = vi.hoisted(() => vi.fn());

vi.mock('posthog-react-native', () => ({
    default: class PostHogMock {
        constructor(...args: any[]) {
            posthogConstructorSpy(...args);
        }
    },
}));

vi.mock('@/config', () => ({
    config: { postHogKey: 'ph_test_key', postHogHost: 'https://example.posthog.test' },
}));

describe('tracking (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        posthogConstructorSpy.mockClear();
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
        const args = posthogConstructorSpy.mock.calls[0] ?? [];
        expect(args[0]).toBe('ph_test_key');
        expect(args[1]).toEqual(expect.objectContaining({
            host: 'https://example.posthog.test',
        }));
    });
});
