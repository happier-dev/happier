import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitSpy = vi.fn((..._args: unknown[]) => {});
const sentrySetTagSpy = vi.fn((..._args: unknown[]) => {});
const sentrySetContextSpy = vi.fn((..._args: unknown[]) => {});

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentryInitSpy(...args),
    setTag: (...args: unknown[]) => sentrySetTagSpy(...args),
    setContext: (...args: unknown[]) => sentrySetContextSpy(...args),
    close: async () => {},
    mobileReplayIntegration: () => ({ name: 'mobileReplayIntegration' }),
    captureMessage: () => 'sentry-test-event-id',
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'ios',
            Version: '26.5.1',
            select: (specifics: Record<string, unknown>) => specifics.ios ?? specifics.default,
        },
    };
});

vi.mock('expo-constants', () => ({
    default: {
        appOwnership: 'expo',
        executionEnvironment: 'storeClient',
        expoConfig: {
            version: '0.2.7',
            runtimeVersion: 'runtime-1',
            sdkVersion: '54.0.0',
        },
        isDevice: true,
        debugMode: false,
    },
}));

vi.mock('expo-application', () => ({
    applicationId: 'dev.happier.app.publicdev',
    nativeApplicationVersion: '0.2.7',
    nativeBuildVersion: '213',
}));

vi.mock('@/config', () => ({
    config: {
        variant: 'publicdev',
        identityVariant: 'publicdev',
    },
}));

describe('utils/system/sentry (runtime context)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        sentrySetTagSpy.mockClear();
        sentrySetContextSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
    });

    it('adds non-sensitive runtime tags and context after initialization', async () => {
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.variant', 'publicdev');
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.identity_variant', 'publicdev');
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.app_ownership', 'expo');
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.execution_environment', 'storeClient');
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.platform', 'ios');
        expect(sentrySetTagSpy).toHaveBeenCalledWith('happier.native_build', '213');
        expect(sentrySetContextSpy).toHaveBeenCalledWith('happier.runtime', expect.objectContaining({
            applicationId: 'dev.happier.app.publicdev',
            appOwnership: 'expo',
            executionEnvironment: 'storeClient',
            expoVersion: '0.2.7',
            nativeApplicationVersion: '0.2.7',
            nativeBuildVersion: '213',
            platform: 'ios',
            platformVersion: '26.5.1',
            runtimeVersion: 'runtime-1',
            sdkVersion: '54.0.0',
        }));
    });
});
