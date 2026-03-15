import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitSpy = vi.fn<(...args: unknown[]) => void>(() => {});
const sentryCaptureMessageSpy = vi.fn<(...args: unknown[]) => string>(() => 'sentry-test-event-id');
const replayFlushSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentryInitSpy(...args),
    captureMessage: (...args: unknown[]) => sentryCaptureMessageSpy(...args),
    mobileReplayIntegration: () => ({
        name: 'mobileReplayIntegration',
        flush: (...args: unknown[]) => replayFlushSpy(...args),
        getReplayId: () => 'replay-id-1',
        startBuffering: () => {},
    }),
    close: async () => {},
}));

vi.mock('@/config', () => ({
    config: { variant: 'preview' },
}));

describe('utils/system/sentry (bug report replay)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousReplay = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
    const previousSessionRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
    const previousOnErrorRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        sentryCaptureMessageSpy.mockClear();
        replayFlushSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = '1';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = '0';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = '1';
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
        if (previousReplay === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
        else process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = previousReplay;
        if (previousSessionRate === undefined) delete process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
        else process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = previousSessionRate;
        if (previousOnErrorRate === undefined) delete process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;
        else process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = previousOnErrorRate;
    });

    it('flushes replay and returns replayId when capturing a bug report Sentry event', async () => {
        const { initializeSentryOnce, captureBugReportSentryEvent } = await import('./sentry');
        initializeSentryOnce();
        expect(sentryInitSpy).toHaveBeenCalledTimes(1);

        const captured = await captureBugReportSentryEvent();
        expect(sentryCaptureMessageSpy).toHaveBeenCalledTimes(1);
        expect(replayFlushSpy).toHaveBeenCalledTimes(1);
        expect(captured).toEqual(expect.objectContaining({
            eventId: 'sentry-test-event-id',
            replayId: 'replay-id-1',
        }));
    });
});
