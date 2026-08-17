import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type {
    DesktopWindowChromePolicy,
    DesktopWindowState,
} from '@/utils/platform/desktopWindowBridge';

const reactNativeState = vi.hoisted(() => ({
    windowWidth: 390,
    windowHeight: 844,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));

const loginMock = vi.hoisted(() =>
    vi.fn(async () => ({ kind: 'completed' as const })),
);
const loginWithCredentialsMock = vi.hoisted(() =>
    vi.fn(async () => ({ kind: 'completed' as const })),
);
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const serverRuntimeState = vi.hoisted(() => ({
    serverUrl: null as string | null,
}));
const applyBrandHeroSeenMock = vi.hoisted(() => vi.fn());
const onboardingTourFeatureState = vi.hoisted(() => ({
    state: 'disabled' as 'enabled' | 'disabled' | 'unsupported' | 'unknown' | null,
    calls: [] as Array<readonly [string, unknown]>,
}));
const journeyHostState = vi.hoisted(() => {
    let releaseDeferredModuleLoad: (() => void) | null = null;
    const state = {
        moduleLoads: 0,
        renderCount: 0,
        throwOnRender: false,
        deferModuleLoad: false,
        moduleLoadPromise: null as Promise<void> | null,
        lastProps: null as Record<string, unknown> | null,
        resetModuleLoadDeferred: () => {
            state.moduleLoadPromise = new Promise<void>((resolve) => {
                releaseDeferredModuleLoad = resolve;
            });
        },
        releaseModuleLoad: () => {
            releaseDeferredModuleLoad?.();
            releaseDeferredModuleLoad = null;
        },
    };
    return state;
});
const wizardControllerMock = vi.hoisted(() => {
    const goToStep = vi.fn();
    return {
        goToStep,
        lastProps: null as (Record<string, unknown> & {
            initialStepId?: unknown;
            onLoginWithMtls?: () => Promise<void> | void;
        }) | null,
        current: {
            stepId: 'welcome',
            currentStepIndex: 0,
            stepCount: 4,
            contentTransitionDirection: 'replace',
            showBack: false,
            showSkip: undefined,
            onBack: null,
            onSkip: null,
            onPrimary: null,
            primaryLabel: null,
            primaryDisabled: false,
            skipLabel: null,
            skipDisabled: false,
            title: 'welcome',
            subtitle: null,
            footerHint: null,
            body: null as React.ReactNode,
            goToStep,
        },
    };
});
const authEntryOptionsState = vi.hoisted(() => ({
    current: {
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
        retentionSummary: null as string | null,
        autoRedirect: {
            enabled: false,
            providerId: null,
            toKeyedProvision: false,
            toKeylessLogin: false,
            toMtls: false,
            toLegacySignupProvider: false,
        },
        retryServerCheck: () => {},
    },
}));
const localSettingsState = vi.hoisted(() => ({
    hasCompletedAuthOnce: false as boolean,
}));
const journeySessionState = vi.hoisted(() => ({
    active: false as boolean,
}));
const authState = vi.hoisted(() => ({
    isAuthenticated: false as boolean,
}));
const pendingSetupIntentState = vi.hoisted(() => ({
    value: null as null | Readonly<{ branch: string; phase: string; relayUrl: string | null }>,
}));
const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn<() => Promise<DesktopWindowChromePolicy>>(async () => ({ strategy: 'none' })),
    getDesktopWindowState: vi.fn<() => Promise<DesktopWindowState>>(async () => ({ isMaximized: false })),
    listenDesktopWindowState: vi.fn<(handler: (state: DesktopWindowState) => void) => Promise<() => Promise<void>>>(async () => async () => {}),
    minimizeDesktopWindow: vi.fn(async () => {}),
    toggleDesktopWindowMaximize: vi.fn(async () => {}),
    closeDesktopWindow: vi.fn(async () => {}),
    startDesktopWindowDragging: vi.fn(async () => {}),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: reactNativeState.windowWidth,
            height: reactNativeState.windowHeight,
            scale: 2,
            fontScale: 1,
        }),
    });
});

