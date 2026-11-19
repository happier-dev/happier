import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { onboardingAuthHistoryState } from '@/sync/domains/state/onboardingUiState';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type {
    DesktopWindowChromePolicy,
    DesktopWindowState,
} from '@/utils/platform/desktopWindowBridge';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

const reactNativeState = vi.hoisted(() => ({
    windowWidth: 390,
    windowHeight: 844,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
}));
const modalSpies = vi.hoisted(() => ({ show: vi.fn(() => 'personalize-modal') }));
const personalizeChunkState = vi.hoisted(() => ({ loads: 0 }));
// Observe chunk loading; the flow's internal implementation remains real.
vi.mock('@/components/onboarding/personalize/PersonalizeFlowView', async (importOriginal) => {
    personalizeChunkState.loads += 1;
    return importOriginal<typeof import('@/components/onboarding/personalize/PersonalizeFlowView')>();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modalSpies }).module;
});

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
const wizardControllerMock = vi.hoisted(() => {
    const goToStep = vi.fn();
    return {
        goToStep,
        lastProps: null as (Record<string, unknown> & {
            initialStepId?: unknown;
            onContinueWithHomeAuthentication?: (request: Readonly<{
                method: Readonly<{ id: string; enabledActions: readonly Readonly<{ id: 'login'; mode: 'keyless' }>[] }>;
                action: Readonly<{ id: 'login'; mode: 'keyless' }>;
                execution: Readonly<{ kind: 'mtls' }>;
                authority: Readonly<{ purpose: 'home'; target: typeof authEntryOptionsState.current.homeTarget }>;
                intendedHome: typeof authEntryOptionsState.current.homeTarget;
            }>, context: Readonly<{ signal: AbortSignal }>) => Promise<void> | void;
        }) | null,
        current: {
            stepId: 'welcome',
            currentStepIndex: 0,
            stepCount: 4,
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
        homeTarget: { kind: 'descriptor' as const, authority: 'current_connection' as const, descriptor: {
            homeServerIdentityId: 'server-a', canonicalServerUrl: 'https://api.example.test',
            endpoints: [{ kind: 'https' as const, url: 'https://api.example.test' }],
        } },
        authenticationActions: [] as NonNullable<AuthEntryOptions['authenticationActions']>,
        serverAvailability: 'ready',
        serverUrlForCopy: 'https://relay.example.test',
        showAuthActions: true,
        retentionDisclosure: null as { kind: 'summary'; summary: string } | null,
        retryServerCheck: () => {},
    },
}));
const authState = vi.hoisted(() => ({
    isAuthenticated: false as boolean,
}));
const desktopWindowBridgeState = vi.hoisted(() => ({
    getDesktopWindowChromePolicy: vi.fn<() => Promise<DesktopWindowChromePolicy>>(async () => ({ strategy: 'none' })),
    getDesktopWindowState: vi.fn<() => Promise<DesktopWindowState>>(async () => ({ isMaximized: false, isFullscreen: false })),
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


const tauriDesktopState = vi.hoisted(() => ({ value: false }));
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => tauriDesktopState.value,
}));

