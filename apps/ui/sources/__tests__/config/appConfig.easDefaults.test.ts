import { getConfig } from '@expo/config';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_EAS_PROJECT_ID = '2a550bd7-e4d2-4f59-ab47-dcb778775cee';
const DEFAULT_UPDATES_URL = `https://u.expo.dev/${DEFAULT_EAS_PROJECT_ID}`;

function getUiDir(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function getPublicConfig() {
    return getConfig(getUiDir(), { skipSDKVersionRequirement: true, isPublicConfig: true }).exp;
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
        'EXPO_APP_LOCAL_CONFIG_PATH',
        'EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV',
        'EXPO_PUBLIC_IOS_BACKGROUND_AUDIO',
        'EXPO_IOS_BACKGROUND_AUDIO',
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
        const exp = withCleanEnv(() => getPublicConfig());

        expect(exp.extra?.eas?.projectId).toBe(DEFAULT_EAS_PROJECT_ID);
        expect(exp.updates?.url).toBe(DEFAULT_UPDATES_URL);
        expect(exp.extra?.app?.variant).toBe('development');
        expect(exp.owner).toBe('happier-dev');
        expect(exp.slug).toBe('happier');
    });

    it('exposes variant under extra.app when APP_ENV is set', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });

        expect(exp.extra?.app?.variant).toBe('preview');
    });

    it('defaults EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV based on the app variant', () => {
        const envValue = withCleanEnv(() => {
            process.env.APP_ENV = 'production';
            getPublicConfig();
            return process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;
        });

        expect(envValue).toBe('production');
    });

    it('uses EXPO_PUBLIC_EAS_PROJECT_ID with highest precedence for updates linkage', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'public-project-id';
            process.env.EAS_PROJECT_ID = 'eas-project-id';
            process.env.EXPO_EAS_PROJECT_ID = 'expo-project-id';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('public-project-id');
        expect(exp.updates?.url).toBe('https://u.expo.dev/public-project-id');
    });

    it('uses EAS_PROJECT_ID when EXPO_PUBLIC_EAS_PROJECT_ID is unset', () => {
        const exp = withCleanEnv(() => {
            process.env.EAS_PROJECT_ID = 'eas-project-id';
            process.env.EXPO_EAS_PROJECT_ID = 'expo-project-id';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('eas-project-id');
        expect(exp.updates?.url).toBe('https://u.expo.dev/eas-project-id');
    });

    it('allows EXPO_UPDATES_URL override while keeping project id override intact', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_PUBLIC_EAS_PROJECT_ID = 'public-project-id';
            process.env.EXPO_UPDATES_URL = 'https://updates.example.test/custom';
            return getPublicConfig();
        });

        expect(exp.extra?.eas?.projectId).toBe('public-project-id');
        expect(exp.updates?.url).toBe('https://updates.example.test/custom');
    });

    it('allows owner and slug overrides for local variants', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_OWNER = 'example-owner';
            process.env.EXPO_APP_SLUG = 'example-slug';
            return getPublicConfig();
        });

        expect(exp.owner).toBe('example-owner');
        expect(exp.slug).toBe('example-slug');
        expect(exp.extra?.eas?.projectId).toBe(DEFAULT_EAS_PROJECT_ID);
    });

    it('enables iOS background audio by default in development', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'development';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: true })]);
    });

    it('enables iOS background audio by default in preview', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: true })]);
    });

    it('allows overriding iOS background audio via env', () => {
        const exp = withCleanEnv(() => {
            process.env.APP_ENV = 'preview';
            process.env.EXPO_PUBLIC_IOS_BACKGROUND_AUDIO = 'false';
            return getPublicConfig();
        });

        const plugin = (exp.plugins ?? []).find((entry: any) => Array.isArray(entry) && entry[0] === 'react-native-audio-api');
        expect(plugin).toEqual(['react-native-audio-api', expect.objectContaining({ iosBackgroundMode: false })]);
    });

    it('does not include unused optional native plugins in the default config', () => {
        const exp = withCleanEnv(() => getPublicConfig());
        const pluginNames = (exp.plugins ?? []).map((entry: any) => (Array.isArray(entry) ? entry[0] : entry));

        expect(pluginNames).not.toContain('expo-location');
        expect(pluginNames).not.toContain('expo-calendar');
    });

    it('includes iOS privacy purpose strings required by App Store static analysis', () => {
        const exp = withCleanEnv(() => getPublicConfig());

        expect(exp.ios?.infoPlist?.NSPhotoLibraryUsageDescription).toBeTruthy();
        expect(exp.ios?.infoPlist?.NSPhotoLibraryAddUsageDescription).toBeTruthy();
        expect(exp.ios?.infoPlist?.NSLocationWhenInUseUsageDescription).toBeTruthy();
    });

    it('applies app.local overrides when a local config file is provided', () => {
        const exp = withCleanEnv(() => {
            process.env.EXPO_APP_LOCAL_CONFIG_PATH = join(
                getUiDir(),
                'sources',
                '__tests__',
                'config',
                'fixtures',
                'app.local.fixture.cjs',
            );
            return getPublicConfig();
        });

        expect(exp.name).toBe('Happier (local override)');
        expect(exp.ios?.infoPlist?.NSPhotoLibraryUsageDescription).toBe(
            'Local override: access photos for sharing.',
        );
    });
});
