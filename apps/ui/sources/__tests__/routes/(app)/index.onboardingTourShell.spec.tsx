import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoRouterMock,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { clearDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { resetDemoFirewallForTests, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { resetDemoModeDepthForTests } from '@/demoMode/runtime/enterExitDemoMode';
import { endOnboardingJourneySession } from '@/components/onboarding/tour/state/journeySession';
import { storage } from '@/sync/domains/state/storage';

const reactNativeState = vi.hoisted(() => ({
    width: 1100,
    height: 720,
}));

const authMock = vi.hoisted(() => ({
    isAuthenticated: false,
    login: vi.fn(async () => {}),
    loginWithCredentials: vi.fn(async () => {}),
}));

const authEntryOptionsState = vi.hoisted(() => ({
    current: {
        serverAvailability: 'ready',
        serverUrlForCopy: 'https://relay.example.test',
        showAuthActions: true,
        showProviderSignup: false,
        showAnonymousSignup: true,
        showMtlsLogin: false,
        showKeylessProviderLogin: false,
        providerId: null,
        keylessProviderId: null,
        providerSignupTitle: '',
        providerKeylessTitle: '',
        anonymousSignupTitle: 'welcome.createAccount',
        mtlsTitle: '',
        primaryAction: {
            kind: 'anonymous' as const,
            title: 'welcome.createAccount',
        },
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
        retryServerCheck: vi.fn(),
    },
}));

const pendingSetupIntentMock = vi.hoisted(() => ({
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
}));

const onboardingTourDecisionState = vi.hoisted(() => ({
    state: 'enabled' as 'enabled' | 'disabled' | 'unsupported' | 'unknown' | null,
}));

const journeyHostImportState = vi.hoisted(() => {
    let releaseDeferredImport: (() => void) | null = null;
    const state = {
        deferImport: false,
        importPromise: null as Promise<void> | null,
        resetDeferredImport: () => {
            state.importPromise = new Promise<void>((resolve) => {
                releaseDeferredImport = resolve;
            });
        },
        releaseImport: () => {
            releaseDeferredImport?.();
            releaseDeferredImport = null;
        },
    };
    return state;
});

async function settleLazyImports(): Promise<void> {
    await act(async () => {
        await vi.dynamicImportSettled();
    });
}

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: {
            ...stub.Platform,
            OS: 'web',
            select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
                options?.web ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
        },
        useWindowDimensions: () => ({
            width: reactNativeState.width,
            height: reactNativeState.height,
            scale: 2,
            fontScale: 1,
        }),
        Pressable: (props: Record<string, unknown>) => {
            const { children, ...rest } = props;
            return React.createElement(
                'Pressable',
                rest,
                typeof children === 'function'
                    ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
                    : (children as React.ReactNode),
            );
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/demoMode/seed/seedDemoWorld', () => ({
    seedDemoWorld: vi.fn(async () => ({})),
    clearDemoWorld: vi.fn(async () => {}),
}));

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
        back: vi.fn(),
    },
});
vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: { children?: React.ReactNode } & Record<string, unknown>) =>
        React.createElement('BaseModal', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/text/i18n', () => ({
    setPreferredLanguageFromSettings: vi.fn(),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('ExpoImage', props),
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    default: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@react-native/virtualized-lists', () => ({
    VirtualizedList: 'VirtualizedList',
    VirtualizedSectionList: 'VirtualizedSectionList',
}));

vi.mock('react-native-keyboard-controller', () => ({}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: (props: { children?: React.ReactNode }) => React.createElement('SafeAreaProvider', props, props.children),
    SafeAreaView: (props: { children?: React.ReactNode }) => React.createElement('SafeAreaView', props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
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

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string, scope?: unknown) => {
        if (featureId !== 'app.ui.onboardingTour') return null;
        if (onboardingTourDecisionState.state == null) return null;
        return {
            featureId,
            state: onboardingTourDecisionState.state,
            blockedBy: onboardingTourDecisionState.state === 'enabled' ? null : 'server',
            blockerCode: onboardingTourDecisionState.state === 'enabled' ? 'none' : 'feature_disabled',
            diagnostics: [],
            evaluatedAt: 0,
            scope: scope ?? { scopeKind: 'runtime' },
        };
    },
}));