vi.mock('@/utils/platform/desktopWindowBridge', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopWindowBridge')>(),
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
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
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

vi.mock('@/components/updates/UpdatesPopoverButton', () => ({
    UpdatesEntry: (props: Record<string, unknown>) => React.createElement('UpdatesEntry', props),
    UpdatesPopoverButton: (props: Record<string, unknown>) => React.createElement('UpdatesPopoverButton', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

// Load the entry graph once during collection rather than inside the first test.
await import('./PreAuthOnboardingWizardEntry');

describe('PreAuthOnboardingWizardEntry', () => {
    const originalDebug = process.env.EXPO_PUBLIC_DEBUG;
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;

    beforeEach(() => {
        process.env.EXPO_PUBLIC_DEBUG = '1';
        reactNativeState.windowWidth = 390;
        reactNativeState.windowHeight = 844;
        tauriDesktopState.value = false;
        serverRuntimeState.serverUrl = null;
        authEntryOptionsState.current = {
            homeTarget: { kind: 'descriptor' as const, authority: 'current_connection' as const, descriptor: {
                homeServerIdentityId: 'server-a', canonicalServerUrl: 'https://api.example.test',
                endpoints: [{ kind: 'https' as const, url: 'https://api.example.test' }],
            } },
            authenticationActions: [] as NonNullable<AuthEntryOptions['authenticationActions']>,
            serverAvailability: 'ready',
            serverUrlForCopy: 'https://relay.example.test',
            showAuthActions: true,
            retentionDisclosure: null,
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
        onboardingAuthHistoryState.set('completed', false);
        authState.isAuthenticated = false;
        wizardControllerMock.goToStep.mockReset();
        wizardControllerMock.lastProps = null;
        wizardControllerMock.current = {
            ...wizardControllerMock.current,
            stepId: 'welcome',
            showBack: false,
            onBack: null,
            body: React.createElement('WizardBody', { testID: 'wizard-body' }),
            goToStep: wizardControllerMock.goToStep,
        };
        routerMocks.push.mockReset();
        routerMocks.replace.mockReset();
        routerMocks.back.mockReset();
        modalSpies.show.mockClear();
        personalizeChunkState.loads = 0;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockReset();
        desktopWindowBridgeState.getDesktopWindowState.mockReset();
        desktopWindowBridgeState.listenDesktopWindowState.mockReset();
        desktopWindowBridgeState.minimizeDesktopWindow.mockReset();
        desktopWindowBridgeState.toggleDesktopWindowMaximize.mockReset();
        desktopWindowBridgeState.closeDesktopWindow.mockReset();
        desktopWindowBridgeState.startDesktopWindowDragging.mockReset();
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
        desktopWindowBridgeState.getDesktopWindowState.mockResolvedValue({ isMaximized: false, isFullscreen: false });
        desktopWindowBridgeState.listenDesktopWindowState.mockResolvedValue(async () => {});
    });

    afterEach(() => {
        browser?.restore();
        browser = undefined;
        process.env.EXPO_PUBLIC_DEBUG = originalDebug;
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('renders the unauth split shell on narrow web with a bare, non-fullscreen wizard', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('UnauthenticatedSplitShell' as never)).toBeTruthy();
        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.wizardChromeMode).toBe('bare');
        expect(wizard.props.wizardLayoutPresentation).toBeUndefined();
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

    it('hands a supplied Home address to the connection step without consuming the URL first', async () => {
        const retainedEntry = { id: 'onboarding-entry' };
        browser = await installBrowserRuntimeForTests({ url: 'https://app.example.test/?server=https%3A%2F%2Fhome.example.test' });
        browser.window.history.replaceState(retainedEntry, '');
        const replaceState = vi.spyOn(browser.window.history, 'replaceState');

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(wizardControllerMock.lastProps?.initialServerUrl).toBe('https://home.example.test');
        expect(wizardControllerMock.lastProps?.initialStepId).toBe('connect_home');
        expect(screen.findAllByType('OnboardingWizardSurfacePresentation' as never)).toHaveLength(1);
        expect(replaceState).not.toHaveBeenCalled();
        (wizardControllerMock.lastProps?.onInitialServerUrlConnected as (() => void) | undefined)?.();
        expect(replaceState).toHaveBeenCalledWith(retainedEntry, '', '/');
    });

    it('renders the unauth split shell on Tauri desktop with a fullscreen desktop-shell wizard', async () => {
        tauriDesktopState.value = true;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findByType('UnauthenticatedSplitShell' as never)).toBeTruthy();
        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.wizardChromeMode).toBe('bare');
        expect(wizard.props.isDesktopShell).toBe(true);
        expect(wizard.props.wizardLayoutPresentation).toBe('fullscreen');
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
        // The top-left chrome keeps only the window controls; Updates lives in the workflow pane's footer slot.
        expect(screen.findAllByType('UpdatesEntry' as never)).toHaveLength(0);
        const shell = screen.findByType('UnauthenticatedSplitShell' as never);
        const accessory = shell.props.footerAccessory as React.ReactElement<{ variant?: string }> | undefined;
        expect(accessory?.props.variant).toBe('footer');
    });

    it('does not inject pre-auth shell chrome on non-desktop flows', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurfacePresentation' as never);
        expect(wizard.props.shellChrome ?? null).toBeNull();
        expect(screen.findAllByType('UpdatesEntry' as never)).toHaveLength(0);
        expect(screen.findByType('UnauthenticatedSplitShell' as never).props.footerAccessory ?? null).toBeNull();
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
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            authenticationActions: [{
                method: { id: 'mtls', enabledActions: [{ id: 'login' as const, mode: 'keyless' as const }] },
                action: { id: 'login' as const, mode: 'keyless' as const },
                execution: { kind: 'mtls' as const },
            }],
        };

        const fetchMock = vi.fn(async () => {
            throw new Error('Unexpected global fetch call');
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        let finishRequest!: (response: Response) => void;
        runtimeFetchMock.mockImplementation((input: string) => {
            if (String(input).endsWith('/v1/auth/mtls')) {
                return new Promise<Response>((resolve) => { finishRequest = resolve; });
            }
            return Promise.resolve(new Response('{}', { status: 200 }));
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const homeTarget = authEntryOptionsState.current.homeTarget;
        const login = wizardControllerMock.lastProps?.onContinueWithHomeAuthentication?.({
            method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
            action: { id: 'login', mode: 'keyless' },
            execution: { kind: 'mtls' },
            authority: { purpose: 'home', target: homeTarget },
            intendedHome: homeTarget,
        }, { signal: new AbortController().signal });
        serverRuntimeState.serverUrl = 'https://other.example.test';
        await vi.waitFor(() => expect(finishRequest).toEqual(expect.any(Function)));
        finishRequest(new Response(JSON.stringify({ token: 'mtls-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        await act(async () => { await login; });

        expect(fetchMock).not.toHaveBeenCalled();
        const mtlsRequest = runtimeFetchMock.mock.calls.find(([url]) => url === 'https://api.example.test/v1/auth/mtls');
        expect(mtlsRequest?.[1]).toEqual(expect.objectContaining({
            method: 'POST',
            signal: expect.any(AbortSignal),
        }));
        expect(loginWithCredentialsMock).toHaveBeenCalledWith(
            { token: 'mtls-token' },
            { target: { serverId: 'server-a', serverUrl: 'https://api.example.test' } },
        );
    });

});
