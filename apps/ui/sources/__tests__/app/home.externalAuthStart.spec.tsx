import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

vi.mock('expo-camera', () => ({
    CameraView: (props: any) => React.createElement('CameraView', props),
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: 'Ionicons',
    Ionicons: 'Ionicons',
}));

const expoRouterSpies = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: expoRouterSpies }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

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

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
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
const invokeDesktopHostSpy = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined));
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
    desktopHostKind: () => tauriDesktopState.value ? 'tauri' : null,
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => invokeDesktopHostSpy(command, args),
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

const tokenStorageMock = vi.hoisted(() => ({
    setPendingExternalAuth: vi.fn(async () => true),
    clearPendingExternalAuth: vi.fn(async () => true),
    getAuthAutoRedirectSuppressedUntil: vi.fn(async () => 0),
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: tokenStorageMock,
    });
});

vi.mock('@/track', () => ({
    tracking: null,
    trackAccountCreated: vi.fn(),
    trackAccountRestored: vi.fn(),
    trackLogout: vi.fn(),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => null,
}));

vi.mock('@/components/onboarding/unauthShell', () => ({
    UnauthenticatedSplitShell: (props: any) => React.createElement('UnauthenticatedSplitShell', props, props.children),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(async () => true),
        },
    }).module;
});

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

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } = await import(
    '@/dev/testkit/harness/homeGovernanceHarness'
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { AuthProvider, setCurrentAuth } = await import('@/auth/context/AuthContext');
const pendingSetupIntent = await import('@/sync/domains/pending/pendingSetupIntent');
const setPendingSetupIntentSpy = vi.spyOn(pendingSetupIntent, 'setPendingSetupIntent');
const HOME_IDENTITY_A = 'srv_external_auth_a';
const HOME_IDENTITY_B = 'srv_external_auth_b';
let homeProfileId: string;
let homeScopeId: string;
let targetHomeProfileId: string;

beforeEach(async () => {
    await loadSyncSingletonForTests();
    await homes.reset();
    homeProfileId = await homes.addHome({
        name: 'Home A', serverUrl: 'https://api.example.test', serverIdentityId: HOME_IDENTITY_A, accountId: null,
    });
    targetHomeProfileId = await homes.addHome({
        name: 'Home B', serverUrl: 'https://stack.example.test', serverIdentityId: HOME_IDENTITY_B,
        accountId: null, active: false,
    });
    homeScopeId = resolveServerProfileScopeIdForIdentifier(homeProfileId);
    pendingSetupIntent.clearPendingSetupIntent();
    setPendingSetupIntentSpy.mockClear();
});

function SignedOutAuthProvider({ children }: React.PropsWithChildren) {
    return <AuthProvider initialCredentials={null}>{children}</AuthProvider>;
}

function renderHome(Home: React.ComponentType) {
    return renderScreen(<Home />, { wrapper: SignedOutAuthProvider });
}

async function loadHome() {
    const mod = await import('@/app/(app)/index');
    return mod.default;
}

async function advanceWizardToAuth(screen: RenderScreenResult) {
    const hasAuthActions = () => (
        screen.findAllByTestId('welcome-primary-start').length > 0
        || screen.findAllByTestId('welcome-provider-primary').length > 0
        || screen.findAllByTestId('welcome-mtls-login').length > 0
    );

    // The onboarding flow can pivot between welcome → relay select → welcome(auth actions).
    // Drive it until the composed welcome actions are visible.
    for (let attempt = 0; attempt < 8; attempt += 1) {
        if (hasAuthActions()) return;

        // A supplied Home remains on address entry until the real admission/focus action runs.
        const homeAddress = screen.findByTestId('onboarding-wizard-relay-url-input');
        if (homeAddress) {
            await screen.pressByTestIdAsync('onboarding-wizard-primary');
            await flushHookEffects({ cycles: 1, turns: 2 });
            continue;
        }

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
    const button = screen.findAllByTestId(testID).find((node) => (
        typeof node.props.action === 'function'
        || typeof node.props.onPress === 'function'
    ));
    if (!button) {
        throw new Error(`Unable to find action button "${testID}"`);
    }
    return button;
}

function githubOAuthParamsRequest() {
    const request = homes.requests.find((request) => (
        new URL(request.path, request.serverUrl).pathname === '/v1/auth/external/github/params'
    ));
    if (!request) throw new Error('Expected a GitHub OAuth params request');
    return request;
}

function mockGithubAuthFeatures(action: 'provision' | 'login', mode: 'keyed' | 'keyless') {
    const snapshot = buildServerFeaturesResponse({
        updatesOtaEnabled: false,
        authProviders: {
            github: { enabled: true, configured: true },
        },
        oauthProviders: {
            github: { enabled: true, configured: true },
        },
    });
    Object.assign(snapshot.capabilities.auth, {
        methods: [
            {
                id: 'github',
                actions: [{ id: action, enabled: true, mode }],
            },
        ],
    });
    snapshot.features.e2ee.keylessAccounts.enabled = mode === 'keyless';
    const fixtures = [
        { serverId: homeProfileId, identity: HOME_IDENTITY_A },
        { serverId: targetHomeProfileId, identity: HOME_IDENTITY_B },
    ];
    for (const { serverId, identity } of fixtures) {
        const features = { ...snapshot, capabilities: { ...snapshot.capabilities, serverIdentity: { serverIdentityId: identity } } };
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        homes.answer(serverId, '/v1/auth/external/github/params', { body: { url: 'https://oauth.example.test/auth' } });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    }
}

afterEach(async () => {
    await Promise.allSettled(fireAndForgetPromises.splice(0));
    standardCleanup();
    setCurrentAuth(null);
    pendingSetupIntent.clearPendingSetupIntent();
    await homes.reset();
    vi.clearAllMocks();
    platformState.os = 'web';
    tauriDesktopState.value = false;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
});

describe('Home external auth start', () => {
    it('keeps Tauri desktop first launch on Welcome until the user chooses a setup path', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        await renderHome(Home);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentSpy).not.toHaveBeenCalled();
        expect(expoRouterSpies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('does not redirect browser-web users into /setup by default', async () => {
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        await renderHome(Home);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentSpy).not.toHaveBeenCalled();
        expect(expoRouterSpies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('does not force mobile-native first launch through the desktop setup route', async () => {
        platformState.os = 'ios';
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        await renderHome(Home);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(setPendingSetupIntentSpy).not.toHaveBeenCalled();
        expect(expoRouterSpies.replace).not.toHaveBeenCalledWith('/setup');
    });

    it('holds the unauthenticated wizard until a cross-server override settles, then resumes auth actions on the target relay', async () => {
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

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');
        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(screen.findAllHostsByTestId('welcome-scan-existing-home')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('welcome-primary-start')).toHaveLength(0);

        await act(async () => {
            await setActiveServer({ serverId: targetHomeProfileId, scope: 'device' });
        });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await advanceWizardToAuth(screen);

        await waitForHomeGovernance(() => {
            expect(screen.findAllHostsByTestId('welcome-scan-existing-home')).toHaveLength(1);
            expect(screen.findAllHostsByTestId('welcome-primary-start').length).toBeGreaterThan(0);
        });
    });

    it('lets users enter restore from the welcome decision', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 3, turns: 3 });

        const restore = screen.findByTestId('welcome-scan-existing-home');
        expect(restore).not.toBeNull();

        await act(async () => {
            const handler = restore?.props.onPress ?? restore?.props.action;
            await handler?.();
        });

        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(setPendingSetupIntentSpy).toHaveBeenLastCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://api.example.test',
        });
    });

    it('uses / as the auth returnTo when a setup continuation is pending (wizard resumes after auth)', async () => {
        tauriDesktopState.value = true;

        const Home = await loadHome();
        pendingSetupIntent.setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://api.example.test',
        });
        setPendingSetupIntentSpy.mockClear();
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-primary-start');
        await act(async () => {
            await signupButton.props.onPress();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                returnTo: '/',
            }),
            { serverId: homeScopeId, serverUrl: 'https://api.example.test' },
        );
    });

    it('starts keyed external provider signup with publicKey', async () => {
        const Home = await loadHome();
        mockGithubAuthFeatures('provision', 'keyed');

        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const signupButton = findActionButton(screen, 'welcome-primary-start');
        await act(async () => {
            await signupButton.props.onPress();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
                secret: expect.any(String),
            }),
            { serverId: homeScopeId, serverUrl: 'https://api.example.test' },
        );
        const request = githubOAuthParamsRequest();
        expect(request).toMatchObject({ serverId: homeProfileId, serverUrl: 'https://api.example.test' });
        const query = new URL(request.path, request.serverUrl).searchParams;
        expect(query.get('proofHash')).toEqual(expect.any(String));
        expect(query.get('publicKey')).toEqual(expect.any(String));
        // The Home OAuth wire contract omits mode for keyed starts.
        expect(query.get('mode')).toBeNull();

    });

    it('starts keyless external login with mode=keyless proofHash', async () => {
        const Home = await loadHome();
        mockGithubAuthFeatures('login', 'keyless');

        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 3, turns: 3 });

        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const loginButton = findActionButton(screen, 'welcome-provider-primary');
        await act(async () => {
            await loginButton.props.onPress();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                proof: expect.any(String),
            }),
            { serverId: homeScopeId, serverUrl: 'https://api.example.test' },
        );
        const request = githubOAuthParamsRequest();
        expect(request).toMatchObject({ serverId: homeProfileId, serverUrl: 'https://api.example.test' });
        const query = new URL(request.path, request.serverUrl).searchParams;
        expect(query.get('mode')).toBe('keyless');
        expect(query.get('proofHash')).toEqual(expect.any(String));

    });

    it('keeps the captured Home target between pending storage and OAuth params', async () => {
        const Home = await loadHome();
        let releasePending!: (stored: boolean) => void;
        tokenStorageMock.setPendingExternalAuth.mockImplementationOnce(
            async () => await new Promise<boolean>((resolve) => {
                releasePending = resolve;
            }),
        );
        mockGithubAuthFeatures('login', 'keyless');

        const screen = await renderHome(Home);
        await flushHookEffects({ cycles: 3, turns: 3 });
        await advanceWizardToAuth(screen);
        await flushHookEffects({ cycles: 2, turns: 2 });

        const loginButton = findActionButton(screen, 'welcome-provider-primary');
        let started!: Promise<unknown>;
        act(() => {
            started = loginButton.props.onPress();
        });
        try {
            await waitForHomeGovernance(() => {
                expect(tokenStorageMock.setPendingExternalAuth).toHaveBeenCalledWith(
                expect.objectContaining({
                    serverId: homeScopeId,
                    serverUrl: 'https://api.example.test',
                }),
                {
                    serverId: homeScopeId,
                    serverUrl: 'https://api.example.test',
                },
            );
            });
        await act(async () => {
            await setActiveServer({ serverId: targetHomeProfileId, scope: 'device' });
            releasePending(true);
            await started;
        });
        } finally {
            releasePending?.(true);
            await started;
        }

        const request = githubOAuthParamsRequest();
        expect(request).toMatchObject({ serverId: homeProfileId, serverUrl: 'https://api.example.test' });
        expect(new URL(request.path, request.serverUrl).searchParams.get('mode')).toBe('keyless');
    });
});
