import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { storage } from '@/sync/domains/state/storage';
import { takeStoreSnapshot } from '@/demoMode/seed/storeSnapshot';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { isDemoModeActive, resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';
import {
    getDemoFirewallDenyLog,
    resetDemoFirewallForTests,
    uninstallDemoFirewall,
} from '@/demoMode/guards/demoFirewall';
import { isServerProfilePersistenceSuspendedForDemo } from '@/sync/domains/server/serverProfiles';
import type {
    OnboardingWizardController,
    OnboardingWizardSurfaceProps,
} from '@/components/onboarding/surfaces/useOnboardingWizardController';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

const authState = vi.hoisted(() => ({
    isAuthenticated: false,
    credentials: null as null | { token: string; secret: string },
}));

const setupIntentState = vi.hoisted(() => ({
    current: null as PendingSetupIntent | null,
}));

const demoWorldState = vi.hoisted(() => ({
    bypassWorldMutation: false,
    clearFailures: [] as Error[],
    clearCalls: 0,
    clearCallsAtSeed: [] as number[],
    deferNextSeed: false,
    resolveSeed: null as null | (() => Promise<void>),
}));

const stageSurfaceModuleState = vi.hoisted(() => ({
    voiceLoads: 0,
}));

const setupControllerState = vi.hoisted(() => ({
    calls: 0,
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

const syncSingletonState = vi.hoisted(() => ({
    applySettings: vi.fn(),
}));

const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1280, height: 820, scale: 2, fontScale: 1 }),
    });
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

vi.mock('@/demoMode/seed/seedDemoWorld', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/demoMode/seed/seedDemoWorld')>();
    return {
        ...actual,
        seedDemoWorld: vi.fn(async (...args: Parameters<typeof actual.seedDemoWorld>) => {
            demoWorldState.clearCallsAtSeed.push(demoWorldState.clearCalls);
            if (demoWorldState.bypassWorldMutation) {
                const { buildDemoWorld } = await import('@/demoMode/world/buildDemoWorld');
                return buildDemoWorld();
            }
            if (!demoWorldState.deferNextSeed) {
                return actual.seedDemoWorld(...args);
            }
            return new Promise<Awaited<ReturnType<typeof actual.seedDemoWorld>>>((resolve, reject) => {
                demoWorldState.resolveSeed = async () => {
                    try {
                        resolve(await actual.seedDemoWorld(...args));
                    } catch (error) {
                        reject(error);
                    }
                };
            });
        }),
        clearDemoWorld: vi.fn(async (...args: Parameters<typeof actual.clearDemoWorld>) => {
            demoWorldState.clearCalls += 1;
            if (demoWorldState.bypassWorldMutation) {
                return { residueFindings: [] };
            }
            const error = demoWorldState.clearFailures.shift();
            if (error) throw error;
            return actual.clearDemoWorld(...args);
        }),
    };
});

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

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authState.isAuthenticated,
        credentials: authState.credentials,
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
    },
}));

vi.mock('@/components/onboarding/state/usePendingSetupIntent', () => ({
    usePendingSetupIntent: () => setupIntentState.current,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: setPendingSetupIntentMock,
}));

vi.mock('@/components/onboarding/surfaces/useSetupWizardController', () => ({
    useSetupWizardController: (props: Record<string, unknown>) => {
        setupControllerState.calls += 1;
        setupControllerState.lastProps = props;
        return {
            ...setupControllerState.current,
            body: React.createElement(Text, { testID: 'setup-controller-body' }, 'Setup controller body'),
        };
    },
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        applySettings: syncSingletonState.applySettings,
    }),
}));

vi.mock('./stage/DemoStage', () => ({
    DemoStage: (props: Record<string, unknown>) => (
        React.createElement('DemoStage', props, `stage:${String(props.activeFrameId)}`)
    ),
}));

vi.mock('./stage/surfaces/JourneyVoiceStageSurface', async () => {
    stageSurfaceModuleState.voiceLoads += 1;
    const ReactModule = await import('react');
    return {
        JourneyVoiceStageSurface: (props: Record<string, unknown>) => (
            ReactModule.createElement('JourneyVoiceStageSurface', props)
        ),
    };
});

const originalStorageState = storage.getState();

function createPreAuthController(overrides: Partial<OnboardingWizardController> = {}): OnboardingWizardController {
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
        body: <Text testID="pre-auth-controller-body">Pre-auth controller body</Text>,
        goToStep: vi.fn(),
        ...overrides,
    };
}

