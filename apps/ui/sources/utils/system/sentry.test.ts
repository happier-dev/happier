import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One harness for every sentry.ts contract. sentry.ts snapshots EXPO_PUBLIC_* env at
// import and keeps module-level replay state, so each test sets env/host state first
// and then imports a fresh module (vi.resetModules in beforeEach).
const sentry = vi.hoisted(() => {
    const replayFlush = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    return {
        init: vi.fn<(...args: unknown[]) => void>(() => {}),
        close: vi.fn(async (..._args: unknown[]) => {}),
        captureMessage: vi.fn<(...args: unknown[]) => string>(() => 'sentry-test-event-id'),
        addBreadcrumb: vi.fn<(...args: unknown[]) => void>(() => {}),
        setTag: vi.fn((..._args: unknown[]) => {}),
        setContext: vi.fn((..._args: unknown[]) => {}),
        wrap: vi.fn((Component: (...args: unknown[]) => unknown) => {
            const Wrapped = (...args: unknown[]) => Component(...args);
            return Wrapped;
        }),
        replayFlush,
        mobileReplayIntegration: vi.fn(() => ({
            name: 'mobileReplayIntegration',
            flush: (...args: unknown[]) => replayFlush(...args),
            getReplayId: () => 'replay-id-1',
            startBuffering: () => {},
        })),
    };
});

const platformState = vi.hoisted(() => ({
    os: 'ios',
    version: '25.0' as string | number,
}));

const appConfig = vi.hoisted(() => ({
    variant: 'preview',
    identityVariant: undefined as string | undefined,
}));

