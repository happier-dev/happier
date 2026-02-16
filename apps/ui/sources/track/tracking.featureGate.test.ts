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
    config: { postHogKey: 'ph_test_key' },
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
});

