import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

import { WizardModalShell } from '../WizardModalShell';
import { WizardChoiceRow } from '../WizardChoiceRow';

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
const listServerProfilesMock = vi.hoisted(() => vi.fn<() => ServerProfile[]>(() => []));
const webQrScannerSupportedMock = vi.hoisted(() => ({ value: false }));
const webMobileLikeQrScannerHostMock = vi.hoisted(() => ({ value: false }));
const setActiveServerAndSwitchMock = vi.hoisted(() => vi.fn(async () => true));
const upsertActivateAndSwitchServerMock = vi.hoisted(() => vi.fn(async () => true));
const getResetToDefaultServerIdMock = vi.hoisted(() => vi.fn(() => 'cloud-profile'));
const getServerProfileByIdMock = vi.hoisted(() => vi.fn<(serverId: string) => ServerProfile | null>((serverId: string) => (
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
const getOrCreateHappierCloudServerProfileMock = vi.hoisted(() => vi.fn(() => ({
    id: 'cloud-profile',
    name: 'Happier Cloud',
    serverUrl: 'https://api.happier.dev',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
    source: 'preconfigured' as const,
})));
const runtimeFetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (
        url.includes('https://unreachable-relay.example.test')
        && url.endsWith('/health')
    ) {
        return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}));

const remoteSshChecklistMock = vi.hoisted(() => {
    const spy = vi.fn();
    return {
        spy,
        module: {
            RemoteSshChecklistStep: (props: any) => {
                spy(props);
                React.useEffect(() => {
                    props.onWizardPrimaryChange?.({
                        label: 'Run remote setup',
                        disabled: false,
                        onPress: () => undefined,
                    });
                    return () => props.onWizardPrimaryChange?.(null);
                }, [props.onWizardPrimaryChange]);

                return React.createElement('View' as any, { testID: props.testID ?? 'remote-ssh-checklist-mock' });
            },
        },
    };
});

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
        },
        AppState: {
            ...actual.AppState,
            get currentState() {
                return 'active';
            },
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
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
vi.mock('../remoteSshChecklist/RemoteSshChecklistStep', () => remoteSshChecklistMock.module);
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));
vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => null,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
    isActiveServerSelectionExplicit: () => false,
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getResetToDefaultServerId: () => getResetToDefaultServerIdMock(),
    getServerProfileById: (serverId: string) => getServerProfileByIdMock(serverId),
    listServerProfiles: () => listServerProfilesMock(),
    getOrCreateHappierCloudServerProfile: () => getOrCreateHappierCloudServerProfileMock(),
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
    getCachedServerFeaturesSnapshot: () => null,
}));
vi.mock('@/components/onboardingWizard/RelayDiagram', () => ({
    RelayDiagram: () => null,
}));
vi.mock('@/components/onboardingWizard/restore/RestoreIndexEmbedded', () => ({
    RestoreIndexEmbedded: (props: Record<string, unknown>) => React.createElement('RestoreIndexEmbedded', props),
}));
vi.mock('@/components/onboardingWizard/restore/SecretKeyLoginEmbedded', () => ({
    SecretKeyLoginEmbedded: (props: Record<string, unknown>) => React.createElement('SecretKeyLoginEmbedded', props),
}));
vi.mock('@/components/onboardingWizard/restore/LostAccessEmbedded', () => ({
    LostAccessEmbedded: () => null,
}));
vi.mock('@/components/onboardingWizard/WelcomeProvidersShowcase', () => ({
    WelcomeProvidersShowcase: () => null,
}));
vi.mock('@/components/onboardingWizard/WebDesktopRelayHostHandoffContent', () => ({
    WebDesktopRelayHostHandoffContent: (props: Record<string, unknown>) => React.createElement('WebDesktopRelayHostHandoffContent', props),
}));
vi.mock('@/components/onboardingWizard/WebDesktopBackgroundServiceHandoffContent', () => ({
    WebDesktopBackgroundServiceHandoffContent: (props: Record<string, unknown>) => React.createElement('WebDesktopBackgroundServiceHandoffContent', props),
}));
vi.mock('@/components/account/auth/AuthEntryView', () => ({
    AuthEntryView: (props: Record<string, unknown>) => React.createElement('AuthEntryView', props),
}));
vi.mock('../relayHostLocalChecklist/RelayHostLocalChecklistStep', () => ({
    RelayHostLocalChecklistStep: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            (props.onStatusChange as ((status: { relayUrl: string | null }) => void) | undefined)?.({ relayUrl: 'http://localhost:31337' });
        }, [props.onStatusChange]);
        return React.createElement('RelayHostLocalChecklistStep', props);
    },
}));
vi.mock('@/components/settings/server/localControl/LocalRelayAccessControlSection', () => ({
    LocalRelayAccessControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayAccessControlSection', props),
}));
vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: 'Ionicons',
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
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (!params) return key;
            const values = Object.values(params)
                .map((value) => String(value))
                .join(' ');
            return values ? `${key} ${values}` : key;
        },
    });
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
        try {
            Object.defineProperty(globalThis.document, 'visibilityState', { value: 'visible', configurable: true });
        } catch {
            // ignore
        }
        setPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockReset();
        setActiveServerAndSwitchMock.mockReset();
        upsertActivateAndSwitchServerMock.mockReset();
        getOrCreateHappierCloudServerProfileMock.mockReset();
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        webQrScannerSupportedMock.value = false;
        webMobileLikeQrScannerHostMock.value = false;
        activeServerSnapshotMock.serverId = 'relay-profile';
        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        getResetToDefaultServerIdMock.mockReturnValue('cloud-profile');
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

    it('only marks Happier Cloud as recommended in the relay selection list', async () => {
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

        const cloud = screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never);
        const thisComputer = screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never);
        const customUrl = screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never);

        expect(cloud?.props.badge).toBe('setupOnboarding.recommendedBadge');
        expect(thisComputer?.props.badge).toBeUndefined();
        expect(customUrl?.props.badge).toBeUndefined();
    });

    it('hides Happier Cloud when setup surface policy denies it (no implicit profile creation)', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowHappierCloud';
        try {
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

            expect(getOrCreateHappierCloudServerProfileMock).not.toHaveBeenCalled();
            expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides manual relay URL entry when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowCustomRelayUrl';
        try {
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

            expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides "This computer" relay hosting when setup surface policy denies local relay host', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowLocalRelayHost';
        try {
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

            expect(screen.findByTestId('onboarding-wizard-relay:thisComputer')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('navigates to secret key login within the onboarding wizard from the restore step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
                onChangeRelayViaServerConfig: vi.fn(),
            }),
        );

        const restoreStep = screen.findByType('RestoreIndexEmbedded' as never) as unknown as ReactTestInstance;
        await act(async () => {
            (restoreStep.props as any).onOpenSecretKeyLogin?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findAllByType('SecretKeyLoginEmbedded' as never)).toHaveLength(1);
    });

    it('keeps the welcome relay footer visible even when the wizard relay selection has no URL (falls back to active relay)', async () => {
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

        expect(screen.findAllByTestId('onboarding-wizard-relay-hint')).toHaveLength(1);

        const changeRelayButton = screen.findByTestId('onboarding-wizard-change-relay')!;
        await act(async () => {
            await changeRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteChoice = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteChoice.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findAllByTestId('onboarding-wizard-relay-hint')).toHaveLength(1);
    });

    it('resets relay selection to the active relay when opening relay selection from welcome', async () => {
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

        const changeRelayButton = screen.findByTestId('onboarding-wizard-change-relay')!;
        await act(async () => {
            await changeRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const thisComputerChoice = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerChoice.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        activeServerSnapshotMock.serverUrl = 'https://relay-other.example.test';

        const changeRelayButton2 = screen.findByTestId('onboarding-wizard-change-relay')!;
        await act(async () => {
            await changeRelayButton2.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const activeRelayRow = screen.findByTestId('onboarding-wizard-relay:profile:active')!;
        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        expect(activeRelayRow.props.selected).toBe(true);
        expect(thisComputerRow.props.selected).toBe(false);
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
        expect(screen.findByTestId('onboarding-wizard-welcome-auth')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-welcome-showcase')).toBeTruthy();

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

        const continueToChecklistButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToChecklistButton.props.onPress?.();
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

    it('shows auth actions on welcome after the user picks a saved relay and returns back to the intro', async () => {
        activeServerSnapshotMock.serverUrl = '';
        getResetToDefaultServerIdMock.mockReturnValue('');
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId('onboarding-wizard-relay:profile:relay-b')!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-welcome-auth')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');
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

    it('prefills the relay URL entry input with the currently selected relay URL when available', async () => {
        activeServerSnapshotMock.serverUrl = 'https://prefilled.relay.test';

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
        expect(relayInput.props.value).toBe('https://prefilled.relay.test');
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

        const continueAfterCredentials = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterCredentials.props.onPress?.();
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

    it('routes desktop users to the local relay hosting checklist when selecting "On this computer" and the local relay bind URL is unreachable', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';

        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('http://localhost:53288')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

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

        expect(screen.findByTestId('onboarding-wizard-relay-host-local')).toBeTruthy();

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => (
            new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
        )));
    });

    it('routes desktop users to the relay access step when selecting "On this computer" and the local relay bind URL is reachable', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';

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

        await flushHookEffects({ cycles: 2, turns: 2 });

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();
    });

    it('does not treat *.localhost URLs as a true local relay runtime bind URL for the "On this computer" fast-path', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://happier-repo-dev-a1cc5e0671.localhost:19364';

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

        await flushHookEffects({ cycles: 2, turns: 2 });

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-host-local')).toBeTruthy();
    });

    it('treats native as a handoff flow: enables "On your computer" and routes to the handoff step', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'ios' } }));

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
        expect(thisComputerRow.props.disabled).toBe(false);
        expect(thisComputerRow.props.title).toBe('setupOnboarding.relayOnYourComputerTitle');

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
    });

    it('returns web users to auth after saving a relay url from the web "On this computer" handoff', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

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

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
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
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
        expect(screen.findByTestId('onboarding-wizard-background-service-handoff')).toBeNull();
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

        const activeRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
        expect(activeRelayRow?.props.selected).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never)?.props.selected).toBe(false);

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

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();
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

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterHosted.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();

        const continueAfterAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

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

    it('shows relay access configuration before prompting to switch to the hosted relay', async () => {
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

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterHosted.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeNull();

        const continueAfterAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();
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

        const continueToChecklistButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToChecklistButton.props.onPress?.();
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

    it('branches remote relay hosting into the shared SSH checklist instead of continuing to auth immediately', async () => {
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

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-remote-ssh')).toBeTruthy();
    });

    it('lets the remote relay host step override the wizard primary CTA via the wizard chrome (no embedded buttons)', async () => {
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

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const primaryOnRemote = screen.findByTestId('onboarding-wizard-primary')!;
        const textNodes: string[] = [];
        const visit = (node: ReactTestInstance) => {
            const children = node.props?.children;
            if (typeof children === 'string') {
                textNodes.push(children);
            } else if (Array.isArray(children)) {
                for (const child of children) {
                    if (typeof child === 'string') {
                        textNodes.push(child);
                    }
                }
            }
            for (const child of node.children) {
                if (typeof child !== 'string') {
                    visit(child);
                } else {
                    textNodes.push(child);
                }
            }
        };
        visit(primaryOnRemote);
        expect(textNodes.join(' ')).toContain('Run remote setup');
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
                source: 'manual',
            },
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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
                source: 'manual',
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
        expect(relayRow?.props.disabled).toBe(false);
        expect(relayRow?.props.dimmed).toBe(true);
        expect(relayRow?.props.menuActions?.some((action: any) => action.id === 'retry')).toBe(true);
        const selectableRow = screen.findByProps({
            testID: 'onboarding-wizard-relay:profile:relay-offline',
            variant: 'selectable',
        } as never);
        expect(selectableRow?.props.title).toBe('Offline Relay');
        expect(selectableRow?.props.disabled).toBe(false);

        const callCountBefore = runtimeFetchMock.mock.calls.length;
        await act(async () => {
            const retryAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'retry');
            retryAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });

    it('does not show a saved relay row as selected when the user selected the “On this computer” option', async () => {
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'local-relay',
                name: 'Local Relay',
                serverUrl: 'http://localhost:53288',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:local-relay' } as never);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(true);
        expect(localRelayRow?.props.selected).toBe(false);
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
                source: 'manual',
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
                source: 'manual',
            },
            {
                id: 'relay-ok',
                name: 'Online Relay',
                serverUrl: 'https://relay-ok.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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
        expect(offlineRow?.props.disabled).toBe(false);

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

    it('probes a manually entered custom relay url and disables continue when it is unreachable', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://typed-unreachable-relay.example.test')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        listServerProfilesMock.mockReturnValue([]);

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

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://typed-unreachable-relay.example.test');
        });

        const saveButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const authEntry = screen.findByType('AuthEntryView' as never) as unknown as {
            props: { onChangeRelay?: () => void };
        };
        await act(async () => {
            await authEntry.props.onChangeRelay?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const typedRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
        expect(typedRelayRow?.props.selected).toBe(true);
        expect(typedRelayRow?.props.badge).toBe('common.unreachable');
        expect(typedRelayRow?.props.menuActions?.some((action: any) => action.id === 'retry')).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never)?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('surfaces mixed-content blocking as a distinct blocked status (not unreachable) on web', async () => {
        const globalWithLocation = globalThis as unknown as { location?: unknown };
        const previousLocation = globalWithLocation.location;
        try {
            try {
                Object.defineProperty(globalThis, 'location', { value: { protocol: 'https:' }, configurable: true });
            } catch {
                if (previousLocation && typeof previousLocation === 'object') {
                    try {
                        (previousLocation as any).protocol = 'https:';
                    } catch {
                        // ignore
                    }
                }
            }
            expect((globalThis as any).location?.protocol).toBe('https:');

            activeServerSnapshotMock.serverUrl = '';
            activeServerSnapshotMock.activeLocalRelayUrl = null;
            listServerProfilesMock.mockReturnValue([
                {
                    id: 'local-http',
                    name: 'Local HTTP',
                    serverUrl: 'http://127.0.0.1:53288',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                    source: 'manual' as const,
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

            await flushHookEffects({ cycles: 4, turns: 4 });

            const localRow = screen.findByTestId('onboarding-wizard-relay:profile:local-http')!;
            await act(async () => {
                await localRow.props.onPress?.();
            });
            await flushHookEffects({ cycles: 6, turns: 6 });

            // `findByTestId` prefers the deepest actionable node (often the inner SelectableRow),
            // but this assertion is about the wizard row props.
            const selectedRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:local-http' } as never);
            expect(selectedRow.props.badge).toBe('common.blocked');
            expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        } finally {
            try {
                Object.defineProperty(globalThis, 'location', { value: previousLocation, configurable: true });
            } catch {
                globalWithLocation.location = previousLocation;
            }
        }
    });

    it('keeps a prefilled local relay selected instead of auto-switching to This computer when it is unreachable', async () => {
        activeServerSnapshotMock.serverUrl = 'http://localhost:53288';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('http://localhost:53288')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        listServerProfilesMock.mockReturnValue([]);

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

        const localRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
        expect(localRelayRow?.props.selected).toBe(true);
        expect(localRelayRow?.props.disabled).toBe(false);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('setupOnboarding.currentRelayDescription');

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('keeps the active local relay selected instead of auto-switching to This computer when it is unreachable', async () => {
        activeServerSnapshotMock.serverUrl = 'http://localhost:53288';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        listServerProfilesMock.mockReturnValue([
            {
                id: 'local-relay',
                name: 'Local Relay',
                serverUrl: 'http://localhost:53288',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-ok',
                name: 'Online Relay',
                serverUrl: 'https://relay-ok.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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

        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:profile:local-relay' } as never)?.props.selected).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.getTextContent()).toContain('http://localhost:53288');
    });

    it('selects a single saved relay row when multiple profiles share the same server URL', async () => {
        activeServerSnapshotMock.serverUrl = 'https://duplicate-relay.example.test';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        listServerProfilesMock.mockReturnValue([
            {
                id: 'dup-1',
                name: 'Duplicate One',
                serverUrl: 'https://duplicate-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'dup-2',
                name: 'Duplicate Two',
                serverUrl: 'https://duplicate-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
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

        const first = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:dup-1' } as never);
        const second = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:dup-2' } as never);

        expect(first?.props.selected).toBe(true);
        expect(second?.props.selected).toBe(false);
    });

    it('disables continuing when the canonical cloud relay is unreachable and offers a retry affordance', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://api.happier.dev')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        activeServerSnapshotMock.serverUrl = '';
        listServerProfilesMock.mockReturnValue([]);

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

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-skip')?.props.disabled).toBe(true);

        const cloudChoice = screen.root.findAll((node) => {
            const props = node.props as Record<string, unknown>;
            return props.testID === 'onboarding-wizard-relay:cloud' && props.icon === 'cloud-outline';
        })[0] as unknown as ReactTestInstance | undefined;

        expect(cloudChoice?.props.badge).toBe('common.unreachable');
        expect(cloudChoice?.props.secondaryAction?.testID).toBe('onboarding-wizard-relay:cloud-retry');

        runtimeFetchMock.mockImplementation(
            previousFetchImpl
                ?? (async (input: RequestInfo | URL) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })),
        );
    });

    it('allows continuing to the web desktop handoff when hosting a relay on this computer, even if the current relay is unreachable', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('http://localhost:59331')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl ? previousFetchImpl(input, init) : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        activeServerSnapshotMock.serverUrl = 'http://localhost:59331';
        listServerProfilesMock.mockReturnValue([]);

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

        const hostRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await hostRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButtonAfter = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButtonAfter.props.disabled).toBe(false);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
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

    it('treats Happier Cloud as https://api.happier.dev even when the reset-to-default server differs', async () => {
        getResetToDefaultServerIdMock.mockImplementation(() => 'selfhost-profile');
        getServerProfileByIdMock.mockImplementation((serverId: string) => (
            serverId === 'selfhost-profile'
                ? {
                    id: 'selfhost-profile',
                    name: 'Self hosted',
                    serverUrl: 'https://selfhosted.example.test',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                    source: 'url' as const,
                }
                : serverId === 'cloud-profile'
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
        ));
        setActiveServerAndSwitchMock.mockClear();

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

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const nextButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await nextButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith({
            serverId: 'cloud-profile',
            scope: 'device',
        });
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
