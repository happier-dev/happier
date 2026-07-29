import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitSpy = vi.fn<(...args: unknown[]) => void>(() => {});
const sentryCaptureMessageSpy = vi.fn<(...args: unknown[]) => string>(() => 'sentry-test-event-id');
const sentryAddBreadcrumbSpy = vi.fn<(...args: unknown[]) => void>(() => {});
const sentryMobileReplayIntegrationSpy = vi.fn(() => ({
    name: 'mobileReplayIntegration',
    flush: (...args: unknown[]) => replayFlushSpy(...args),
    getReplayId: () => 'replay-id-1',
    startBuffering: () => {},
}));
const replayFlushSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});

const platformState = vi.hoisted(() => ({
    os: 'ios',
    version: '25.0' as string | number,
}));

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentryInitSpy(...args),
    captureMessage: (...args: unknown[]) => sentryCaptureMessageSpy(...args),
    addBreadcrumb: (...args: unknown[]) => sentryAddBreadcrumbSpy(...args),
    mobileReplayIntegration: () => sentryMobileReplayIntegrationSpy(),
    close: async () => {},
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
            get Version() {
                return platformState.version;
            },
            select: (specifics: Record<string, unknown>) => {
                if (platformState.os in specifics) return specifics[platformState.os];
                return specifics.default;
            },
        },
    };
});

vi.mock('@/config', () => ({
    config: { variant: 'preview' },
}));

describe('utils/system/sentry (bug report replay)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousReplay = process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
    const previousAllowIos26Replay = process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26;
    const previousSessionRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE;
    const previousOnErrorRate = process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        sentryCaptureMessageSpy.mockClear();
        sentryAddBreadcrumbSpy.mockClear();
        sentryMobileReplayIntegrationSpy.mockClear();
        replayFlushSpy.mockClear();
        platformState.os = 'ios';
        platformState.version = '25.0';
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
        process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = '1';
        delete process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26;
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = '0';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = '1';
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
        if (previousReplay === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY;
        else process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = previousReplay;
        if (previousAllowIos26Replay === undefined) delete process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26;
        else process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26 = previousAllowIos26Replay;
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

    it('adds breadcrumbs when crash reports are enabled', async () => {
        const sentryModule = await import('./sentry') as typeof import('./sentry') & {
            addBreadcrumbIfEnabled?: (breadcrumb: Readonly<{
                category: string;
                level: 'info';
                data: Record<string, unknown>;
            }>) => void;
        };

        sentryModule.addBreadcrumbIfEnabled?.({
            category: 'theme.runtime',
            level: 'info',
            data: { phase: 'update-visual-theme' },
        });

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryAddBreadcrumbSpy).toHaveBeenCalledWith({
            category: 'theme.runtime',
            level: 'info',
            data: { phase: 'update-visual-theme' },
        });
    });

    it('disables replay on iOS 26 while keeping crash report events enabled', async () => {
        platformState.os = 'ios';
        platformState.version = '26.5';

        const { initializeSentryOnce, captureBugReportSentryEvent } = await import('./sentry');
        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryMobileReplayIntegrationSpy).toHaveBeenCalledTimes(0);
        const initOptions = sentryInitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(initOptions).not.toHaveProperty('replaysSessionSampleRate');
        expect(initOptions).not.toHaveProperty('replaysOnErrorSampleRate');
        expect(initOptions).not.toHaveProperty('integrations');

        const captured = await captureBugReportSentryEvent();
        expect(sentryCaptureMessageSpy).toHaveBeenCalledTimes(1);
        expect(replayFlushSpy).toHaveBeenCalledTimes(0);
        expect(captured).toEqual(expect.objectContaining({
            eventId: 'sentry-test-event-id',
        }));
        expect(captured?.replayId).toBeUndefined();
    });

    it('keeps replay enabled on iOS 26 when explicitly allowed', async () => {
        platformState.os = 'ios';
        platformState.version = '26.5';
        process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26 = '1';

        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();

        expect(sentryInitSpy).toHaveBeenCalledTimes(1);
        expect(sentryMobileReplayIntegrationSpy).toHaveBeenCalledTimes(1);
        const initOptions = sentryInitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(initOptions).toEqual(expect.objectContaining({
            replaysSessionSampleRate: 0,
            replaysOnErrorSampleRate: 1,
        }));
        expect(initOptions.integrations).toEqual([expect.objectContaining({ name: 'mobileReplayIntegration' })]);
    });
});
