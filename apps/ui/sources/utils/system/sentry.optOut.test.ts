import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitSpy = vi.fn((..._args: unknown[]) => {});
const sentryCloseSpy = vi.fn(async (..._args: unknown[]) => {});
const sentryWrapSpy = vi.fn((Component: any) => {
    const Wrapped = (...args: any[]) => Component(...args);
    return Wrapped;
});

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentryInitSpy(...args),
    close: (...args: unknown[]) => sentryCloseSpy(...args),
    mobileReplayIntegration: () => ({ name: 'mobileReplayIntegration' }),
    captureMessage: () => 'sentry-test-event-id',
    wrap: (Component: any) => sentryWrapSpy(Component),
}));

vi.mock('@/config', () => ({
    config: { variant: 'preview' },
}));

describe('utils/system/sentry (crash reports opt-out)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousFeatureDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        sentryCloseSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
        if (previousFeatureDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousFeatureDeny;
    });

    it('skips Sentry.init when crash reports are denied by build policy', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.crashReports';
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();
        expect(sentryInitSpy).toHaveBeenCalledTimes(0);
    });

    it('closes Sentry when crash reports are opted out', async () => {
        const { initializeSentryOnce, applyCrashReportsOptOut } = await import('./sentry');
        initializeSentryOnce();
        expect(sentryInitSpy).toHaveBeenCalledTimes(1);

        applyCrashReportsOptOut(true);
        expect(sentryCloseSpy).toHaveBeenCalledTimes(1);

        // Re-enabling should allow init again (guard cleared on close).
        applyCrashReportsOptOut(false);
        expect(sentryInitSpy).toHaveBeenCalledTimes(2);
    });

    it('wraps components when crash reports are enabled', async () => {
        const { wrapWithSentryIfEnabled } = await import('./sentry');
        const Root = () => null;
        const wrapped = wrapWithSentryIfEnabled(Root);
        expect(wrapped).not.toBe(Root);
        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
    });
});
