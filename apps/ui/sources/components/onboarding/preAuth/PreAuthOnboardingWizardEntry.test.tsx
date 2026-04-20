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

const loginMock = vi.hoisted(() => vi.fn());
const loginWithCredentialsMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const buildDataKeyCredentialsForTokenMock = vi.hoisted(() => vi.fn(async (token: string) => ({ token, secret: 'secret' })));
const serverRuntimeState = vi.hoisted(() => ({
    serverUrl: null as string | null,
}));
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
        retryServerCheck: () => {},
    },
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
        isAuthenticated: false,
        login: loginMock,
        loginWithCredentials: loginWithCredentialsMock,
    }),
}));

vi.mock('@/auth/flows/buildDataKeyCredentialsForToken', () => ({
    buildDataKeyCredentialsForToken: (token: string) => buildDataKeyCredentialsForTokenMock(token),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => authEntryOptionsState.current,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsLandscape: () => false,
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
            retryServerCheck: () => {},
        };
        loginMock.mockReset();
        loginWithCredentialsMock.mockReset();
        runtimeFetchMock.mockReset();
        buildDataKeyCredentialsForTokenMock.mockClear();
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
        if (typeof window !== 'undefined') {
            window.history.pushState({}, '', '/?happier_wizard_step=relay_select');
        } else {
            (globalThis as unknown as { location?: { search?: string } }).location = {
                search: '?happier_wizard_step=relay_select',
            };
        }
    });

    afterEach(() => {
        process.env.EXPO_PUBLIC_DEBUG = originalDebug;
        standardCleanup();
    });

    it('passes a debug initialStepId from happier_wizard_step in debug builds', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        expect(wizard.props.initialStepId).toBe('relay_select');
    });

    it('wraps the onboarding wizard in a top-aligned BaseModal on narrow web so the wizard can use fullscreen presentation', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const modal = screen.findByType('BaseModal' as never);
        expect(modal.props.showBackdrop).toBe(true);
        expect(modal.props.webPlacement).toBe('top');
    });

    it('does not wrap the onboarding wizard in BaseModal on Tauri desktop (window owns the surface)', async () => {
        tauriDesktopState.value = true;

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        expect(screen.findAllByType('BaseModal' as never)).toHaveLength(0);
        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        expect(wizard).toBeTruthy();
        expect(wizard.props.wizardChromeMode).toBe('embedded');
        expect(wizard.props.wizardLayoutPresentation).toBe('fullscreen');
    });

    it('passes a shell-owned chrome host into the onboarding wizard surface', async () => {
        tauriDesktopState.value = true;
        desktopWindowBridgeState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'native-macos-traffic-lights' });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        expect(wizard.props.shellChrome).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-host')).toBeTruthy();
        expect(screen.findByTestId('desktop-window-controls-slot')).toBeTruthy();
        expect(screen.findAllByType('AppUpdateStatusTag' as never)).toHaveLength(1);
    });

    it('does not inject pre-auth shell chrome on non-desktop flows', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        expect(wizard.props.shellChrome ?? null).toBeNull();
        expect(screen.findAllByType('AppUpdateStatusTag' as never)).toHaveLength(0);
    });

    it('routes the change-relay action to the wizard relay selection step', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));

        const wizard = screen.findByType('OnboardingWizardSurface' as never);
        await wizard.props.onChangeRelayViaServerConfig?.();

        expect(routerMocks.replace).toHaveBeenCalledWith('/?happier_wizard_step=relay_select');
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
        const wizard = screen.findByType('OnboardingWizardSurface' as never);

        await act(async () => {
            await wizard.props.onLoginWithMtls?.();
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(runtimeFetchMock).toHaveBeenCalledWith('https://api.example.test/v1/auth/mtls', {
            method: 'POST',
            signal: expect.any(AbortSignal),
        });
        expect(buildDataKeyCredentialsForTokenMock).toHaveBeenCalledWith('mtls-token');
        expect(loginWithCredentialsMock).toHaveBeenCalledWith({ token: 'mtls-token', secret: 'secret' });
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
        expect(buildDataKeyCredentialsForTokenMock).toHaveBeenCalledWith('mtls-token');
        expect(loginWithCredentialsMock).toHaveBeenCalledWith({ token: 'mtls-token', secret: 'secret' });
    });
});
