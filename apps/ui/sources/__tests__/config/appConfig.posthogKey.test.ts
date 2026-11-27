import { getConfig } from '@expo/config';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ENV_KEYS = [
    'APP_ENV',
    'HAPPIER_APP_VARIANT_OVERRIDE',
    'EXPO_APP_LOCAL_CONFIG_PATH',
    'EXPO_PUBLIC_POSTHOG_KEY',
    'EXPO_PUBLIC_POSTHOG_API_KEY',
    'EXPO_PUBLIC_POSTHOG_KEY_INTERNALDEV',
    'EXPO_PUBLIC_POSTHOG_KEY_INTERNALPREVIEW',
    'EXPO_PUBLIC_POSTHOG_KEY_PUBLICDEV',
    'EXPO_PUBLIC_POSTHOG_KEY_PREVIEW',
] as const;

// app.config.js reads the environment when it is evaluated, so each read evaluates it again.
function clearDynamicConfigModuleCache(): void {
    const nodeRequire = createRequire(import.meta.url);
    for (const file of ['app.config.js', 'appVariantConfig.cjs']) {
        delete nodeRequire.cache[nodeRequire.resolve(join(UI_DIR, file))];
    }
}

function postHogKeyFor(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): unknown {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    try {
        clearDynamicConfigModuleCache();
        const exp = getConfig(UI_DIR, { skipSDKVersionRequirement: true, isPublicConfig: true }).exp;
        return (exp.extra?.app as { postHogKey?: unknown } | undefined)?.postHogKey;
    } finally {
        for (const key of ENV_KEYS) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

describe('app.config.js PostHog key per build identity', () => {
    it('gives production (store) builds the shared key, including through its API_KEY alias', () => {
        expect(postHogKeyFor({ APP_ENV: 'production', EXPO_PUBLIC_POSTHOG_KEY: 'phc_shared' })).toBe('phc_shared');
        expect(postHogKeyFor({ APP_ENV: 'production', EXPO_PUBLIC_POSTHOG_API_KEY: 'phc_alias' })).toBe('phc_alias');
    });

    it('gives dev and preview builds no key from the shared variable', () => {
        for (const appEnv of ['development', 'internalpreview', 'publicdev', 'preview']) {
            expect(postHogKeyFor({ APP_ENV: appEnv, EXPO_PUBLIC_POSTHOG_KEY: 'phc_shared' })).toBeUndefined();
        }
    });

    it('gives a dev or preview build the key configured for that identity only', () => {
        expect(postHogKeyFor({
            APP_ENV: 'preview',
            EXPO_PUBLIC_POSTHOG_KEY: 'phc_shared',
            EXPO_PUBLIC_POSTHOG_KEY_PREVIEW: 'phc_preview',
            EXPO_PUBLIC_POSTHOG_KEY_PUBLICDEV: 'phc_publicdev',
        })).toBe('phc_preview');
        expect(postHogKeyFor({ APP_ENV: 'publicdev', EXPO_PUBLIC_POSTHOG_KEY_PREVIEW: 'phc_preview' })).toBeUndefined();
    });
});
