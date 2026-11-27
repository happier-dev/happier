import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep logs quiet in unit tests.
(globalThis as any).__DEV__ = false;

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { app: {} } } } }));

const ENV_KEYS = ['EXPO_PUBLIC_POSTHOG_KEY', 'EXPO_PUBLIC_POSTHOG_API_KEY', 'EXPO_PUBLIC_POSTHOG_HOST'] as const;

function stubWebRuntimeConfig(runtimeConfig: Record<string, unknown> | undefined): void {
    vi.stubGlobal('window', { location: { hostname: 'app.example.test' }, __HAPPIER_WEB_RUNTIME_CONFIG__: runtimeConfig });
    vi.stubGlobal('document', {});
}

describe('loadAppConfig (PostHog from the web runtime config)', () => {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    beforeEach(() => {
        for (const key of ENV_KEYS) delete process.env[key];
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        for (const key of ENV_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });

    it('prefers the container-start key and host over build-time values', async () => {
        process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_build_time';
        process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://build.posthog.example';
        stubWebRuntimeConfig({ serverUrl: '', posthogKey: ' phc_runtime ', posthogHost: 'https://runtime.posthog.example' });
        const { loadAppConfig } = await import('./appConfig');

        const config = loadAppConfig();

        expect(config.postHogKey).toBe('phc_runtime');
        expect(config.postHogHost).toBe('https://runtime.posthog.example');
    });

    it('configures analytics from the container-start key alone (generic image)', async () => {
        stubWebRuntimeConfig({ serverUrl: '', posthogKey: 'phc_runtime' });
        const { loadAppConfig } = await import('./appConfig');

        const config = loadAppConfig();

        expect(config.postHogKey).toBe('phc_runtime');
        expect(config.postHogHost).toBeUndefined();
    });

    it('keeps build-time values when the runtime config leaves them empty', async () => {
        process.env.EXPO_PUBLIC_POSTHOG_KEY = 'phc_build_time';
        process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://build.posthog.example';
        stubWebRuntimeConfig({ serverUrl: '', posthogKey: '', posthogHost: '' });
        const { loadAppConfig } = await import('./appConfig');

        const config = loadAppConfig();

        expect(config.postHogKey).toBe('phc_build_time');
        expect(config.postHogHost).toBe('https://build.posthog.example');
    });

    it('leaves analytics unconfigured when neither source sets a key', async () => {
        stubWebRuntimeConfig({ serverUrl: '' });
        const { loadAppConfig } = await import('./appConfig');

        const config = loadAppConfig();

        expect(config.postHogKey).toBeUndefined();
        expect(config.postHogHost).toBeUndefined();
    });

    it('ignores non-string runtime values', async () => {
        stubWebRuntimeConfig({ serverUrl: '', posthogKey: 42, posthogHost: { url: 'x' } });
        const { loadAppConfig } = await import('./appConfig');

        const config = loadAppConfig();

        expect(config.postHogKey).toBeUndefined();
        expect(config.postHogHost).toBeUndefined();
    });
});