vi.mock('@sentry/react-native', () => ({
    init: (...args: unknown[]) => sentry.init(...args),
    close: (...args: unknown[]) => sentry.close(...args),
    captureMessage: (...args: unknown[]) => sentry.captureMessage(...args),
    addBreadcrumb: (...args: unknown[]) => sentry.addBreadcrumb(...args),
    setTag: (...args: unknown[]) => sentry.setTag(...args),
    setContext: (...args: unknown[]) => sentry.setContext(...args),
    wrap: (Component: (...args: unknown[]) => unknown) => sentry.wrap(Component),
    mobileReplayIntegration: () => sentry.mobileReplayIntegration(),
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

vi.mock('@/config', () => ({ config: appConfig }));

const MANAGED_ENV_KEYS = [
    'EXPO_PUBLIC_SENTRY_DSN',
    'EXPO_PUBLIC_SENTRY_DSN_TAURI',
    'EXPO_PUBLIC_SENTRY_RELEASE',
    'EXPO_PUBLIC_SENTRY_ENVIRONMENT',
    'EXPO_PUBLIC_SENTRY_ENABLE_REPLAY',
    'EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26',
    'EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE',
    'EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE',
    'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY',
] as const;

const DEFAULT_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';

type HostGlobals = { window?: unknown; navigator?: unknown };
const hostGlobals = globalThis as HostGlobals & {
    __HAPPIER_SENTRY_INIT__?: boolean;
    __HAPPIER_CRASH_REPORTS_OPTOUT__?: boolean;
};

const previousEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalWindow = hostGlobals.window;
const originalNavigator = hostGlobals.navigator;

beforeEach(() => {
    for (const spy of Object.values(sentry)) spy.mockClear();
    platformState.os = 'ios';
    platformState.version = '25.0';
    appConfig.variant = 'preview';
    appConfig.identityVariant = undefined;
    delete hostGlobals.__HAPPIER_SENTRY_INIT__;
    // Cases start with the Account's choice known and allowing crash reports.
    hostGlobals.__HAPPIER_CRASH_REPORTS_OPTOUT__ = false;
    for (const key of MANAGED_ENV_KEYS) delete process.env[key];
    process.env.EXPO_PUBLIC_SENTRY_DSN = DEFAULT_DSN;
    vi.resetModules();
});

afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
        const previous = previousEnv[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
    if (originalWindow === undefined) delete hostGlobals.window;
    else hostGlobals.window = originalWindow;
    if (originalNavigator === undefined) delete hostGlobals.navigator;
    else hostGlobals.navigator = originalNavigator;
});

describe('utils/system/sentry (bug report replay)', () => {
    beforeEach(() => {
        process.env.EXPO_PUBLIC_SENTRY_ENABLE_REPLAY = '1';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE = '0';
        process.env.EXPO_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE = '1';
    });

    it('submits only the supplied attachment set without a surprise Sentry event or replay', async () => {
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();
        const { submitBugReportToService } = await import('@/components/settings/bugReports/bugReportServiceClient');
        const artifact = { filename: 'reviewed-context.json', sourceKind: 'ui-mobile', contentType: 'application/json', content: '{"reviewed":true}' };
        const uploaded: string[] = [];
        let submittedArtifacts: unknown;
        const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (init?.method === 'PUT') {
                uploaded.push(String(init.body));
                return new Response('', { status: 200 });
            }
            if (url.pathname === '/v1/reports/session') {
                const body = JSON.parse(String(init?.body));
                submittedArtifacts = body.artifacts;
                return new Response(JSON.stringify({ reportId: 'report-reviewed', uploadTargets: body.artifacts.map((_entry: unknown, index: number) => ({
                    artifactId: `artifact-${index}`, objectKey: `object-${index}`, uploadUrl: `https://upload.example.test/${index}`, requiredHeaders: {},
                })) }), { status: 200 });
            }
            return new Response(JSON.stringify({ reportId: 'report-reviewed', issueNumber: 782, issueUrl: 'https://github.com/happier-dev/happier/issues/782' }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy);
        try {
            await submitBugReportToService({ providerUrl: 'https://reports.example.test', timeoutMs: 10_000,
                issueOwner: 'happier-dev', issueRepo: 'happier', artifacts: [artifact],
                form: { title: 'Report after review', summary: 'What happened', environment: { appVersion: 'test', platform: 'ios', deploymentType: 'cloud' },
                    consent: { includeDiagnostics: true, acceptedPrivacyNotice: true } },
            });
            expect(submittedArtifacts).toEqual([{ filename: artifact.filename, contentType: artifact.contentType,
                sizeBytes: new TextEncoder().encode(artifact.content).byteLength, sourceKind: artifact.sourceKind }]);
            expect(uploaded).toEqual([artifact.content]);
            expect(sentry.captureMessage).not.toHaveBeenCalled();
            expect(sentry.replayFlush).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });

    it('adds breadcrumbs when crash reports are enabled', async () => {
        const { addBreadcrumbIfEnabled } = await import('./sentry');

        addBreadcrumbIfEnabled({
            category: 'theme.runtime',
            level: 'info',
            data: { phase: 'update-visual-theme' },
        });

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
            category: 'theme.runtime',
            level: 'info',
            data: { phase: 'update-visual-theme' },
        });
    });

    it('disables replay on iOS 26 while keeping crash report events enabled', async () => {
        platformState.os = 'ios';
        platformState.version = '26.5';

        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.mobileReplayIntegration).toHaveBeenCalledTimes(0);
        const initOptions = sentry.init.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(initOptions).not.toHaveProperty('replaysSessionSampleRate');
        expect(initOptions).not.toHaveProperty('replaysOnErrorSampleRate');
        expect(initOptions).not.toHaveProperty('integrations');
    });

    it('keeps replay enabled on iOS 26 when explicitly allowed', async () => {
        platformState.os = 'ios';
        platformState.version = '26.5';
        process.env.EXPO_PUBLIC_SENTRY_ALLOW_REPLAY_ON_IOS_26 = '1';

        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.mobileReplayIntegration).toHaveBeenCalledTimes(1);
        const initOptions = sentry.init.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(initOptions).toEqual(expect.objectContaining({
            replaysSessionSampleRate: 0,
            replaysOnErrorSampleRate: 1,
        }));
        expect(initOptions.integrations).toEqual([expect.objectContaining({ name: 'mobileReplayIntegration' })]);
    });
});