vi.mock('@/components/onboarding', async () => {
    const module = await import('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry');
    const { PreAuthOnboardingWizardEntry } = module;
    return { PreAuthOnboardingWizardEntry };
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authMock.isAuthenticated,
        login: authMock.login,
        loginWithCredentials: authMock.loginWithCredentials,
        credentials: null,
    }),
}));

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: vi.fn(async () => 'account-token'),
}));

vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => null,
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        setPendingExternalAuth: vi.fn(async () => {}),
        clearPendingExternalAuth: vi.fn(async () => {}),
        getAuthAutoRedirectSuppressedUntil: vi.fn(async () => 0),
    },
    isLegacyAuthCredentials: () => false,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size).fill(3)),
    getRandomBytesAsync: vi.fn(async (size: number) => new Uint8Array(size).fill(7)),
}));

vi.mock('@/platform/digest', () => ({
    digest: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => authEntryOptionsState.current,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: '',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => '',
    readConfiguredServerUrlEnvRaw: () => '',
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: vi.fn(async () => new Response('{}', { status: 500 })),
    setRuntimeFetch: vi.fn(),
    resetRuntimeFetch: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: null,
    trackAccountCreated: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => pendingSetupIntentMock.get(),
    setPendingSetupIntent: (value: unknown) => pendingSetupIntentMock.set(value),
    clearPendingSetupIntent: () => pendingSetupIntentMock.clear(),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: (props: Record<string, unknown>) => React.createElement('MainView', props),
}));

vi.mock('@/components/onboarding/surfaces/SetupWizardSurface', () => ({
    SetupWizardSurface: (props: Record<string, unknown>) => React.createElement('SetupWizardSurface', props),
}));

vi.mock('@/components/onboarding/surfaces/useSetupWizardController', () => ({
    useSetupWizardController: () => ({
        stepId: 'setup_this_computer',
        currentStepIndex: 0,
        stepCount: 2,
        contentTransitionKey: 'setup_this_computer',
        contentTransitionDirection: 'replace',
        title: 'setup',
        subtitle: null,
        scrollable: false,
        body: null,
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
    }),
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({ onlineCount: 0 }),
}));

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        },
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost', () => ({
    DesktopShellWindowControlsHost: (props: { children?: React.ReactNode }) =>
        React.createElement('DesktopShellWindowControlsHost', props, props.children),
}));

vi.mock('@/components/navigation/shell/desktopChrome/DesktopShellUpdateIndicatorHost', () => ({
    DesktopShellUpdateIndicatorHost: (props: { children?: React.ReactNode }) =>
        React.createElement('DesktopShellUpdateIndicatorHost', props, props.children),
}));

vi.mock('@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls', () => ({
    useResolvedDesktopWindowControls: () => null,
}));

vi.mock('@/components/ui/feedback/AppUpdateStatusTag', () => ({
    AppUpdateStatusTag: (props: Record<string, unknown>) => React.createElement('AppUpdateStatusTag', props),
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_seed_keypair: () => ({
            publicKey: new Uint8Array([1]),
            privateKey: new Uint8Array([2]),
        }),
        crypto_sign_seed_keypair: () => ({
            publicKey: new Uint8Array([1]),
            privateKey: new Uint8Array([2]),
        }),
    },
}));

// Keep the route-composition test out of the full visual surface graph while
// preserving the real journey host, progress model, and SplitStageLayout.
vi.mock('@/components/onboarding/tour/OnboardingJourneyHost', async (importOriginal) => {
    if (journeyHostImportState.deferImport) {
        await journeyHostImportState.importPromise;
    }
    return importOriginal<typeof import('@/components/onboarding/tour/OnboardingJourneyHost')>();
});

vi.mock('@/components/onboarding/tour/stage/DemoStage', () => ({
    DemoStage: (props: { activeFrameId: string } & Record<string, unknown>) =>
        React.createElement('DemoStage', {
            ...props,
            testID: 'journey-demo-stage',
        }, `stage:${String(props.activeFrameId)}`),
}));

const originalStorageState = storage.getState();

