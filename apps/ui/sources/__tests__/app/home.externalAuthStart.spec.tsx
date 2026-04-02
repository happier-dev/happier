import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, createModalModuleMock, flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

vi.mock('expo-camera', () => ({
    CameraView: (props: any) => React.createElement('CameraView', props),
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: vi.fn(),
        loginWithCredentials: vi.fn(),
        credentials: null,
    }),
}));

const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: any[]) => (getServerFeaturesSnapshotMock as any)(...args),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>());
const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    clearPendingSetupIntent: vi.fn(),
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsLandscape: () => false,
    };
});

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));

const tauriDesktopState = vi.hoisted(() => ({
    value: false,
}));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (options: Record<string, unknown>) => options?.[platformState.os] ?? options?.default,
        },
    });
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

const getAuthProviderMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: (id: string) => getAuthProviderMock(id),
}));

const activeServerSwitchMocks = vi.hoisted(() => ({
    setActiveServerAndSwitch: vi.fn(async (_params: unknown) => true),
    upsertActivateAndSwitchServer: vi.fn(async (_params: unknown) => true),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => value,
    isSameServerUrl: (left: string, right: string) => left === right,
    setActiveServerAndSwitch: (params: unknown) => activeServerSwitchMocks.setActiveServerAndSwitch(params),
    upsertActivateAndSwitchServer: (params: unknown) => activeServerSwitchMocks.upsertActivateAndSwitchServer(params),
}));

const CLOUD_SERVER_URL = 'https://api.happier.dev';
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getResetToDefaultServerId: () => 'cloud-profile',
        getServerProfileById: (serverId: string) => (
            serverId === 'cloud-profile'
                ? { id: 'cloud-profile', serverUrl: CLOUD_SERVER_URL }
                : null
        ),
        getOrCreateHappierCloudServerProfile: () => ({ id: 'cloud-profile', name: 'Happier Cloud', serverUrl: CLOUD_SERVER_URL }),
        listServerProfiles: () => [],
    };
});

const tokenStorageMock = vi.hoisted(() => ({
    setPendingExternalAuth: vi.fn(async () => true),
    clearPendingExternalAuth: vi.fn(async () => undefined),
    getAuthAutoRedirectSuppressedUntil: vi.fn(async () => 0),
}));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: tokenStorageMock,
}));

vi.mock('@/auth/providers/externalAuthUrl', () => ({
    isSafeExternalAuthUrl: () => true,
}));

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        getActiveServerSnapshot: () => ({ serverUrl: 'http://api.example.test' }),
        isActiveServerSelectionExplicit: () => false,
        subscribeActiveServer: () => () => {},
    };
});

vi.mock('@/track', () => ({
    trackAccountCreated: vi.fn(),
    trackAccountRestored: vi.fn(),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => null,
}));

vi.mock('@/components/onboarding/preAuth/WelcomeProvidersShowcase', () => ({
    WelcomeProvidersShowcase: () => null,
}));

vi.mock('@/components/account/auth/AuthEntryView', () => ({
    AuthEntryView: (props: any) => {
        const availability = String(props?.options?.serverAvailability ?? '');
        const providerId = String(props?.options?.providerId ?? '').trim() || null;
        const keylessProviderId = String(props?.options?.keylessProviderId ?? '').trim() || null;
        const configureRelay = React.createElement('AuthAction', {
            testID: 'welcome-configure-server',
            onPress: props.onChangeRelay,
        });

        if (availability === 'incompatible' || availability === 'unavailable') {
            return React.createElement(React.Fragment, null, configureRelay);
        }

        return React.createElement(
            React.Fragment,
            null,
            React.createElement('AuthAction', { testID: 'welcome-restore', onPress: props.onRestore }),
            React.createElement('AuthAction', {
                testID: 'welcome-signup-provider',
                action: () => {
                    const target = providerId ?? 'github';
                    return props.onCreateAccountViaProvider?.(target);
                },
            }),
            React.createElement('AuthAction', {
                testID: 'welcome-create-account',
                action: () => {
                    if (keylessProviderId) {
                        return props.onLoginWithKeylessProvider?.(keylessProviderId);
                    }
                    return props.onCreateAccount?.();
                },
            }),
            React.createElement('AuthAction', {
                testID: 'welcome-mtls-login',
                action: () => props.onLoginWithMtls?.(),
            }),
        );
    },
}));

const modalMock = createModalModuleMock({
    spies: {
        alert: vi.fn(),
        confirm: vi.fn(async () => true),
    },
});
vi.mock('@/modal', () => modalMock.module);

const fireAndForgetPromises = vi.hoisted(() => [] as Promise<any>[]);
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<any>) => {
        fireAndForgetPromises.push(promise);
    },
}));