describe('utils/system/sentry (desktop host DSN routing)', () => {
    const BASE_DSN = 'https://base@o0.ingest.sentry.io/1';
    const TAURI_DSN = 'https://tauri@o0.ingest.sentry.io/2';
    const ELECTRON_USER_AGENT =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' happier-desktop/0.2.10 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36';

    async function initializeAndReadDsn(): Promise<unknown> {
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();
        return (sentry.init.mock.calls[0]?.[0] as { dsn?: unknown } | undefined)?.dsn;
    }

    beforeEach(() => {
        process.env.EXPO_PUBLIC_SENTRY_DSN = BASE_DSN;
        process.env.EXPO_PUBLIC_SENTRY_DSN_TAURI = TAURI_DSN;
    });

    it('reports to the Tauri project when the Tauri shell hosts the app', async () => {
        hostGlobals.window = { __TAURI_INTERNALS__: { invoke: () => null } };

        await expect(initializeAndReadDsn()).resolves.toBe(TAURI_DSN);
    });

    it('reports to the base project when the Electron shell hosts the app', async () => {
        // The Electron preload installs a Tauri-shaped bridge, so the bridge alone must not decide
        // which project a crash belongs to.
        hostGlobals.window = { __TAURI_INTERNALS__: { invoke: () => null } };
        hostGlobals.navigator = { userAgent: ELECTRON_USER_AGENT };

        await expect(initializeAndReadDsn()).resolves.toBe(BASE_DSN);
    });
});

describe('utils/system/sentry (crash reports opt-out)', () => {
    it('skips Sentry.init when crash reports are denied by build policy', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.crashReports';
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();
        expect(sentry.init).toHaveBeenCalledTimes(0);
    });

    it('closes Sentry when crash reports are opted out', async () => {
        const { initializeSentryOnce, applyCrashReportsOptOut } = await import('./sentry');
        initializeSentryOnce();
        expect(sentry.init).toHaveBeenCalledTimes(1);

        applyCrashReportsOptOut(true);
        expect(sentry.close).toHaveBeenCalledTimes(1);

        // Re-enabling should allow init again (guard cleared on close).
        applyCrashReportsOptOut(false);
        expect(sentry.init).toHaveBeenCalledTimes(2);
    });

    async function startWithPersistedAccountSettings(settings: Record<string, unknown> | null) {
        delete hostGlobals.__HAPPIER_CRASH_REPORTS_OPTOUT__;
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        getPersistenceStorage().clearAll();
        if (settings) {
            const { saveActiveAccountSettingsScope, saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
            const { settingsParse } = await import('@/sync/domains/settings/settings');
            const scope = { serverId: 'srv_sentry', accountId: 'acct_sentry' };
            saveActiveAccountSettingsScope(scope);
            saveAccountSettings(scope, settingsParse(settings), 2);
        }
        return await import('./sentry');
    }

    it('does not start on a device that does not know the Account settings yet, until they allow it', async () => {
        const { initializeSentryOnce, wrapWithSentryIfEnabled, applyCrashReportsOptOut } = await startWithPersistedAccountSettings(null);
        const Root = () => null;

        initializeSentryOnce();
        expect(wrapWithSentryIfEnabled(Root)).toBe(Root);
        expect(sentry.init).not.toHaveBeenCalled();

        applyCrashReportsOptOut(false);
        expect(sentry.init).toHaveBeenCalledTimes(1);
    });

    it('starts at launch when the known Account settings allow crash reports', async () => {
        const { initializeSentryOnce } = await startWithPersistedAccountSettings({ crashReportsOptOut: false });
        initializeSentryOnce();
        expect(sentry.init).toHaveBeenCalledTimes(1);
    });

    it('stays off at launch when the known Account settings opt out', async () => {
        const { initializeSentryOnce } = await startWithPersistedAccountSettings({ crashReportsOptOut: true });
        initializeSentryOnce();
        expect(sentry.init).not.toHaveBeenCalled();
    });

    it('wraps components when crash reports are enabled', async () => {
        const { wrapWithSentryIfEnabled } = await import('./sentry');
        const Root = () => null;
        const wrapped = wrapWithSentryIfEnabled(Root);
        expect(wrapped).not.toBe(Root);
        expect(sentry.init).toHaveBeenCalledTimes(1);
    });
});

