import { afterEach, describe, expect, it, vi } from 'vitest';

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

const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };

describe('loadAppConfig (PostHog key)', () => {
    const previous = {
        dev: globalWithDev.__DEV__,
        key: process.env.EXPO_PUBLIC_POSTHOG_KEY,
        apiKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
    };

    afterEach(() => {
        manifestApp.value = {};
        if (previous.dev === undefined) delete globalWithDev.__DEV__;
        else globalWithDev.__DEV__ = previous.dev;
        if (previous.key === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_KEY = previous.key;
        if (previous.apiKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = previous.apiKey;
    });

    it('uses the key app.config.js resolved for this build', () => {
        globalWithDev.__DEV__ = false;
        manifestApp.value = { identityVariant: 'production', postHogKey: 'phc_build' };

        expect(loadAppConfig().postHogKey).toBe('phc_build');
    });

    it('does not add the shared key a bundle inlines to a build that resolved none', () => {
        globalWithDev.__DEV__ = false;
        manifestApp.value = { identityVariant: 'preview' };
        process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_shared';
        process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_shared_alias';

        expect(loadAppConfig().postHogKey).toBeUndefined();
    });
});