vi.mock('@/utils/errors/formatOperationFailedDebugMessage', () => ({
    formatOperationFailedDebugMessage: (fallback: string) => fallback,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (size: number) => new Uint8Array(size).fill(1),
    getRandomBytesAsync: async (size: number) => new Uint8Array(size).fill(1),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function loadHome() {
    const mod = await import('@/app/(app)/index');
    return mod.default;
}

async function advanceWizardToAuth(screen: RenderScreenResult) {
    const hasAuthActions = () => (
        screen.findAllByTestId('welcome-signup-provider').length > 0
        || screen.findAllByTestId('welcome-create-account').length > 0
        || screen.findAllByTestId('welcome-mtls-login').length > 0
    );

    // The onboarding flow can pivot between welcome → relay select → welcome(auth actions).
    // Drive it until AuthEntryView actions are visible.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if (hasAuthActions()) return;

        const cloud = screen.findByTestId('onboarding-wizard-relay:cloud');
        if (cloud) {
            await act(async () => {
                await (cloud.props.onPress ?? cloud.props.action)?.();
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            continue;
        }

        const primary = screen.findByTestId('onboarding-wizard-primary');
        if (primary) {
            await act(async () => {
                await (primary.props.onPress ?? primary.props.action)?.();
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            continue;
        }

        const skip = screen.findByTestId('onboarding-wizard-skip');
        if (skip) {
            await act(async () => {
                await (skip.props.onPress ?? skip.props.action)?.();
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
            continue;
        }

        break;
    }
}

function findActionButton(screen: RenderScreenResult, testID: string) {
    const button = screen.findAllByTestId(testID).find((node) => typeof node.props.action === 'function');
    if (!button) {
        throw new Error(`Unable to find action button "${testID}"`);
    }
    return button;
}

function mockGithubAuthFeatures(action: 'provision' | 'login', mode: 'keyed' | 'keyless') {
    getServerFeaturesSnapshotMock.mockResolvedValue({
        status: 'ready',
        features: {
            capabilities: {
                oauth: {
                    providers: {
                        github: { configured: true },
                    },
                },
                auth: {
                    methods: [
                        {
                            id: 'github',
                            actions: [{ id: action, enabled: true, mode }],
                        },
                    ],
                },
            },
        },
    });
}

afterEach(() => {
    vi.clearAllMocks();
    platformState.os = 'web';
    tauriDesktopState.value = false;
    getPendingSetupIntentMock.mockReturnValue(null);
    setPendingSetupIntentMock.mockReset();
});

describe('Home external auth start', () => {
    it('records a pending setup intent on first launch for Tauri desktop users', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'pre_auth',
            relayUrl: 'http://api.example.test',
        });
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('does not redirect browser-web users into /setup by default', async () => {
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('does not force mobile-native first launch through the desktop setup route', async () => {
        platformState.os = 'ios';
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        getPendingSetupIntentMock.mockReturnValue(null);

        await renderScreen(<Home />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('lets users skip directly to auth from the wizard header', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 3, turns: 3 });

        const skip = screen.findByTestId('onboarding-wizard-skip');
        expect(skip).not.toBeNull();

        await act(async () => {
            const handler = skip?.props.onPress ?? skip?.props.action;
            await handler?.();
        });

        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(setPendingSetupIntentMock).toHaveBeenLastCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'http://api.example.test',
        });
    });

    it('keeps the server configuration screen reachable when the selected relay is incompatible', async () => {
        const Home = await loadHome();
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'http://api.example.test',
        });
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'unsupported',
            reason: 'invalid_payload',
        });

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const button = screen.findByTestId('welcome-configure-server');
        expect(button).not.toBeNull();

        await act(async () => {
            const handler = button?.props.onPress ?? button?.props.action;
            await handler?.();
        });

        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).not.toBeNull();
    });

    it('uses / as the auth returnTo when a setup continuation is pending (wizard resumes after auth)', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-signup-provider');
        await act(async () => {
            await signupButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                returnTo: '/',
            }),
        );
    });

    it('starts keyed external provider signup with publicKey', async () => {
        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-signup-provider');
        await act(async () => {
            await signupButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
                secret: expect.any(String),
            }),
        );
        expect(provider.getExternalAuthUrl).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'keyed',
                proofHash: expect.any(String),
                publicKey: expect.any(String),
            }),
        );

    });

    it('starts keyless external login with mode=keyless proofHash', async () => {
        const Home = await loadHome();
        const provider = {
            id: 'github',
            getExternalAuthUrl: vi.fn(async () => 'https://oauth.example.test/auth'),
        };
        getAuthProviderMock.mockReturnValue(provider);
        mockGithubAuthFeatures('login', 'keyless');

        const screen = await renderScreen(<Home />);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const loginButton = findActionButton(screen, 'welcome-create-account');
        await act(async () => {
            await loginButton.props.action();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
            }),
        );
        expect(provider.getExternalAuthUrl).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: 'keyless',
                proofHash: expect.any(String),
            }),
        );

    });
});
