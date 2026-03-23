import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };
let previousDev: boolean | undefined;

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { app: {} } } } }));

import { loadAppConfig } from './appConfig';

describe('loadAppConfig (server env aliases)', () => {
    beforeEach(() => {
        previousDev = globalWithDev.__DEV__;
        globalWithDev.__DEV__ = false;
    });

    afterEach(() => {
        if (previousDev === undefined) delete globalWithDev.__DEV__;
        else globalWithDev.__DEV__ = previousDev;
    });

    const previous = {
        canonical: process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL,
        legacyHappy: process.env.EXPO_PUBLIC_HAPPY_SERVER_URL,
        legacyGeneric: process.env.EXPO_PUBLIC_SERVER_URL,
    };

    const restore = () => {
        if (previous.canonical === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = previous.canonical;

        if (previous.legacyHappy === undefined) delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        else process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = previous.legacyHappy;

        if (previous.legacyGeneric === undefined) delete process.env.EXPO_PUBLIC_SERVER_URL;
        else process.env.EXPO_PUBLIC_SERVER_URL = previous.legacyGeneric;
    };

    it('prefers EXPO_PUBLIC_HAPPIER_SERVER_URL over legacy aliases', () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = 'https://canonical.example.test';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';
        try {
            expect(loadAppConfig().serverUrl).toBe('https://canonical.example.test');
        } finally {
            restore();
        }
    });

    it('uses EXPO_PUBLIC_HAPPY_SERVER_URL when canonical env is missing', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'https://legacy-happy.example.test';
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';
        try {
            expect(loadAppConfig().serverUrl).toBe('https://legacy-happy.example.test');
        } finally {
            restore();
        }
    });

    it('uses EXPO_PUBLIC_SERVER_URL when both happier and happy aliases are missing', () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        process.env.EXPO_PUBLIC_SERVER_URL = 'https://legacy-generic.example.test';
        try {
            expect(loadAppConfig().serverUrl).toBe('https://legacy-generic.example.test');
        } finally {
            restore();
        }
    });
});
