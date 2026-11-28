import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitSpy = vi.fn((..._args: unknown[]) => {});

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentryInitSpy(...args),
    close: async () => {},
    mobileReplayIntegration: () => ({ name: 'mobileReplayIntegration' }),
    captureMessage: () => 'sentry-test-event-id',
}));

vi.mock('@/config', () => ({
    config: { variant: 'preview' },
}));

const ENV_KEYS = ['EXPO_PUBLIC_SENTRY_DSN', 'EXPO_PUBLIC_SENTRY_ENVIRONMENT', 'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY'] as const;
const BUILD_DSN = 'https://buildKey@o0.ingest.sentry.io/1';
const RUNTIME_DSN = 'https://runtimeKey@o0.ingest.sentry.io/2';

function stubWebRuntimeConfig(runtimeConfig: Record<string, unknown> | undefined): void {
    vi.stubGlobal('window', { location: { hostname: 'app.example.test' }, __HAPPIER_WEB_RUNTIME_CONFIG__: runtimeConfig });
    vi.stubGlobal('document', {});
}

describe('utils/system/sentry (web runtime config)', () => {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    beforeEach(() => {
        sentryInitSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__ = false;
        for (const key of ENV_KEYS) delete process.env[key];
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        for (const key of ENV_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });

    it('prefers the container-start DSN and environment over build-time values', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = BUILD_DSN;
        process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = 'build-env';
        stubWebRuntimeConfig({ serverUrl: '', sentryDsn: RUNTIME_DSN, sentryEnvironment: 'production' });
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryInitSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({ dsn: RUNTIME_DSN, environment: 'production' }),
        );
    });

    it('starts Sentry from the container-start DSN alone (generic image)', async () => {
        stubWebRuntimeConfig({ serverUrl: '', sentryDsn: RUNTIME_DSN });
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryInitSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({ dsn: RUNTIME_DSN, environment: 'preview' }),
        );
    });

    it('keeps the build-time DSN when the runtime config leaves it empty', async () => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = BUILD_DSN;
        stubWebRuntimeConfig({ serverUrl: '', sentryDsn: '', sentryEnvironment: '' });
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryInitSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({ dsn: BUILD_DSN, environment: 'preview' }),
        );
    });

    it('stays off when neither the runtime config nor the build sets a DSN', async () => {
        stubWebRuntimeConfig({ serverUrl: '', sentryEnvironment: 'production' });
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(0);
    });

    it('still honours the crash-report opt-out for a runtime DSN', async () => {
        (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__ = true;
        stubWebRuntimeConfig({ serverUrl: '', sentryDsn: RUNTIME_DSN });
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(0);
    });
});
