import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { clearDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { takeStoreSnapshot } from '@/demoMode/seed/storeSnapshot';
import { getDemoFirewallDenyLog, resetDemoFirewallForTests, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';
import { storage } from '@/sync/domains/state/storage';
import {
    getActiveServerSnapshot,
    setActiveServer,
    upsertAndActivateServer,
} from '@/sync/domains/server/serverRuntime';
import { beginOnboardingJourneySession, endOnboardingJourneySession } from '@/components/onboarding/tour/state/journeySession';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import type {
    OnboardingWizardController,
    OnboardingWizardSurfaceProps,
} from '@/components/onboarding/surfaces/useOnboardingWizardController';
import type { JourneyBeatId } from '@/components/onboarding/tour/state/journeyBeats';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

const demoWorldState = vi.hoisted(() => ({
    clearFailures: [] as Error[],
    clearCalls: 0,
    seedCalls: 0,
}));

vi.mock('@/demoMode/seed/seedDemoWorld', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/demoMode/seed/seedDemoWorld')>();
    return {
        ...actual,
        seedDemoWorld: vi.fn(async (...args: Parameters<typeof actual.seedDemoWorld>) => {
            demoWorldState.seedCalls += 1;
            return actual.seedDemoWorld(...args);
        }),
        clearDemoWorld: vi.fn(async (...args: Parameters<typeof actual.clearDemoWorld>) => {
            demoWorldState.clearCalls += 1;
            const error = demoWorldState.clearFailures.shift();
            if (error) throw error;
            return actual.clearDemoWorld(...args);
        }),
    };
});

const journeyRouteState = vi.hoisted(() => ({
    enabled: false,
    initialBeatId: 'S2' as JourneyBeatId,
    initialAttentionChoice: undefined as undefined | 'promote_attention_and_working',
    mountIds: [] as number[],
    unmountIds: [] as number[],
    nextMountId: 1,
}));

vi.mock('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry', async () => {
    const ReactModule = await import('react');
    const { Text } = await import('@/components/ui/text/Text');
    const { OnboardingJourneyHost } = await import('@/components/onboarding/tour/OnboardingJourneyHost');
    const React = ReactModule.default;

    function createPreAuthController(): OnboardingWizardController {
        return {
            stepId: 'auth',
            currentStepIndex: 1,
            stepCount: 2,
            contentTransitionDirection: 'replace',
            showBack: true,
            showSkip: false,
            onBack: vi.fn(),
            onSkip: null,
            onPrimary: vi.fn(),
            primaryLabel: 'Sign in',
            primaryDisabled: false,
            skipLabel: null,
            skipDisabled: false,
            title: 'auth',
            subtitle: null,
            footerHint: null,
            body: React.createElement(Text, { testID: 'route-journey-preauth-body' }, 'Pre-auth controller body'),
            goToStep: vi.fn(),
        };
    }

    function createWizardSurfaceProps(): OnboardingWizardSurfaceProps {
        return {
            testID: 'route-wizard',
            layout: 'landscape',
            isDesktopShell: true,
            authEntryOptions: {
                serverAvailability: 'ready',
                serverUrlForCopy: 'https://relay.example.test',
                showAuthActions: true,
                showProviderSignup: false,
                showAnonymousSignup: false,
                showMtlsLogin: false,
                showKeylessProviderLogin: false,
                providerId: null,
                keylessProviderId: null,
                providerSignupTitle: '',
                providerKeylessTitle: '',
                anonymousSignupTitle: '',
                mtlsTitle: '',
                primaryAction: null,
                mtlsPrimary: false,
                keylessPrimary: false,
                autoRedirect: {
                    enabled: false,
                    providerId: null,
                    toKeyedProvision: false,
                    toKeylessLogin: false,
                    toMtls: false,
                    toLegacySignupProvider: false,
                },
                retryServerCheck: () => undefined,
            },
            onCreateAccount: vi.fn(),
            onCreateAccountViaProvider: vi.fn(),
            onLoginWithKeylessProvider: vi.fn(),
            onLoginWithMtls: vi.fn(),
        };
    }

    function RouteJourneyHostWrapper() {
        const [mountId] = React.useState(() => journeyRouteState.nextMountId++);
        React.useEffect(() => {
            journeyRouteState.mountIds.push(mountId);
            return () => {
                journeyRouteState.unmountIds.push(mountId);
            };
        }, [mountId]);

        return React.createElement(OnboardingJourneyHost, {
            surface: 'desktop',
            isDesktopShell: true,
            initialBeatId: journeyRouteState.initialBeatId,
            initialAttentionChoice: journeyRouteState.initialAttentionChoice,
            preAuthController: createPreAuthController(),
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'route-journey',
        });
    }

    function RouteJourneyEntry() {
        if (!journeyRouteState.enabled) {
            return React.createElement('PreAuthOnboardingWizardEntry');
        }
        return React.createElement(RouteJourneyHostWrapper);
    }

    return {
        PreAuthOnboardingWizardEntry: RouteJourneyEntry,
    };
});

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: any) => React.createElement('SetupWizardSurface', props),
}));

