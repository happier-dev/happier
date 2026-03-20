import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const globalWithDev = globalThis as typeof globalThis & { __DEV__?: boolean };
let previousDev: boolean | undefined;

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { app: {} } } } }));

import { loadAppConfig } from './appConfig';

describe('loadAppConfig (filesPreviewMaxBytes env)', () => {
    beforeEach(() => {
        previousDev = globalWithDev.__DEV__;
        globalWithDev.__DEV__ = false;
    });

    afterEach(() => {
        if (previousDev === undefined) delete globalWithDev.__DEV__;
        else globalWithDev.__DEV__ = previousDev;
    });

    const previous = {
        canonical: process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES,
        legacyHappy: process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES,
        legacyGeneric: process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES,
    };

    const restore = () => {
        if (previous.canonical === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES;
        else process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES = previous.canonical;

        if (previous.legacyHappy === undefined) delete process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES;
        else process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES = previous.legacyHappy;

        if (previous.legacyGeneric === undefined) delete process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES;
        else process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES = previous.legacyGeneric;
    };

    it('uses EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES when set', () => {
        process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES = '123';
        delete process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES;
        delete process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES;
        try {
            expect(loadAppConfig().filesPreviewMaxBytes).toBe(123);
        } finally {
            restore();
        }
    });
});
