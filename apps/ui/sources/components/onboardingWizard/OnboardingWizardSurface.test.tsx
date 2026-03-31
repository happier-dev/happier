import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

import { WizardModalShell } from './WizardModalShell';

const expoRouterMock = vi.hoisted(() => {
    const push = vi.fn();
    const replace = vi.fn();
    return {
        spies: {
            push,
            replace,
        },
        module: {
            router: {
                push,
                replace,
            },
            useRouter: () => ({
                push,
                replace,
            }),
            useLocalSearchParams: () => ({}),
            useNavigation: () => null,
            usePathname: () => '/',
            useSegments: () => [],
            Redirect: () => null,
            Link: 'Link',
            Stack: {
                Screen: () => null,
            },
        },
    };
});

const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => null));
const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const activeServerSnapshotMock = vi.hoisted(() => ({
    serverId: 'relay-profile',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));
const listServerProfilesMock = vi.hoisted(() => vi.fn(() => [] as Array<{
    id: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    source: 'preconfigured' | 'custom' | 'imported';
}>));
const webQrScannerSupportedMock = vi.hoisted(() => ({ value: false }));
const webMobileLikeQrScannerHostMock = vi.hoisted(() => ({ value: false }));
const setActiveServerAndSwitchMock = vi.hoisted(() => vi.fn(async () => true));
const upsertActivateAndSwitchServerMock = vi.hoisted(() => vi.fn(async () => true));
const getResetToDefaultServerIdMock = vi.hoisted(() => vi.fn(() => 'cloud-profile'));
const getServerProfileByIdMock = vi.hoisted(() => vi.fn((serverId: string) => (
    serverId === 'cloud-profile'
        ? {
            id: 'cloud-profile',
            name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
            source: 'preconfigured' as const,
        }
        : null
)));
const runtimeFetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('https://unreachable-relay.example.test') && url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
        },
    };
});

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: () => clearPendingSetupIntentMock(),
}));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => webQrScannerSupportedMock.value,
}));
vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isWebMobileLikeQrScannerHost: () => webMobileLikeQrScannerHostMock.value,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));
vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => null,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getResetToDefaultServerId: () => getResetToDefaultServerIdMock(),
    getServerProfileById: (serverId: string) => getServerProfileByIdMock(serverId),
    listServerProfiles: () => listServerProfilesMock(),
}));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => runtimeFetchMock(input, init),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    isSameServerUrl: (left: string, right: string) => left === right,
    normalizeServerUrl: (value: string) => value,
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerMock,
    setActiveServerAndSwitch: setActiveServerAndSwitchMock,
}));
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));
vi.mock('@/components/onboardingWizard/RelayDiagram', () => ({
    RelayDiagram: () => null,
}));
vi.mock('@/components/onboardingWizard/restore/RestoreIndexEmbedded', () => ({
    RestoreIndexEmbedded: () => null,
}));
vi.mock('@/components/onboardingWizard/restore/LostAccessEmbedded', () => ({
    LostAccessEmbedded: () => null,
}));
vi.mock('@/components/onboardingWizard/WelcomeProvidersShowcase', () => ({
    WelcomeProvidersShowcase: () => null,
}));
vi.mock('@/components/onboardingWizard/WebDesktopHandoffStep', () => ({
    WebDesktopHandoffStep: (props: Record<string, unknown>) => React.createElement('WebDesktopHandoffStep', props),
}));
vi.mock('@/components/account/auth/AuthEntryView', () => ({
    AuthEntryView: (props: Record<string, unknown>) => React.createElement('AuthEntryView', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            (props.onStatusChange as ((status: { relayUrl: string | null }) => void) | undefined)?.({ relayUrl: 'http://localhost:31337' });
        }, [props.onStatusChange]);
        return React.createElement('LocalRelayRuntimeControlSection', props);
    },
}));
vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: Record<string, unknown>) => React.createElement('QrCodeScannerView', props),
}));
vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => undefined),
    },
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const baseAuthOptions = {
    serverAvailability: 'ready' as const,
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
    anonymousSignupTitle: 'Create account',
    mtlsTitle: 'Sign in with certificate',
    primarySignupTitle: 'Create account',
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
};