const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/store/settingsWriters', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/settingsWriters')>();
    return {
        ...actual,
        useApplyLocalSettings: () => applyLocalSettingsSpy,
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/text/i18n', () => ({
    setPreferredLanguageFromSettings: vi.fn(),
}));

vi.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: {
        View: 'Animated.View',
        createAnimatedComponent: (component: unknown) => component,
    },
    Easing: {
        cubic: 'cubic',
        out: (value: unknown) => value,
    },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    makeMutable: (value: unknown) => ({ value }),
    cancelAnimation: vi.fn(),
    withDelay: (_delayMs: number, value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

vi.mock('react-native-svg', () => ({
    __esModule: true,
    default: 'Svg',
    Circle: 'Circle',
    G: 'G',
    Line: 'Line',
    Path: 'Path',
    Rect: 'Rect',
    Svg: 'Svg',
    SvgXml: 'SvgXml',
}));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

// The route gate reads the onboardingTour feature decision; tie it to the same
// switch the mocked PreAuthOnboardingWizardEntry uses so flag-on/off scenarios stay coherent.
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string, scope?: unknown) => ({
        featureId,
        state: journeyRouteState.enabled ? 'enabled' : 'disabled',
        blockedBy: journeyRouteState.enabled ? null : 'server',
        blockerCode: journeyRouteState.enabled ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 0,
        scope: scope ?? { scopeKind: 'runtime' },
    }),
}));

let isAuthenticated = true;
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
        credentials: isAuthenticated ? { token: 'route-token', secret: 'route-secret' } : null,
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: (props: Record<string, unknown>) => React.createElement('MainView', props),
}));

const pendingTerminalConnectState = vi.hoisted(() => ({
    value: null as null | { publicKeyB64Url: string; serverUrl: string },
}));
vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectState.value,
}));

const connectionHealthState = vi.hoisted(() => ({ value: 0 as number }));
vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ onlineCount: connectionHealthState.value }),
}));

const localDaemonStatus = vi.hoisted(() => ({
    value: {
        serviceInstalled: false,
        daemonRunning: false,
        needsAuth: true,
        machineId: null as string | null,
    },
}));
vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: localDaemonStatus.value,
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

const setupControllerState = vi.hoisted(() => ({
    lastProps: null as Record<string, unknown> | null,
    current: {
        stepId: 'setup_this_computer',
        currentStepIndex: 0,
        stepCount: 2,
        contentTransitionKey: 'setup_this_computer',
        contentTransitionDirection: 'replace',
        title: 'setup',
        subtitle: null,
        scrollable: false,
        body: null as React.ReactNode,
        onPrimary: vi.fn(),
        primaryLabel: 'Continue setup',
        primaryDisabled: false,
        onBack: vi.fn(),
        backLabel: 'Back',
        showBack: true,
        onSkip: vi.fn(),
        skipLabel: 'Skip',
        skipDisabled: false,
        showSkip: true,
        footerHint: null,
        goToStep: vi.fn(),
    },
}));
vi.mock('@/components/onboarding/surfaces/useSetupWizardController', () => ({
    useSetupWizardController: (props: Record<string, unknown>) => {
        setupControllerState.lastProps = props;
        return {
            ...setupControllerState.current,
            body: React.createElement('Text', { testID: 'route-journey-setup-body' }, 'Setup controller body'),
        };
    },
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
    primeServerFeaturesSnapshot: vi.fn(),
    deleteServerFeaturesSnapshot: vi.fn(),
}));