const expoRouterMock = createExpoRouterMock({
    router: {
        push: routerMocks.push,
        replace: routerMocks.replace,
        back: routerMocks.back,
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authState.isAuthenticated,
        login: loginMock,
        loginWithCredentials: loginWithCredentialsMock,
    }),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => authEntryOptionsState.current,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string, scope?: unknown) => {
        onboardingTourFeatureState.calls.push([featureId, scope] as const);
        if (onboardingTourFeatureState.state == null) {
            return null;
        }
        return {
            featureId,
            state: onboardingTourFeatureState.state,
            blockedBy: onboardingTourFeatureState.state === 'enabled' ? null : 'server',
            blockerCode: onboardingTourFeatureState.state === 'enabled' ? 'none' : 'feature_disabled',
            diagnostics: [],
            evaluatedAt: 0,
            scope: scope ?? { scopeKind: 'runtime' },
        };
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsLandscape: () => false,
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => (localSettingsState as Record<string, unknown>)[key],
}));

vi.mock('@/components/onboarding/tour/state/journeySession', () => ({
    useOnboardingJourneySessionActive: () => journeySessionState.active,
}));

vi.mock('@/components/onboarding/state/usePendingSetupIntent', () => ({
    usePendingSetupIntent: () => pendingSetupIntentState.value,
}));

const tauriDesktopState = vi.hoisted(() => ({ value: false }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
    getDesktopWindowChromePolicy: () => desktopWindowBridgeState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => desktopWindowBridgeState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: { isMaximized: boolean }) => void) =>
        desktopWindowBridgeState.listenDesktopWindowState(handler),
    minimizeDesktopWindow: () => desktopWindowBridgeState.minimizeDesktopWindow(),
    toggleDesktopWindowMaximize: () => desktopWindowBridgeState.toggleDesktopWindowMaximize(),
    closeDesktopWindow: () => desktopWindowBridgeState.closeDesktopWindow(),
    startDesktopWindowDragging: () => desktopWindowBridgeState.startDesktopWindowDragging(),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    clearPendingSetupIntent: () => {},
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: serverRuntimeState.serverUrl,
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnvRaw: () => '',
    readConfiguredServerUrlEnv: () => '',
}));

vi.mock('@/components/onboarding/surfaces/OnboardingWizardSurface', () => ({
    OnboardingWizardSurface: (props: Record<string, unknown>) =>
        React.createElement('OnboardingWizardSurface', props, props.shellChrome as React.ReactNode),
    OnboardingWizardSurfacePresentation: (props: Record<string, unknown>) =>
        React.createElement('OnboardingWizardSurfacePresentation', props, props.shellChrome as React.ReactNode),
}));

vi.mock('@/components/onboarding/surfaces/useOnboardingWizardController', () => ({
    useOnboardingWizardController: (props: Record<string, unknown>) => {
        wizardControllerMock.lastProps = props;
        return wizardControllerMock.current;
    },
}));

vi.mock('@/components/onboarding/tour/OnboardingJourneyHost', async () => {
    if (journeyHostState.deferModuleLoad) {
        await journeyHostState.moduleLoadPromise;
    }
    journeyHostState.moduleLoads += 1;
    return {
        OnboardingJourneyHost: (props: Record<string, unknown>) => {
            journeyHostState.renderCount += 1;
            journeyHostState.lastProps = props;
            if (journeyHostState.throwOnRender) {
                throw new Error('stage mount failed');
            }
            return React.createElement('OnboardingJourneyHost', props);
        },
    };
});

vi.mock('@/components/onboarding/unauthShell', () => ({
    UnauthenticatedSplitShell: (props: Record<string, unknown>) =>
        React.createElement(
            'UnauthenticatedSplitShell',
            props,
            props.children as React.ReactNode,
            React.createElement('BrandHeroGetStarted', {
                key: 'brand-hero-get-started',
                testID: 'brand-hero-get-started',
                onPress: props.onBrandHeroGetStarted,
            }),
        ),
    useApplyBrandHeroSeen: () => applyBrandHeroSeenMock,
}));

