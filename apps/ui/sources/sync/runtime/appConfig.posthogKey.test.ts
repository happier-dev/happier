import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep logs quiet in unit tests.
(globalThis as any).__DEV__ = false;

const manifestApp = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({
    default: {
        get expoConfig() {
            return { extra: { app: manifestApp.value } };
        },
    },
}));

import { loadAppConfig } from './appConfig';

describe('loadAppConfig (PostHog key)', () => {
    const previous = {
        key: process.env.EXPO_PUBLIC_POSTHOG_KEY,
        apiKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
    };

    afterEach(() => {
        manifestApp.value = {};
        if (previous.key === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_KEY = previous.key;
        if (previous.apiKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = previous.apiKey;
    });

    it('uses the key app.config.js resolved for this build', () => {
        manifestApp.value = { identityVariant: 'production', postHogKey: 'phc_build' };

        expect(loadAppConfig().postHogKey).toBe('phc_build');
    });

    it('does not add the shared key a bundle inlines to a build that resolved none', () => {
        manifestApp.value = { identityVariant: 'preview' };
        process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_shared';
        process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_shared_alias';

        expect(loadAppConfig().postHogKey).toBeUndefined();
    });
});
