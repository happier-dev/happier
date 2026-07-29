import { describe, expect, it } from 'vitest';

// Keep logs quiet in unit tests.
(globalThis as any).__DEV__ = false;

import { vi } from 'vitest';

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { app: {} } } } }));

import { loadAppConfig } from './appConfig';

describe('loadAppConfig (PostHog env aliases)', () => {
    const previous = {
        key: process.env.EXPO_PUBLIC_POSTHOG_KEY,
        apiKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
    };

    const restore = () => {
        if (previous.key === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_KEY = previous.key;

        if (previous.apiKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
        else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = previous.apiKey;
    };

    it('uses EXPO_PUBLIC_POSTHOG_API_KEY when EXPO_PUBLIC_POSTHOG_KEY is missing', () => {
        delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
        process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test_api_key';
        try {
            expect(loadAppConfig().postHogKey).toBe('phc_test_api_key');
        } finally {
            restore();
        }
    });

    it('prefers EXPO_PUBLIC_POSTHOG_KEY when both are set', () => {
        process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_test_key';
        process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test_api_key';
        try {
            expect(loadAppConfig().postHogKey).toBe('phc_test_key');
        } finally {
            restore();
        }
    });
});
