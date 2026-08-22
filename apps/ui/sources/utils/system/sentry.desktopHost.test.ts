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

const BASE_DSN = 'https://base@o0.ingest.sentry.io/1';
const TAURI_DSN = 'https://tauri@o0.ingest.sentry.io/2';

const ELECTRON_USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
    + ' happier-desktop/0.2.10 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36';

async function initializeAndReadDsn(): Promise<unknown> {
    const { initializeSentryOnce } = await import('./sentry');
    initializeSentryOnce();
    return (sentryInitSpy.mock.calls[0]?.[0] as { dsn?: unknown } | undefined)?.dsn;
}

describe('utils/system/sentry (desktop host DSN routing)', () => {
    const previousDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    const previousTauriDsn = process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI;
    const originalWindow = (globalThis as any).window;
    const originalNavigator = (globalThis as any).navigator;

    beforeEach(() => {
        sentryInitSpy.mockClear();
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_SENTRY_INIT__;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).__HAPPIER_CRASH_REPORTS_OPTOUT__;
        process.env.EXPO_PUBLIC_SENTRY_DSN = BASE_DSN;
        process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI = TAURI_DSN;
        vi.resetModules();
    });

    afterEach(() => {
        if (previousDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        else process.env.EXPO_PUBLIC_SENTRY_DSN = previousDsn;
        if (previousTauriDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI;
        else process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI = previousTauriDsn;
        if (originalWindow === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete (globalThis as any).window;
        } else {
            (globalThis as any).window = originalWindow;
        }
        if (originalNavigator === undefined) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete (globalThis as any).navigator;
        } else {
            (globalThis as any).navigator = originalNavigator;
        }
    });

    it('reports to the Tauri project when the Tauri shell hosts the app', async () => {
        (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: () => null } };

        await expect(initializeAndReadDsn()).resolves.toBe(TAURI_DSN);
    });

    it('reports to the base project when the Electron shell hosts the app', async () => {
        // The Electron preload installs a Tauri-shaped bridge, so the bridge alone must not decide
        // which project a crash belongs to.
        (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: () => null } };
        (globalThis as any).navigator = { userAgent: ELECTRON_USER_AGENT };

        await expect(initializeAndReadDsn()).resolves.toBe(BASE_DSN);
    });
});