const syncSingletonState = vi.hoisted(() => ({
    applySettings: vi.fn(),
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        applySettings: syncSingletonState.applySettings,
    }),
}));

vi.mock('@/components/onboarding/tour/stage/DemoStage', () => ({
    DemoStage: (props: Record<string, unknown>) => React.createElement('DemoStage', props, `stage:${String(props.activeFrameId)}`),
}));

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => ({
    branch: 'thisComputer',
    phase: 'awaiting_auth',
    relayUrl: 'https://relay.example.test',
})));
const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: clearPendingSetupIntentMock,
    setPendingSetupIntent: setPendingSetupIntentMock,
}));

const originalStorageState = storage.getState();
const initialGlobalFetch = globalThis.fetch;
let routeBaseFetchSpy: ReturnType<typeof vi.fn>;

// Seed a single non-revoked (offline) machine into the real store so the canonical
// `useAllMachines()` selector reports the account already has a machine. Uses the global
// machine map with an empty machineListByServerId so the active-server resolver falls back
// to it regardless of the active serverId.
function seedActiveServerMachine(machineId = 'm-existing'): void {
    storage.setState((state) => ({
        ...state,
        isDataReady: true,
        machineListByServerId: {},
        machineListStatusByServerId: {},
        machines: {
            [machineId]: {
                id: machineId,
                seq: 1,
                createdAt: 2000,
                updatedAt: 2000,
                active: false,
                activeAt: 2000,
                metadata: { host: 'existing', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            } as never,
        },
    }));
}

describe('/ (welcome) journey hinge', () => {
    beforeEach(() => {
        isAuthenticated = true;
        journeyRouteState.enabled = false;
        journeyRouteState.initialBeatId = 'S2';
        journeyRouteState.initialAttentionChoice = undefined;
        journeyRouteState.mountIds = [];
        journeyRouteState.unmountIds = [];
        journeyRouteState.nextMountId = 1;
        endOnboardingJourneySession();
        tauriDesktopState.value = true;
        connectionHealthState.value = 0;
        pendingTerminalConnectState.value = null;
        demoWorldState.clearFailures = [];
        demoWorldState.clearCalls = 0;
        demoWorldState.seedCalls = 0;
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        clearPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockImplementation(() => {
            getPendingSetupIntentMock.mockReturnValue(null);
        });
        setPendingSetupIntentMock.mockReset();
        setPendingSetupIntentMock.mockImplementation((value) => {
            getPendingSetupIntentMock.mockReturnValue(value);
        });
        applyLocalSettingsSpy.mockReset();
        localDaemonStatus.value = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
        setupControllerState.lastProps = null;
        setupControllerState.current.stepId = 'setup_this_computer';
        setupControllerState.current.contentTransitionKey = 'setup_this_computer';
        setupControllerState.current.onPrimary.mockClear();
        setupControllerState.current.onBack.mockClear();
        setupControllerState.current.onSkip.mockClear();
        setupControllerState.current.goToStep.mockClear();
        syncSingletonState.applySettings.mockReset();
        routeBaseFetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = routeBaseFetchSpy as unknown as typeof fetch;
        resetDemoModeDepthForTests();
        resetDemoFirewallForTests();
        storage.setState(originalStorageState, true);
    });

    afterEach(async () => {
        standardCleanup();
        uninstallDemoFirewall();
        resetDemoFirewallForTests();
        demoWorldState.clearFailures = [];
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        let clearError: unknown;
        try {
            await clearDemoWorld();
        } catch (error) {
            clearError = error;
        }
        resetDemoModeDepthForTests();
        endOnboardingJourneySession();
        storage.setState(originalStorageState, true);
        globalThis.fetch = initialGlobalFetch;
        if (clearError) throw clearError;
    });

    it('drops the demo firewall at S1 so the real S2 auth POST can pass', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S1';
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(journeyRouteState.mountIds).toEqual([1]);
        expect(screen.findByTestId('route-journey-desktop-current-beat:S1')).not.toBeNull();
        await expect(globalThis.fetch('/v1/auth', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
        expect(routeBaseFetchSpy).toHaveBeenCalledWith('/v1/auth', { method: 'POST' });
        await expect(runtimeFetch('/v1/relay/probe', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
        expect(routeBaseFetchSpy).toHaveBeenCalledWith('/v1/relay/probe', {
            method: 'POST',
            credentials: 'same-origin',
        });
        expect(getDemoFirewallDenyLog()).toEqual([]);
    });

    it('keeps one first-run journey mounted when its demo relay temporarily differs from the pinned web server override', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'A1';
        isAuthenticated = false;

        const originalServerId = getActiveServerSnapshot().serverId;
        const pinnedServerUrl = 'http://localhost:53288';
        const encodedServerUrl = encodeURIComponent(pinnedServerUrl);
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: `https://app.example.test/?server=${encodedServerUrl}`,
                pathname: '/',
                search: `?server=${encodedServerUrl}`,
                hash: '',
            },
            history: { replaceState: vi.fn() },
        };
        upsertAndActivateServer({
            serverUrl: pinnedServerUrl,
            source: 'url',
            scope: 'device',
        });

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

            expect(journeyRouteState.mountIds).toEqual([1]);
            expect(journeyRouteState.unmountIds).toEqual([]);
            expect(demoWorldState.seedCalls).toBe(1);
            expect(demoWorldState.clearCalls).toBe(0);

            await screen.unmount();
            await flushHookEffects({ cycles: 4, turns: 2, frames: 1 });

            expect(demoWorldState.clearCalls).toBe(1);
            expect(journeyRouteState.unmountIds).toEqual([1]);
            expect(getActiveServerSnapshot().serverUrl).toBe(pinnedServerUrl);
        } finally {
            setActiveServer({ serverId: originalServerId, scope: 'device' });
        }
    });

    it('still holds an active journey latch for a genuine unresolved server override outside demo mode', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S1';
        isAuthenticated = false;
        beginOnboardingJourneySession();

        const originalServerId = getActiveServerSnapshot().serverId;
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: 'https://app.example.test/?server=https%3A%2F%2Fstack.example.test',
                pathname: '/',
                search: '?server=https%3A%2F%2Fstack.example.test',
                hash: '',
            },
            history: { replaceState: vi.fn() },
        };
        upsertAndActivateServer({
            serverUrl: 'http://localhost:53288',
            source: 'url',
            scope: 'device',
        });

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(journeyRouteState.mountIds).toEqual([]);
            expect(demoWorldState.seedCalls).toBe(0);
            expect(demoWorldState.clearCalls).toBe(0);

            await screen.unmount();
        } finally {
            setActiveServer({ serverId: originalServerId, scope: 'device' });
        }
    });

    it('keeps the active journey host mounted across login and suppresses the legacy setup modal', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S2';
        isAuthenticated = false;
        const before = takeStoreSnapshot(storage.getState());

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(journeyRouteState.mountIds).toEqual([1]);
        expect(screen.getTextContent()).toContain('Pre-auth controller body');
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        // A journey mounted directly at a setup beat never seeds the demo world,
        // so there is nothing to tear down (JV3-LIVEQA setup-entry invariant).
        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);

        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(journeyRouteState.mountIds).toEqual([1]);
        expect(journeyRouteState.unmountIds).toEqual([]);
        expect(screen.getTextContent()).toContain('Setup controller body');
        expect(setupControllerState.lastProps).toMatchObject({
            initialStepId: 'setup_this_computer',
            scope: 'machine',
        });
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
    });

    it('advances the route-mounted journey from S3 to S4 and S5 as the embedded setup controller advances', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        setupControllerState.current.onPrimary.mockImplementation(() => {
            if (setupControllerState.current.stepId === 'setup_this_computer') {
                setupControllerState.current.stepId = 'providers_optional';
                setupControllerState.current.contentTransitionKey = 'providers_optional';
                return;
            }
            setupControllerState.current.stepId = 'done';
            setupControllerState.current.contentTransitionKey = 'done';
        });
        beginOnboardingJourneySession();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('route-journey-desktop-current-beat:S3')).not.toBeNull();
        // Composition invariant (P1): while the journey session is active the host owns
        // the whole viewport — the authenticated shell (session sidebar) must NOT mount.
        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);

        await screen.pressByTestIdAsync('route-journey-desktop-config-primary');
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('route-journey-desktop-current-beat:S4')).not.toBeNull();
        expect(setupControllerState.current.stepId).toBe('providers_optional');
        // S4 (providers beat) stays inside the journey host, never beside the live shell.
        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);

        await screen.pressByTestIdAsync('route-journey-desktop-config-primary');
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('route-journey-desktop-current-beat:S5')).not.toBeNull();
        expect(setupControllerState.current.stepId).toBe('done');
    });

    it('settles the setup intent and lands on authenticated home when Act-2 setup is skipped', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        setupControllerState.current.onSkip.mockImplementation(() => {
            const onExit = setupControllerState.lastProps?.onExit;
            if (typeof onExit === 'function') {
                onExit();
            }
        });
        beginOnboardingJourneySession();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('route-journey-desktop-current-beat:S3')).not.toBeNull();
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);

        await screen.pressByTestIdAsync('route-journey-desktop-config-skip');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });
        expect(journeyRouteState.unmountIds).toEqual([1]);
        expect(screen.findAllByType('MainView' as never)).toHaveLength(1);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
    });

    it('synthesizes a dismissed setup intent when Act-2 setup is skipped without a pending intent', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue(null);
        setupControllerState.current.onSkip.mockImplementation(() => {
            const onExit = setupControllerState.lastProps?.onExit;
            if (typeof onExit === 'function') {
                onExit();
            }
        });
        beginOnboardingJourneySession();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });
        const activeServerUrl = getActiveServerSnapshot().serverUrl?.replace(/\/+$/, '') || null;

        expect(screen.findByTestId('route-journey-desktop-current-beat:S3')).not.toBeNull();

        await screen.pressByTestIdAsync('route-journey-desktop-config-skip');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: activeServerUrl,
        });
        expect(journeyRouteState.unmountIds).toEqual([1]);
        expect(screen.findAllByType('MainView' as never)).toHaveLength(1);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
    });

    it('re-latches the journey full-viewport for an authed pending setup continuation after the in-memory session is lost (flag-on)', async () => {
        // Live-reproduced escape (jv3-flow-r2 repro-07): reload mid-setup loses the
        // in-memory journeySessionActive latch while the persisted pendingSetupIntent
        // survives; the route then rendered the authenticated shell + legacy modal.
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        // Deliberately NOT calling beginOnboardingJourneySession(): journey inactive.

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        // Full-viewport journey host owns the route; the authenticated shell never mounts.
        expect(journeyRouteState.mountIds).toEqual([1]);
        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
    });

    it('mounts the journey for an authed returning user with an explicit replay deep-link (flag-on)', async () => {
        // Live find (jv3-liveqa row 13): `?happier_journey_beat=<id>` is a production
        // replay entry point, but the Home gate only consulted auth/session/intent —
        // an authed returning user with the param got the authenticated shell and the
        // journey never mounted (the param was read only inside the entry, which the
        // gate never rendered).
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S1';
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue(null);
        const globalWithLocation = globalThis as unknown as { location?: unknown };
        const originalLocation = globalWithLocation.location;
        globalWithLocation.location = {
            href: 'http://localhost/?happier_journey_beat=A1',
            search: '?happier_journey_beat=A1',
        };

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

            expect(journeyRouteState.mountIds).toEqual([1]);
            expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        } finally {
            globalWithLocation.location = originalLocation;
        }
    });

    it('keeps the flag-off login continuation on the classic setup wizard path', async () => {
        journeyRouteState.enabled = false;
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 2, turns: 2 });

        isAuthenticated = true;
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(journeyRouteState.mountIds).toEqual([]);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
    });

    it('falls back to classic setup continuation when the journey is abandoned before login completes', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S2';
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        journeyRouteState.enabled = false;
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });
        expect(journeyRouteState.unmountIds).toEqual([1]);

        isAuthenticated = true;
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(1);
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
    });

    it('persists the A7 completion settings through the route-mounted journey host', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S5';
        journeyRouteState.initialAttentionChoice = 'promote_attention_and_working';
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        isAuthenticated = true;
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(journeyRouteState.mountIds).toEqual([1]);
        expect(journeyRouteState.unmountIds).toEqual([]);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);

        await screen.pressByTestIdAsync('route-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(syncSingletonState.applySettings).toHaveBeenCalledWith({
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
        }, { source: 'ui' });
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('completes a setup-entry journey without ever seeding, and still settles the exit', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S5';
        journeyRouteState.initialAttentionChoice = 'promote_attention_and_working';
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        // Setup-entry mounts never seed the demo world, so no boundary teardown runs.
        expect(demoWorldState.clearCalls).toBe(0);
        expect(journeyRouteState.unmountIds).toEqual([]);

        isAuthenticated = true;
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        await screen.pressByTestIdAsync('route-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        // Exit settlement still runs its idempotent teardown (a no-op without a seeded world).
        expect(demoWorldState.clearCalls).toBe(1);
        expect(journeyRouteState.unmountIds).toEqual([1]);
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        expect(syncSingletonState.applySettings).toHaveBeenCalledWith({
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
        }, { source: 'ui' });
    });

    it('hands over auth on a setup-entry journey without any demo activity or legacy setup modal', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S2';
        isAuthenticated = false;

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        // Setup-entry mounts never seed the demo world, so no boundary teardown runs.
        expect(demoWorldState.clearCalls).toBe(0);
        expect(journeyRouteState.unmountIds).toEqual([]);

        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(demoWorldState.clearCalls).toBe(0);
        expect(journeyRouteState.unmountIds).toEqual([]);
        expect(screen.getTextContent()).toContain('Setup controller body');
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
    });

    it('does not re-latch the journey for an authed pending continuation once the account already has a machine (offline)', async () => {
        // Binding decision: the post-auth machine-setup step auto-displays only while the
        // account has ZERO machines. A reload lost the in-memory journey latch and a
        // post_auth continuation survives, but the account already has a machine (even
        // offline), so the route must fall through to the authenticated shell — never
        // auto re-latch the full-viewport setup act — and settle the stale intent.
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        tauriDesktopState.value = false;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        // Deliberately NOT calling beginOnboardingJourneySession(): journey inactive.
        seedActiveServerMachine();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(journeyRouteState.mountIds).toEqual([]);
        expect(screen.findAllByType('MainView' as never)).toHaveLength(1);
        expect(screen.findAllByType('SetupWizardSurface' as never)).toHaveLength(0);
        // The stale continuation intent is settled via the canonical setter, not left to TTL.
        expect(clearPendingSetupIntentMock).toHaveBeenCalled();
    });

    it('keeps the live journey mounted at S3 when the first machine arrives mid-setup (does not yank the step away)', async () => {
        // The gate applies to whether the step AUTO-DISPLAYS on entry — not mid-step. During
        // a live journey session at S3, the arrival of the user's FIRST machine is the success
        // state (the arrival card), so the active session must keep owning the viewport.
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S3';
        isAuthenticated = true;
        tauriDesktopState.value = false;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        beginOnboardingJourneySession();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('route-journey-desktop-current-beat:S3')).not.toBeNull();
        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);

        act(() => {
            seedActiveServerMachine();
        });
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        // Still the live S3 setup step — the arrival did not tear the journey down.
        expect(screen.findByTestId('route-journey-desktop-current-beat:S3')).not.toBeNull();
        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        expect(journeyRouteState.unmountIds).toEqual([]);
    });

    it('mounts the journey for a replay deep-link even when the account already has a machine (replay is explicit, not gated)', async () => {
        journeyRouteState.enabled = true;
        journeyRouteState.initialBeatId = 'S1';
        isAuthenticated = true;
        tauriDesktopState.value = false;
        getPendingSetupIntentMock.mockReturnValue(null);
        seedActiveServerMachine();
        const globalWithLocation = globalThis as unknown as { location?: unknown };
        const originalLocation = globalWithLocation.location;
        globalWithLocation.location = {
            href: 'http://localhost/?happier_journey_beat=A1',
            search: '?happier_journey_beat=A1',
        };

        try {
            const Screen = (await import('@/app/(app)/index')).default;
            const screen = await renderScreen(React.createElement(Screen));
            await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

            expect(journeyRouteState.mountIds).toEqual([1]);
            expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        } finally {
            globalWithLocation.location = originalLocation;
        }
    });
});
