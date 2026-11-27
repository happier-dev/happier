import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { app: {} } } } }));

import { loadAppConfig } from './appConfig';

const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };

const ENV_KEYS = [
    'EXPO_PUBLIC_HAPPIER_SERVER_URL',
    'EXPO_PUBLIC_HAPPY_SERVER_URL',
    'EXPO_PUBLIC_SERVER_URL',
    'EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES',
    'EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES',
    'EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES',
] as const;

describe('loadAppConfig env aliases', () => {
    let previousDev: boolean | undefined;
    const previousEnv = new Map<string, string | undefined>();

    beforeEach(() => {
        previousDev = globalWithDev.__DEV__;
        globalWithDev.__DEV__ = false;
        for (const key of ENV_KEYS) {
            previousEnv.set(key, process.env[key]);
            delete process.env[key];
        }
    });

    afterEach(() => {
        if (previousDev === undefined) delete globalWithDev.__DEV__;
        else globalWithDev.__DEV__ = previousDev;
        for (const key of ENV_KEYS) {
            const value = previousEnv.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it.each([
        {
            name: 'prefers the canonical server url over legacy aliases',
            env: {
                EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://canonical.example.test',
                EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://legacy-happy.example.test',
                EXPO_PUBLIC_SERVER_URL: 'https://legacy-generic.example.test',
            },
            read: (c: ReturnType<typeof loadAppConfig>) => c.serverUrl,
            expected: 'https://canonical.example.test',
        },
        {
            name: 'uses the HAPPY server url alias when canonical is missing',
            env: {
                EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://legacy-happy.example.test',
                EXPO_PUBLIC_SERVER_URL: 'https://legacy-generic.example.test',
            },
            read: (c: ReturnType<typeof loadAppConfig>) => c.serverUrl,
            expected: 'https://legacy-happy.example.test',
        },
        {
            name: 'uses the generic server url alias last',
            env: { EXPO_PUBLIC_SERVER_URL: 'https://legacy-generic.example.test' },
            read: (c: ReturnType<typeof loadAppConfig>) => c.serverUrl,
            expected: 'https://legacy-generic.example.test',
        },
        {
            name: 'uses the canonical files preview limit',
            env: {
                EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES: '123',
                EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES: '456',
                EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES: '789',
            },
            read: (c: ReturnType<typeof loadAppConfig>) => c.filesPreviewMaxBytes,
            expected: 123,
        },
        {
            name: 'falls back to the HAPPY files preview limit alias',
            env: {
                EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES: '456',
                EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES: '789',
            },
            read: (c: ReturnType<typeof loadAppConfig>) => c.filesPreviewMaxBytes,
            expected: 456,
        },
        {
            name: 'falls back to the generic files preview limit alias',
            env: { EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES: '789' },
            read: (c: ReturnType<typeof loadAppConfig>) => c.filesPreviewMaxBytes,
            expected: 789,
        },
    ])('$name', ({ env, read, expected }) => {
        Object.assign(process.env, env);
        expect(read(loadAppConfig())).toBe(expected);
    });
});
