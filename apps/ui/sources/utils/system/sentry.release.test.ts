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

describe('utils/system/sentry (release)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousRelease = process.env.EXPO_PUBLIC_SENTRY_RELEASE;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        process.env.EXPO_PUBLIC_SENTRY_RELEASE = 'happier-ui@sha123';
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
        if (previousRelease === undefined) delete process.env.EXPO_PUBLIC_SENTRY_RELEASE;
        else process.env.EXPO_PUBLIC_SENTRY_RELEASE = previousRelease;
    });

    it('passes release to Sentry.init when EXPO_PUBLIC_SENTRY_RELEASE is set', async () => {
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryInitSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                release: 'happier-ui@sha123',
            }),
        );
    });
});