function createWizardSurfaceProps(): OnboardingWizardSurfaceProps {
    return {
        testID: 'wizard',
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
            primarySignupTitle: '',
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

async function flushJourneyEffects(): Promise<void> {
    await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });
}

describe('OnboardingJourneyHost', () => {
    beforeEach(() => {
        authState.isAuthenticated = false;
        authState.credentials = null;
        setupIntentState.current = null;
        demoWorldState.clearFailures = [];
        demoWorldState.clearCalls = 0;
        demoWorldState.clearCallsAtSeed = [];
        demoWorldState.bypassWorldMutation = false;
        demoWorldState.deferNextSeed = false;
        demoWorldState.resolveSeed = null;
        stageSurfaceModuleState.voiceLoads = 0;
        setupControllerState.calls = 0;
        setupControllerState.lastProps = null;
        setupControllerState.current.stepId = 'setup_this_computer';
        setupControllerState.current.contentTransitionKey = 'setup_this_computer';
        setupControllerState.current.onPrimary.mockClear();
        setupControllerState.current.onBack.mockClear();
        setupControllerState.current.onSkip.mockClear();
        setupControllerState.current.goToStep.mockClear();
        syncSingletonState.applySettings.mockReset();
        setPendingSetupIntentMock.mockReset();
        setPendingSetupIntentMock.mockImplementation((value) => {
            setupIntentState.current = value;
        });
        resetDemoModeDepthForTests();
        resetDemoFirewallForTests();
        storage.setState(originalStorageState, true);
    });

    afterEach(async () => {
        standardCleanup();
        await flushJourneyEffects();
        uninstallDemoFirewall();
        resetDemoFirewallForTests();
        demoWorldState.clearFailures = [];
        demoWorldState.bypassWorldMutation = false;
        demoWorldState.deferNextSeed = false;
        demoWorldState.resolveSeed = null;
        let clearError: unknown;
        try {
            await clearDemoWorld();
        } catch (error) {
            clearError = error;
        }
        resetDemoModeDepthForTests();
        storage.setState(originalStorageState, true);
        vi.restoreAllMocks();
        if (clearError) throw clearError;
    });

    it('uses the user-selected narration-right split orientation by default', async () => {
        const { ONBOARDING_JOURNEY_SPLIT_ORIENTATION } = await import('./OnboardingJourneyHost');

        expect(ONBOARDING_JOURNEY_SPLIT_ORIENTATION).toBe('narration-right');
    });

    it('does not load dream stage surfaces for the planet-only opening beat', async () => {
        demoWorldState.bypassWorldMutation = true;
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="A1"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
            { flushOptions: { cycles: 0 } },
        );
        await flushJourneyEffects();

        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
        expect(stageSurfaceModuleState.voiceLoads).toBe(0);
        expect(setupControllerState.calls).toBe(0);

        await screen.unmount();
        await flushJourneyEffects();
    });

    it('fully releases the surviving demo firewall generation when StrictMode skips to setup', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        const appFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const screen = await renderScreen(
            <React.StrictMode>
                <OnboardingJourneyHost
                    surface="desktop"
                    isDesktopShell
                    initialBeatId="A2"
                    preAuthController={createPreAuthController({
                        stepId: 'relay_select',
                        currentStepIndex: 0,
                        body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                    })}
                    wizardSurfaceProps={createWizardSurfaceProps()}
                    testID="journey-host"
                />
            </React.StrictMode>,
            { flushOptions: { cycles: 8, turns: 4, frames: 1 } },
        );

        expect({
            seedCalls: vi.mocked(seedDemoWorld).mock.calls.length,
            clearCalls: demoWorldState.clearCalls,
        }).toEqual({
            seedCalls: 2,
            clearCalls: 1,
        });
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(true);

        await screen.pressByTestIdAsync('journey-host-desktop-skip-pill');
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(demoWorldState.clearCalls).toBe(2);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(false);
        await expect(runtimeFetch('/v1/features')).resolves.toMatchObject({ status: 200 });
        await expect(globalThis.fetch('/v1/features')).resolves.toMatchObject({ status: 200 });
        expect(appFetch.mock.calls.map(([input]) => String(input))).toEqual([
            '/v1/features',
            '/v1/features',
        ]);
        expect(getDemoFirewallDenyLog()).toEqual([]);
    });

    it('retries a failed predecessor teardown before a StrictMode replacement can seed', async () => {
        demoWorldState.clearFailures.push(new Error('forced predecessor teardown failure'));
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        const appFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const screen = await renderScreen(
            <React.StrictMode>
                <OnboardingJourneyHost
                    surface="desktop"
                    isDesktopShell
                    initialBeatId="A2"
                    preAuthController={createPreAuthController({
                        stepId: 'relay_select',
                        currentStepIndex: 0,
                        body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                    })}
                    wizardSurfaceProps={createWizardSurfaceProps()}
                    testID="journey-host"
                />
            </React.StrictMode>,
            { flushOptions: { cycles: 8, turns: 4, frames: 1 } },
        );

        expect(demoWorldState.clearCallsAtSeed).toEqual([0, 2]);
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(true);

        await screen.pressByTestIdAsync('journey-host-desktop-skip-pill');
        await flushJourneyEffects();
        await screen.unmount();
        await flushJourneyEffects();

        expect(demoWorldState.clearCalls).toBe(3);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(isDemoModeActive()).toBe(false);
        expect(isServerProfilePersistenceSuspendedForDemo()).toBe(false);
        await expect(runtimeFetch('/v1/features')).resolves.toMatchObject({ status: 200 });
        await expect(globalThis.fetch('/v1/features')).resolves.toMatchObject({ status: 200 });
        expect(appFetch.mock.calls.map(([input]) => String(input))).toEqual([
            '/v1/features',
            '/v1/features',
        ]);
        expect(getDemoFirewallDenyLog()).toEqual([]);
    });

    it('seeds demo mode on mount and restores a byte-identical demo snapshot on mid-journey unmount', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());

        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="A2"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
            { flushOptions: { cycles: 8, turns: 4, frames: 1 } },
        );

        expect(takeStoreSnapshot(storage.getState())).not.toEqual(before);
        expect(screen.findByType('DemoStage' as never).props.activeFrameId).toBe('sessions-list.hero');

        await screen.unmount();
        await flushJourneyEffects();

        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(getDemoFirewallDenyLog()).toEqual([]);
    });

    it('shows the planet stage pane immediately while the desktop DemoStage waits for demo seeding', async () => {
        demoWorldState.deferNextSeed = true;
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const props = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'A1' as const,
            preAuthController: createPreAuthController(),
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(
            <OnboardingJourneyHost {...props} />,
            { flushOptions: { cycles: 0 } },
        );

        expect(screen.findByTestId('journey-host-desktop-stage-pane')).not.toBeNull();
        expect(screen.findByTestId('unauth-shell-stage-wallpaper-host')).not.toBeNull();
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);

        await flushJourneyEffects();
        expect(demoWorldState.resolveSeed).toBeTypeOf('function');
        await demoWorldState.resolveSeed?.();
        await flushJourneyEffects();
    });

    it('never seeds the demo world when the journey starts on a setup beat', async () => {
        // Regression (JV3-LIVEQA live find): starting at a setup beat (deep-link replay or
        // the authed S3 re-latch) seeded the demo world before the async act-two teardown
        // could run, so real setup controllers captured mid-demo state (the wizard relay
        // footer pinned the demo relay URL even after the store was restored).
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());

        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S1"
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Relay controller body');
        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);

        await screen.update(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S1"
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
    });

    it('tears down demo mode before skip-to-setup renders S1', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());

        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="A2"
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).not.toEqual(before);

        await screen.pressByTestIdAsync('journey-host-desktop-skip-pill');
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(demoWorldState.clearCalls).toBe(1);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
    });

    it('still skips to S1 and retries boundary teardown when the first teardown rejects', async () => {
        demoWorldState.clearFailures.push(new Error('forced skip teardown failure'));
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="A2"
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        await screen.pressByTestIdAsync('journey-host-desktop-skip-pill');
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(demoWorldState.clearCalls).toBe(2);
        expect(isDemoModeActive()).toBe(false);
        await vi.waitFor(() => {
            expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        });
    });

    it('still advances to S1 and retries boundary teardown when the first teardown rejects', async () => {
        demoWorldState.clearFailures.push(new Error('forced advance teardown failure'));
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="A14"
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        await screen.pressByTestIdAsync('journey-host-desktop-config-primary');
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(demoWorldState.clearCalls).toBe(2);
    });

    it('never attempts demo teardown when the journey starts on a setup beat (nothing was seeded)', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        const props = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S1' as const,
            preAuthController: createPreAuthController({
                stepId: 'relay_select',
                currentStepIndex: 0,
                body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
            }),
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);

        await screen.update(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
    });

    it('starts clean on S2 and hands over to the setup controller after auth without any demo activity', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        const props = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S2' as const,
            preAuthController: createPreAuthController(),
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(screen.getTextContent()).toContain('Pre-auth controller body');
        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);

        authState.isAuthenticated = true;
        authState.credentials = { token: 'real-token', secret: 'real-secret' };
        setupIntentState.current = { branch: 'thisComputer', phase: 'post_auth', relayUrl: 'https://relay.example.test' };
        await screen.update(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(screen.getTextContent()).toContain('Setup controller body');
        expect(setupControllerState.lastProps).toMatchObject({
            isDesktopShell: true,
            initialStepId: 'setup_this_computer',
            scope: 'machine',
        });
        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
    });

    it('starts clean on S2 for an already-authed re-latch without any demo activity', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const before = takeStoreSnapshot(storage.getState());
        authState.isAuthenticated = true;
        authState.credentials = { token: 'real-token', secret: 'real-secret' };
        setupIntentState.current = { branch: 'thisComputer', phase: 'post_auth', relayUrl: 'https://relay.example.test' };
        const props = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S2' as const,
            preAuthController: createPreAuthController(),
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(screen.getTextContent()).toContain('Setup controller body');
        expect(vi.mocked(seedDemoWorld)).not.toHaveBeenCalled();
        expect(demoWorldState.clearCalls).toBe(0);
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);

        await screen.update(<OnboardingJourneyHost {...props} />);
        await flushJourneyEffects();

        expect(demoWorldState.clearCalls).toBe(0);
        expect(screen.getTextContent()).toContain('Setup controller body');
        expect(takeStoreSnapshot(storage.getState())).toEqual(before);
    });

    it('advances from S1 to S2 when the embedded pre-auth controller enters auth', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const baseProps = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S1' as const,
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(
            <OnboardingJourneyHost
                {...baseProps}
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                })}
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(screen.findByTestId('journey-host-desktop-current-beat:S2')).toBeNull();

        await screen.update(
            <OnboardingJourneyHost
                {...baseProps}
                preAuthController={createPreAuthController({
                    stepId: 'auth_restore',
                    body: <Text testID="pre-auth-restore-body">Restore controller body</Text>,
                })}
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).toBeNull();
        expect(screen.findByTestId('journey-host-desktop-current-beat:S2')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Restore controller body');
    });

    it('drives S1 to the relay selection controller step without a debug step parameter', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const goToStep = vi.fn();
        const baseProps = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S1' as const,
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(
            <OnboardingJourneyHost
                {...baseProps}
                preAuthController={createPreAuthController({
                    stepId: 'welcome',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-welcome-body">Welcome controller body</Text>,
                    goToStep,
                })}
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(goToStep).toHaveBeenCalledWith('relay_select');

        await screen.update(
            <OnboardingJourneyHost
                {...baseProps}
                preAuthController={createPreAuthController({
                    stepId: 'relay_select',
                    currentStepIndex: 0,
                    body: <Text testID="pre-auth-relay-body">Relay controller body</Text>,
                    goToStep,
                })}
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Relay controller body');
        expect(screen.getTextContent()).not.toContain('Welcome controller body');
    });

    it('uses journey Back from S2 so the beat and pre-auth controller stay coherent', async () => {
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');
        const embeddedBack = vi.fn();
        const goToStep = vi.fn();
        const baseProps = {
            surface: 'desktop' as const,
            isDesktopShell: true,
            initialBeatId: 'S2' as const,
            wizardSurfaceProps: createWizardSurfaceProps(),
            testID: 'journey-host',
        };

        const screen = await renderScreen(
            <OnboardingJourneyHost
                {...baseProps}
                preAuthController={createPreAuthController({
                    stepId: 'auth',
                    onBack: embeddedBack,
                    body: <Text testID="pre-auth-auth-body">Auth controller body</Text>,
                    goToStep,
                })}
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S2')).not.toBeNull();

        await screen.pressByTestIdAsync('journey-host-desktop-config-back');
        await flushJourneyEffects();

        expect(embeddedBack).not.toHaveBeenCalled();
        expect(screen.findByTestId('journey-host-desktop-current-beat:S1')).not.toBeNull();
        expect(goToStep).toHaveBeenCalledWith('relay_select');
    });

    it('keeps journey-driven setup entry and controller-driven setup progress in one bidirectional contract', async () => {
        authState.isAuthenticated = true;
        authState.credentials = { token: 'real-token', secret: 'real-secret' };
        setupIntentState.current = { branch: 'thisComputer', phase: 'post_auth', relayUrl: 'https://relay.example.test' };
        setupControllerState.current.stepId = 'setup_this_computer';
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');

        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S4"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(setupControllerState.current.goToStep).toHaveBeenCalledWith('providers_optional');

        setupControllerState.current.stepId = 'providers_optional';
        setupControllerState.current.contentTransitionKey = 'providers_optional';
        await screen.update(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S4"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S4')).not.toBeNull();

        setupControllerState.current.stepId = 'done';
        setupControllerState.current.contentTransitionKey = 'done';
        await screen.update(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S4"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                testID="journey-host"
            />,
        );
        await flushJourneyEffects();

        expect(screen.findByTestId('journey-host-desktop-current-beat:S5')).not.toBeNull();
    });

    it('persists the A7 promoted attention choice through the real settings writer when the journey completes', async () => {
        const onExit = vi.fn();
        setupIntentState.current = { branch: 'thisComputer', phase: 'post_auth', relayUrl: 'https://relay.example.test' };
        const { OnboardingJourneyHost } = await import('./OnboardingJourneyHost');

        const screen = await renderScreen(
            <OnboardingJourneyHost
                surface="desktop"
                isDesktopShell
                initialBeatId="S5"
                initialAttentionChoice="promote_attention_and_working"
                preAuthController={createPreAuthController()}
                wizardSurfaceProps={createWizardSurfaceProps()}
                onExit={onExit}
                testID="journey-host"
            />,
        );

        await screen.pressByTestIdAsync('journey-host-desktop-config-primary');
        await flushJourneyEffects();

        expect(syncSingletonState.applySettings).toHaveBeenCalledWith({
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
        }, { source: 'ui' });
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });
        expect(onExit).toHaveBeenCalledTimes(1);
    });
});