describe('OnboardingWizardSurface', () => {
    beforeEach(() => {
        setPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockReset();
        setActiveServerAndSwitchMock.mockReset();
        upsertActivateAndSwitchServerMock.mockReset();
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        webQrScannerSupportedMock.value = false;
        webMobileLikeQrScannerHostMock.value = false;
        activeServerSnapshotMock.serverId = 'relay-profile';
        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        listServerProfilesMock.mockReturnValue([]);
    });

    it('labels the welcome action as start and the relay selection action as next', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.start');

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.next');
    });

    afterEach(() => {
        standardCleanup();
    });

    it('can start on relay selection when initialStepId is provided', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-welcome-body')).toHaveLength(0);
    });

    it('stores an awaiting-auth resume intent when continuing past relay selection', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await startButton.props.onPress?.();
        });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await continueButton.props.onPress?.();
        });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://api.happier.dev',
        });
    });

    it('treats the header start action as an alias for the primary welcome action', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const skipButton = screen.findByTestId('onboarding-wizard-skip')!;

        await act(async () => {
            await skipButton.props.onPress?.();
        });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('fast-paths from welcome to auth when a non-cloud relay is already selected', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');

        const loginButton = screen.findByTestId('onboarding-wizard-skip')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('hides duplicate relay escape-hatch actions when the selected relay is unreachable on the welcome step', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    serverAvailability: 'unavailable',
                    serverUrlForCopy: 'https://relay.example.test',
                },
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findAllByTestId('onboarding-wizard-change-relay')).toHaveLength(0);
        expect(screen.findByType('AuthEntryView' as never)).toBeTruthy();
    });

    it('renders the welcome body block and selected server hint with clear back navigation', async () => {
        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:31337';
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-logotype')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-welcome-body')).toBeTruthy();

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-back')).toBeTruthy();
    });

    it('shows auth actions on welcome when the relay is already known and keeps change relay available', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'cloud-profile',
                name: 'Happier Cloud',
                serverUrl: 'https://api.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'preconfigured',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        expect(screen.findByType('AuthEntryView' as never)).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');
        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-change-relay')).toBeTruthy();
    });

    it('moves the wizard to relay URL entry when the custom relay option is primary-selected', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;

        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).not.toBeNull();
    });

    it('routes the auth view change-relay action back to the wizard relay selection step', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const authEntry = screen.findByType('AuthEntryView' as never) as unknown as {
            props: { onChangeRelay?: () => void };
        };

        await act(async () => {
            await authEntry.props.onChangeRelay?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('guides web users to continue on desktop when selecting "On this computer"', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();

        const handoffContinueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await handoffContinueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeTruthy();
    });

    it('continues to auth after saving a relay url from the web "On this computer" handoff', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();

        const handoffContinueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await handoffContinueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://relay.local.test');
        });

        const saveRelayButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('skips relay URL entry when a custom relay has already been resolved', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://custom.relay.test');
        });

        const saveRelayButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).not.toBeNull();

        const continueAfterResolved = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterResolved.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('routes through local relay hosting on desktop when "On this computer" is selected', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await localRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });

        expect(screen.findByType('LocalRelayRuntimeControlSection' as never)).toBeTruthy();
    });

    it('requires explicit relay switch confirmation after hosting a local relay', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToHost = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToHost.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('LocalRelayRuntimeControlSection' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterHosted.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();

        const switchChoice = screen.findByTestId('onboarding-wizard-confirmSwitchRelay.choice:switch')!;
        await act(async () => {
            await switchChoice.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'http://localhost:31337' }));
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('routes web users selecting "On this computer" to the desktop handoff guidance step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        expect(onThisComputerRow.props.disabled).toBe(false);

        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();
    });

    it('renders a desktop-only remote computer relay option', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:remoteComputer')).toBeTruthy();
    });

    it('branches remote relay hosting into a dedicated SSH setup step instead of continuing to auth immediately', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRow = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-host-remote-relay')).toBeTruthy();
    });

    it('shows the relay footer hint when Happier Cloud is selected', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findAllByTestId('onboarding-wizard-relay-hint')).toHaveLength(1);
    });

    it('shows a prefilled relay as a selectable row and selects it by default', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay-b.example.test';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-a',
                name: 'Relay A',
                serverUrl: 'https://relay-a.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-saved-relays-title')).toBeTruthy();
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never)).toBeTruthy();
        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-b' } as never);
        expect(relayRow).toBeTruthy();
        expect(relayRow?.props.selected).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).toBeTruthy();
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never)?.props.selected).toBe(false);
    });

    it('marks an unreachable saved relay as unavailable and offers a retry action', async () => {
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-offline',
                name: 'Offline Relay',
                serverUrl: 'https://unreachable-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-offline' } as never);
        expect(relayRow?.props.disabled).toBe(true);
        expect(relayRow?.props.secondaryAction?.testID).toBe('onboarding-wizard-relay:profile:relay-offline-retry');

        const callCountBefore = runtimeFetchMock.mock.calls.length;
        await act(async () => {
            relayRow?.props.secondaryAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });

    it('renders a single-line relay footer and keeps Cloud from showing a custom URL footer', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay-b.example.test';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-line')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-label')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-value')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-url')).toBeNull();
    });

    it('keeps an unreachable preselected relay selected and disables continue until a reachable relay is selected', async () => {
        activeServerSnapshotMock.serverUrl = 'https://unreachable-relay.example.test';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-offline',
                name: 'Offline Relay',
                serverUrl: 'https://unreachable-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
            {
                id: 'relay-ok',
                name: 'Online Relay',
                serverUrl: 'https://relay-ok.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'custom',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const offlineRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-offline' } as never);
        expect(offlineRow?.props.selected).toBe(true);
        expect(offlineRow?.props.disabled).toBe(true);

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButton.props.disabled).toBe(true);

        const cloudRow = screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never);
        expect(cloudRow?.props.selected).toBe(false);

        const okRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-ok' } as never);
        await act(async () => {
            await okRow?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButtonAfter = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButtonAfter.props.disabled).toBe(false);
    });

    it('switches to the canonical Happier Cloud profile before continuing to auth', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;

        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const primaryButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await primaryButton.props.onPress?.();
        });

        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'cloud-profile' }));
        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('routes a scanned pairing link without an embedded server url to relay URL entry', async () => {
        webQrScannerSupportedMock.value = true;
        webMobileLikeQrScannerHostMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const scanButton = screen.findByTestId('onboarding-wizard-scan')!;

        await act(async () => {
            await scanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const scanner = screen.findByType('QrCodeScannerView')!;

        await act(async () => {
            await scanner.props.onScan?.('happier:///pair?v=1&pairId=pair_1&secret=sec_1');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).not.toBeNull();
    });

    it('requires explicit confirmation before locking in a scanned relay url', async () => {
        webQrScannerSupportedMock.value = true;
        webMobileLikeQrScannerHostMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const scanButton = screen.findByTestId('onboarding-wizard-scan')!;

        await act(async () => {
            await scanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const scanner = screen.findByType('QrCodeScannerView')!;

        await act(async () => {
            await scanner.props.onScan?.('https://relay.example.com');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirm-relay-lock')).not.toBeNull();

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });
});
