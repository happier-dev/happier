import { getConfig } from '@expo/config';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_EAS_PROJECT_ID = '2a550bd7-e4d2-4f59-ab47-dcb778775cee';
const DEFAULT_UPDATES_URL = `https://u.expo.dev/${DEFAULT_EAS_PROJECT_ID}`;

function getUiDir(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function withCleanEnv<T>(fn: () => T): T {
    const keys = [
        'APP_ENV',
        'EXPO_PUBLIC_EAS_PROJECT_ID',
        'EAS_PROJECT_ID',
        'EXPO_EAS_PROJECT_ID',
        'EXPO_UPDATES_URL',
        'EXPO_UPDATES_CHANNEL',
        'EXPO_APP_OWNER',
        'EXPO_APP_SLUG',
    ] as const;

    const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};
    for (const key of keys) {
        previous[key] = process.env[key];
        delete process.env[key];
    }
    try {
        return fn();
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

describe('app.config.js', () => {
    it('includes a default EAS project id so EAS can link dynamic configs', () => {
        const { exp } = withCleanEnv(() => {
            return getConfig(getUiDir(), { skipSDKVersionRequirement: true, isPublicConfig: true });
        });

        expect(exp.extra?.eas?.projectId).toBe(DEFAULT_EAS_PROJECT_ID);
        expect(exp.updates?.url).toBe(DEFAULT_UPDATES_URL);
        expect(exp.owner).toBe('happier-dev');
        expect(exp.slug).toBe('happier');
    });
});