describe('/ (welcome) onboarding tour shell composition', () => {
    beforeEach(() => {
        authMock.isAuthenticated = false;
        authMock.login.mockClear();
        authMock.loginWithCredentials.mockClear();
        onboardingTourDecisionState.state = 'enabled';
        journeyHostImportState.deferImport = false;
        journeyHostImportState.importPromise = null;
        journeyHostImportState.releaseImport();
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        pendingSetupIntentMock.get.mockReset();
        pendingSetupIntentMock.get.mockReturnValue(null);
        pendingSetupIntentMock.set.mockReset();
        pendingSetupIntentMock.clear.mockReset();
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
        resetDemoModeDepthForTests();
        resetDemoFirewallForTests();
        storage.setState(originalStorageState, true);
    });

    afterEach(async () => {
        standardCleanup();
        uninstallDemoFirewall();
        resetDemoFirewallForTests();
        let clearError: unknown;
        try {
            await clearDemoWorld();
        } catch (error) {
            clearError = error;
        }
        resetDemoModeDepthForTests();
        endOnboardingJourneySession();
        storage.setState(originalStorageState, true);
        if (clearError) throw clearError;
    });

    it('does not mount the classic wizard before the enabled journey chunk resolves', async () => {
        journeyHostImportState.deferImport = true;
        journeyHostImportState.resetDeferredImport();

        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        try {
            expect(screen.findByTestId('onboarding-journey-loading')).toBeTruthy();
            expect(screen.findAllByTestId('onboarding-wizard')).toHaveLength(0);
            expect(screen.findAllByTestId('unauth-shell-workflow-pane')).toHaveLength(0);
            expect(screen.findAllByTestId('unauth-shell-brand-pane')).toHaveLength(0);
        } finally {
            await act(async () => {
                journeyHostImportState.releaseImport();
                await vi.dynamicImportSettled();
            });
        }

        await flushHookEffects({ cycles: 30, turns: 6, frames: 1 });
        await screen.update(React.createElement(Screen));
        await flushHookEffects({ cycles: 12, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-narration-pane')).toBeTruthy();
        expect(screen.findByTestId('onboarding-journey-desktop-stage-pane')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard')).toHaveLength(0);
    });

    it('replaces the classic unauth shell with the journey-owned split stage when the tour flag is enabled', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        const screen = await renderScreen(React.createElement(Screen));
        await settleLazyImports();
        await flushHookEffects({ cycles: 30, turns: 6, frames: 1 });
        await screen.update(React.createElement(Screen));
        await settleLazyImports();
        await flushHookEffects({ cycles: 12, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-narration-pane')).toBeTruthy();
        expect(screen.findByTestId('onboarding-journey-desktop-stage-pane')).toBeTruthy();
        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A1')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-workflow-pane')).toHaveLength(0);

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A2')).toBeTruthy();
        let demoStage = screen.findByType('DemoStage' as never);
        expect(demoStage.props.activeFrameId).toBe('sessions-list.hero');
        expect(screen.findByTestId('journey-demo-stage')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-stage-brand-host')).toHaveLength(0);
        expect(screen.findAllByTestId('unauth-shell-workflow-pane')).toHaveLength(0);
        expect(screen.findAllByTestId('unauth-shell-brand-pane')).toHaveLength(0);

        // All fourteen dream beats are live (JV3-BEATS/D22): advance sequentially and
        // spot-check the frame wiring on the camera/halo beats the gate reviews.
        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A3')).toBeTruthy();

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A4')).toBeTruthy();
        demoStage = screen.findByType('DemoStage' as never);
        expect(demoStage.props.activeFrameId).toBe('session-view.phone');

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A5')).toBeTruthy();

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A6')).toBeTruthy();
        demoStage = screen.findByType('DemoStage' as never);
        expect(demoStage.props.activeFrameId).toBe('session-view.spotlight');

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:A7')).toBeTruthy();
        demoStage = screen.findByType('DemoStage' as never);
        expect(demoStage.props.activeFrameId).toBe('sessions-list.spotlight');

        for (const beatId of ['A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14'] as const) {
            await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
            await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });
            expect(screen.findByTestId(`onboarding-journey-desktop-current-beat:${beatId}`)).toBeTruthy();
        }

        await screen.pressByTestIdAsync('onboarding-journey-desktop-config-primary');
        await flushHookEffects({ cycles: 8, turns: 4, frames: 1 });

        expect(screen.findByTestId('onboarding-journey-desktop-current-beat:S1')).toBeTruthy();
        expect(screen.findAllByType('DemoStage' as never)).toHaveLength(0);
        expect(screen.findByTestId('unauth-shell-stage-wallpaper-host')).toBeTruthy();
        expect(screen.findAllByTestId('unauth-shell-workflow-pane')).toHaveLength(0);
        expect(screen.findAllByTestId('unauth-shell-brand-pane')).toHaveLength(0);
    });
});