describe('resolveJourneyLayoutMode', () => {
    it('is width-based on web/desktop: story at or below the mobile breakpoint, split above (F-W13-3)', async () => {
        const { resolveJourneyLayoutMode } = await import('./OnboardingJourneyHost');
        const { MOBILE_MAX_WIDTH_PX } = await import('../unauthShell/useUnauthShellLayout');

        // Below/at the classic shell's mobile breakpoint the journey uses the
        // mobile story presentation on web too — never a squeezed desktop split.
        expect(resolveJourneyLayoutMode({ surface: 'web', windowWidth: 680 })).toBe('story');
        expect(resolveJourneyLayoutMode({ surface: 'desktop', windowWidth: MOBILE_MAX_WIDTH_PX })).toBe('story');
        // Above the breakpoint (720–1000 band included) the split stays, with
        // the planet full-bleed in its (narrower) pane.
        expect(resolveJourneyLayoutMode({ surface: 'web', windowWidth: MOBILE_MAX_WIDTH_PX + 1 })).toBe('split');
        expect(resolveJourneyLayoutMode({ surface: 'web', windowWidth: 900 })).toBe('split');
        expect(resolveJourneyLayoutMode({ surface: 'desktop', windowWidth: 1440 })).toBe('split');
        // Native always uses the story presentation regardless of width.
        expect(resolveJourneyLayoutMode({ surface: 'native', windowWidth: 1440 })).toBe('story');
    });
});

describe('adaptPreAuthController', () => {
    it('strips the pre-auth advance-duplicate skip so the primary is the single advance on every layout (F-W12-2)', async () => {
        const { adaptPreAuthController } = await import('./OnboardingJourneyHost');
        const controller = createPreAuthController({
            stepId: 'relay_select',
            currentStepIndex: 0,
            onSkip: vi.fn(),
            showSkip: true,
            skipLabel: 'Next',
        });

        const adapted = adaptPreAuthController(controller, null);

        // The relay_select/auth per-step "skip" is a second advance affordance
        // (its label is literally "Next"); the journey column/thumb-zone must
        // never surface it — on desktop split NOR on the story layout.
        expect(adapted.onSkip).toBeNull();
        expect(adapted.showSkip).toBe(false);
    });
});