describe('utils/system/sentry (web runtime config)', () => {
    // The generic web image reads its DSN at container start (docker/webapp-runtime.sh), so self-hosted
    // copies report nowhere unless their operator configures it.
    const RUNTIME_DSN = 'https://runtimeKey@o0.ingest.sentry.io/2';

    async function initializeWithRuntimeConfig(runtimeConfig: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        vi.stubGlobal('window', { __HAPPIER_WEB_RUNTIME_CONFIG__: { serverUrl: '', ...runtimeConfig } });
        vi.stubGlobal('document', {});
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();
        return sentry.init.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('prefers the container-start DSN and environment over build-time values', async () => {
        process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT = 'build-env';
        await expect(initializeWithRuntimeConfig({ sentryDsn: ` ${RUNTIME_DSN} `, sentryEnvironment: 'production' }))
            .resolves.toEqual(expect.objectContaining({ dsn: RUNTIME_DSN, environment: 'production' }));
    });

    it('starts from the container-start DSN alone when the build sets none', async () => {
        delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        await expect(initializeWithRuntimeConfig({ sentryDsn: RUNTIME_DSN }))
            .resolves.toEqual(expect.objectContaining({ dsn: RUNTIME_DSN, environment: 'preview' }));
    });

    it('keeps the build-time DSN when the runtime config leaves it empty or malformed', async () => {
        for (const sentryDsn of ['', 42]) {
            sentry.init.mockClear();
            delete hostGlobals.__HAPPIER_SENTRY_INIT__;
            vi.resetModules();
            await expect(initializeWithRuntimeConfig({ sentryDsn, sentryEnvironment: '' }))
                .resolves.toEqual(expect.objectContaining({ dsn: DEFAULT_DSN, environment: 'preview' }));
        }
    });

    it('stays off when neither the runtime config nor the build sets a DSN', async () => {
        delete process.env.EXPO_PUBLIC_SENTRY_DSN;
        await initializeWithRuntimeConfig({ sentryEnvironment: 'production' });
        expect(sentry.init).not.toHaveBeenCalled();
    });

    it('still honours the crash-report opt-out for a container-start DSN', async () => {
        hostGlobals.__HAPPIER_CRASH_REPORTS_OPTOUT__ = true;
        await initializeWithRuntimeConfig({ sentryDsn: RUNTIME_DSN });
        expect(sentry.init).not.toHaveBeenCalled();
    });
});

describe('utils/system/sentry (release)', () => {
    it('passes release to Sentry.init when EXPO_PUBLIC_SENTRY_RELEASE is set', async () => {
        process.env.EXPO_PUBLIC_SENTRY_RELEASE = 'happier-ui@sha123';
        const { initializeSentryOnce } = await import('./sentry');
        initializeSentryOnce();

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.init.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                release: 'happier-ui@sha123',
            }),
        );
    });
});

describe('utils/system/sentry (runtime context)', () => {
    it('adds non-sensitive runtime tags and context after initialization', async () => {
        platformState.version = '26.5.1';
        appConfig.variant = 'publicdev';
        appConfig.identityVariant = 'publicdev';
        const { initializeSentryOnce } = await import('./sentry');

        initializeSentryOnce();

        expect(sentry.init).toHaveBeenCalledTimes(1);
        expect(sentry.setTag).toHaveBeenCalledWith('happier.variant', 'publicdev');
        expect(sentry.setTag).toHaveBeenCalledWith('happier.identity_variant', 'publicdev');
        expect(sentry.setTag).toHaveBeenCalledWith('happier.app_ownership', 'expo');
        expect(sentry.setTag).toHaveBeenCalledWith('happier.execution_environment', 'storeClient');
        expect(sentry.setTag).toHaveBeenCalledWith('happier.platform', 'ios');
        expect(sentry.setTag).toHaveBeenCalledWith('happier.native_build', '213');
        expect(sentry.setContext).toHaveBeenCalledWith('happier.runtime', expect.objectContaining({
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