vi.mock('@/components/ui/feedback/AppUpdateStatusTag', () => ({
    AppUpdateStatusTag: (props: Record<string, unknown>) => React.createElement('AppUpdateStatusTag', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('PreAuthOnboardingWizardEntry', () => {
    const originalDebug = process.env.EXPO_PUBLIC_DEBUG;

    beforeEach(() => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_DEBUG = '1';
        reactNativeState.windowWidth = 390;
        reactNativeState.windowHeight = 844;
        tauriDesktopState.value = false;
        serverRuntimeState.serverUrl = null;
        authEntryOptionsState.current = {
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
            retentionSummary: null,
            autoRedirect: {
                enabled: false,
                providerId: null,
                toKeyedProvision: false,
                toKeylessLogin: false,
                toMtls: false,
                toLegacySignupProvider: false,
            },
            retryServerCheck: () => {},
        };
        loginMock.mockReset();
        loginMock.mockResolvedValue({ kind: 'completed' });
        loginWithCredentialsMock.mockReset();
        loginWithCredentialsMock.mockResolvedValue({
            kind: 'completed',
        });
        runtimeFetchMock.mockReset();
        applyBrandHeroSeenMock.mockReset();
        onboardingTourFeatureState.state = 'disabled';
        onboardingTourFeatureState.calls = [];
        localSettingsState.hasCompletedAuthOnce = false;
        journeySessionState.active = false;
        authState.isAuthenticated = false;
        pendingSetupIntentState.value = null;
        journeyHostState.moduleLoads = 0;
        journeyHostState.renderCount = 0;
        journeyHostState.throwOnRender = false;
        journeyHostState.deferModuleLoad = false;
        journeyHostState.moduleLoadPromise = null;
        journeyHostState.releaseModuleLoad();
        journeyHostState.lastProps = null;
        wizardControllerMock.goToStep.mockReset();
        wizardControllerMock.lastProps = null;
        wizardControllerMock.current = {
            ...wizardControllerMock.current,
            stepId: 'welcome',
            contentTransitionDirection: 'replace',
            showBack: false,
            onBack: null,
            body: React.createElement('WizardBody', { testID: 'wizard-body' }),
            goToStep: wizardControllerMock.goToStep,
        };
        routerMocks.push.mockReset();
        routerMocks.replace.mockReset();
        routerMocks.back.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
    });

    afterEach(() => {
        process.env.EXPO_PUBLIC_DEBUG = originalDebug;
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('renders the unauth split shell directly on narrow web without the legacy modal wrapper', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
        expect(screen.findByType('UnauthenticatedSplitShell' as never)).toBeTruthy();
        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.wizardChromeMode).toBe('bare');
    });

    it('falls back to the current wizard and does not load tour code when onboardingTour is disabled', async () => {
        onboardingTourFeatureState.state = 'disabled';

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(onboardingTourFeatureState.calls).toContainEqual([
            'app.ui.onboardingTour',
            { scopeKind: 'runtime' },
        ]);
        expect(journeyHostState.moduleLoads).toBe(0);
        expect(journeyHostState.renderCount).toBe(0);
        expect(screen.findByType('OnboardingWizardSurfacePresentation' as never)).toBeTruthy();
    });

    it('renders an accessible progress status while the onboardingTour decision is resolving', async () => {
        onboardingTourFeatureState.state = null;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const loadingSurface = screen.findByTestId('onboarding-journey-loading');
        expect(loadingSurface?.props.accessibilityRole).toBe('progressbar');
        expect(loadingSurface?.props.accessibilityLabel).toBeTruthy();
        expect(loadingSurface?.props.accessibilityLiveRegion).toBe('polite');
        expect(loadingSurface?.props.role).toBe('status');
        expect(loadingSurface?.props['aria-live']).toBe('polite');
        expect(screen.findByTestId('onboarding-journey-loading-spinner')).toBeTruthy();
        expect(screen.findByTestId('onboarding-journey-loading-label')).toBeTruthy();
        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(0);
        expect(journeyHostState.moduleLoads).toBe(0);
        expect(journeyHostState.renderCount).toBe(0);
    });

    it('preserves the debug query initial step override for the wizard controller', async () => {
        vi.stubGlobal('window', {
            location: {
                href: 'http://localhost:8081/?happier_wizard_step=relay_select',
                search: '?happier_wizard_step=relay_select',
            },
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(wizardControllerMock.lastProps?.initialStepId).toBe('relay_select');
    });

    it('does not flash the current wizard while the enabled journey chunk is loading', async () => {
        onboardingTourFeatureState.state = 'enabled';
        journeyHostState.deferModuleLoad = true;
        journeyHostState.resetModuleLoadDeferred();

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        try {
            expect(screen.findByTestId('onboarding-journey-loading')).toBeTruthy();
            expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
            expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(0);
            expect(journeyHostState.renderCount).toBe(0);
        } finally {
            await act(async () => {
                journeyHostState.releaseModuleLoad();
                await vi.dynamicImportSettled();
            });
        }

        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(0);
    });

    it('renders the lazy journey host as the unauth shell replacement when onboardingTour is enabled', async () => {
        onboardingTourFeatureState.state = 'enabled';
        authEntryOptionsState.current.retentionSummary = 'This relay cleans up subagent transcripts after 7 days.';

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(0);
        expect(journeyHostState.renderCount).toBe(1);
        expect(journeyHostState.lastProps).toMatchObject({
            isDesktopShell: false,
            surface: 'web',
            retentionSummary: 'This relay cleans up subagent transcripts after 7 days.',
            preAuthController: wizardControllerMock.current,
        });
    });

    it('renders the classic welcome shell for returning users even when onboardingTour is enabled', async () => {
        onboardingTourFeatureState.state = 'enabled';
        localSettingsState.hasCompletedAuthOnce = true;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('UnauthenticatedSplitShell' as never)).toBeTruthy();
        expect(screen.findByType('OnboardingWizardSurfacePresentation' as never)).toBeTruthy();
        expect(screen.findAllByType('OnboardingJourneyHost' as never)).toHaveLength(0);
        expect(journeyHostState.renderCount).toBe(0);
    });

    it('keeps rendering the journey for a returning user while a journey session is active', async () => {
        onboardingTourFeatureState.state = 'enabled';
        localSettingsState.hasCompletedAuthOnce = true;
        journeySessionState.active = true;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(0);
    });

    it('renders the journey for a returning user when an explicit replay beat intent is present', async () => {
        onboardingTourFeatureState.state = 'enabled';
        localSettingsState.hasCompletedAuthOnce = true;
        vi.stubGlobal('window', {
            location: {
                href: 'http://localhost:8081/?happier_journey_beat=S5',
                search: '?happier_journey_beat=S5',
            },
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
    });

    it('renders the journey replay deep-link for a returning user in a production (non-debug) build', async () => {
        delete process.env.EXPO_PUBLIC_DEBUG;
        onboardingTourFeatureState.state = 'enabled';
        localSettingsState.hasCompletedAuthOnce = true;
        vi.stubGlobal('window', {
            location: {
                href: 'http://localhost:8081/?happier_journey_beat=A5',
                search: '?happier_journey_beat=A5',
            },
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
    });

    it('ignores the journey replay deep-link when the onboardingTour feature flag is off', async () => {
        delete process.env.EXPO_PUBLIC_DEBUG;
        onboardingTourFeatureState.state = 'disabled';
        localSettingsState.hasCompletedAuthOnce = true;
        vi.stubGlobal('window', {
            location: {
                href: 'http://localhost:8081/?happier_journey_beat=A5',
                search: '?happier_journey_beat=A5',
            },
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findAllByType('OnboardingJourneyHost' as never)).toHaveLength(0);
    });

    it('re-latches the journey at the setup act for an authed returning user with a pending setup continuation', async () => {
        onboardingTourFeatureState.state = 'enabled';
        localSettingsState.hasCompletedAuthOnce = true;
        journeySessionState.active = false;
        authState.isAuthenticated = true;
        pendingSetupIntentState.value = {
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        };

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('OnboardingJourneyHost' as never)).toBeTruthy();
        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(journeyHostState.lastProps).toMatchObject({
            initialBeatId: 'S3',
        });
    });

    it('passes the debug query initial beat to the enabled journey host', async () => {
        onboardingTourFeatureState.state = 'enabled';
        vi.stubGlobal('window', {
            location: {
                href: 'http://localhost:8081/?happier_journey_beat=S5',
                search: '?happier_journey_beat=S5',
            },
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(journeyHostState.lastProps).toMatchObject({
            initialBeatId: 'S5',
        });
    });

    it('falls back to the current wizard when the journey host cannot mount', async () => {
        onboardingTourFeatureState.state = 'enabled';
        journeyHostState.throwOnRender = true;
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        consoleErrorSpy.mockRestore();
        expect(journeyHostState.renderCount).toBeGreaterThan(0);
        expect(screen.findAllByType('OnboardingJourneyHost' as never)).toHaveLength(0);
        expect(screen.findByType('OnboardingWizardSurfacePresentation' as never)).toBeTruthy();
    });

    it('renders the unauth split shell on Tauri desktop with bare wizard presentation', async () => {
        tauriDesktopState.value = true;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
        expect(screen.findByType('UnauthenticatedSplitShell' as never)).toBeTruthy();
        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard).toBeTruthy();
        expect(wizard.props.wizardChromeMode).toBe('bare');
    });

    it('passes a shell-owned chrome host into the onboarding wizard surface', async () => {
        tauriDesktopState.value = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.shellChrome).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeTruthy();
        expect(screen.findAllByType('AppUpdateStatusTag' as never)).toHaveLength(1);
    });

    it('does not inject pre-auth shell chrome on non-desktop flows', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.shellChrome ?? null).toBeNull();
        expect(screen.findAllByType('AppUpdateStatusTag' as never)).toHaveLength(0);
    });

    it('routes the shell footer relay action to the wizard relay selection step', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const shell = screen.findByType('UnauthenticatedSplitShell' as never);
        await shell.props.onOpenRelayCustomFlow?.();

        expect(wizardControllerMock.goToStep).toHaveBeenCalledWith('relay_select');
    });

    it('writes the shell-local brand hero seen flag without changing wizard step history', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        screen.pressByTestId('brand-hero-get-started');

        expect(applyBrandHeroSeenMock).toHaveBeenCalledTimes(1);
        expect(wizardControllerMock.goToStep).not.toHaveBeenCalled();
    });

    it('uses runtimeFetch instead of global fetch for web mtls login', async () => {
        serverRuntimeState.serverUrl = 'https://api.example.test';

        const fetchMock = vi.fn(async () => {
            throw new Error('Unexpected global fetch call');
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'mtls-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        await act(async () => {
            await wizardControllerMock.lastProps?.onLoginWithMtls?.();
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith('https://api.example.test/v1/auth/mtls', {
            method: 'POST',
            signal: expect.any(AbortSignal),
        });
        expect(loginWithCredentialsMock).toHaveBeenCalledWith({ token: 'mtls-token' });
    });

    it('auto-starts web mtls login when auth auto-redirect targets mtls', async () => {
        serverRuntimeState.serverUrl = 'https://api.example.test';
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            showMtlsLogin: true,
            autoRedirect: {
                enabled: true,
                providerId: null,
                toKeyedProvision: false,
                toKeylessLogin: false,
                toMtls: true,
                toLegacySignupProvider: false,
            },
        };
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'mtls-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(runtimeFetchMock).toHaveBeenCalledWith('https://api.example.test/v1/auth/mtls', {
            method: 'POST',
            signal: expect.any(AbortSignal),
        });
        expect(loginWithCredentialsMock).toHaveBeenCalledWith({ token: 'mtls-token' });
    });
});
