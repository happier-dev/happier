import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { onboardingAuthHistoryState } from '@/sync/domains/state/onboardingUiState';
import type { StorageState } from '@/sync/store/types';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { IModal } from '@/modal';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const reactNativeState = vi.hoisted(() => ({
    width: 390,
    height: 844,
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    params: {} as Record<string, string>,
}));

const authMock = vi.hoisted(() => ({
    login: vi.fn(async () => ({ kind: 'completed' as const })),
    loginWithCredentials: vi.fn(async () => ({
        kind: 'completed' as const,
    })),
    refreshFromActiveServer: vi.fn(async () => {}),
}));

const serverFetchMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalAlertAsyncMock = vi.hoisted(() => vi.fn<IModal['alertAsync']>(async () => {}));
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>(() => 'modal-id'));
const trackAccountCreatedMock = vi.hoisted(() => vi.fn());
const activeServerSwitchMock = vi.hoisted(() => vi.fn(async () => 'switched' as const));
const generatedAsyncBytes = vi.hoisted(() => [] as Uint8Array[]);

function buildWelcomeFeaturesResponse() {
    const response = buildServerFeaturesResponse();
    return {
        ...response,
        capabilities: {
            ...response.capabilities,
            server: { canonicalServerUrl: 'https://relay.example.test' },
            serverIdentity: { serverIdentityId: 'srv_home_a' },
            auth: {
                ...response.capabilities.auth,
                keyChallenge: { v2: false },
                methods: [{
                    id: 'key_challenge',
                    actions: [{ id: 'provision' as const, enabled: true, mode: 'keyed' as const }],
                }],
            },
        },
    };
}

type EmailPasswordStepProps = Readonly<{
    onAuthenticated: (outcome: unknown) => Promise<void>;
    reachExactHome?: () => Promise<boolean>;
}>;

function findEmailPasswordStep(screen: Awaited<ReturnType<typeof renderScreen>>): EmailPasswordStepProps | null {
    const node = screen.findAll((candidate) => (
        typeof candidate.props.onClose === 'function'
        && typeof candidate.props.onAuthenticated === 'function'
        && typeof candidate.props.recoveryTarget === 'string'
    ))[0];
    return node ? node.props as EmailPasswordStepProps : null;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: { get: () => ({ ...reactNativeState, scale: 2, fontScale: 1 }) },
        useWindowDimensions: () => ({ ...reactNativeState, scale: 2, fontScale: 1 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', () => createExpoRouterMock({
    params: () => routerMocks.params,
    router: {
        push: routerMocks.push,
        replace: routerMocks.replace,
        back: routerMocks.back,
    },
}).module);

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('ExpoImage', props),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@react-native/virtualized-lists', () => ({
    VirtualizedList: 'VirtualizedList',
    VirtualizedSectionList: 'VirtualizedSectionList',
}));

vi.mock('react-native-keyboard-controller', () => ({}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalShowMock, alert: modalAlertMock, alertAsync: modalAlertAsyncMock } }).module;
});

vi.mock('@/sync/domains/server/activeServerSwitch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/activeServerSwitch')>();
    return {
        ...actual,
        setActiveServerAndSwitch: activeServerSwitchMock,
    };
});

vi.mock('@/sync/http/client', async () => {
    const actual = await vi.importActual<typeof import('@/sync/http/client')>('@/sync/http/client');
    return {
        ...actual,
        serverFetch: serverFetchMock,
    };
});

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: authMock.login,
        loginWithCredentials: authMock.loginWithCredentials,
        refreshFromActiveServer: authMock.refreshFromActiveServer,
    }),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: vi.fn((size: number) => new Uint8Array(size).fill(3)),
    getRandomBytesAsync: vi.fn(async (size: number) => {
        const bytes = new Uint8Array(size).fill(7);
        generatedAsyncBytes.push(bytes);
        return bytes;
    }),
}));

vi.mock('@/track', () => ({
    tracking: null,
    trackAccountCreated: trackAccountCreatedMock,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useIsLandscape: () => false,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => null,
    isDesktopHost: () => false,
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    setPendingSetupIntent: vi.fn(),
    clearPendingSetupIntent: () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    }),
    getActiveServerHomeCarrier: () => null,
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getServerProfileById: (serverId: string) => serverId === 'server-a' ? {
            id: 'server-a',
            name: 'Example Home',
            serverUrl: 'https://relay.example.test',
            canonicalServerUrl: 'https://relay.example.test',
            serverIdentityId: 'srv_home_a',
        } : null,
    };
});

vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => '',
    readConfiguredServerUrlEnvRaw: () => '',
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_seed_keypair: () => ({
            publicKey: new Uint8Array(32).fill(1),
            privateKey: new Uint8Array(32).fill(2),
        }),
        crypto_sign_seed_keypair: () => ({
            publicKey: new Uint8Array(32).fill(1),
            privateKey: new Uint8Array(64).fill(2),
        }),
        crypto_sign_detached: () => new Uint8Array(64).fill(3),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('PreAuthOnboardingWizardEntry shell integration', () => {
    let previousStorageState: StorageState;
    let previousAuthHistory: boolean | undefined;

    beforeEach(async () => {
        routerMocks.params = {};
        previousAuthHistory = onboardingAuthHistoryState.read('completed');
        // This suite exercises the returning-user shell; first-time entry belongs to the Journey host suite.
        onboardingAuthHistoryState.set('completed', true);
        resetServerFeaturesClientForTests();
        await TokenStorage.clearPendingExternalAuth({
            serverUrl: 'https://relay.example.test',
            serverId: 'server-a',
        });
        previousStorageState = storage.getState();
        act(() => {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...localSettingsDefaults,
                },
            }));
        });
        reactNativeState.width = 390;
        reactNativeState.height = 844;
        authMock.login.mockClear();
        authMock.loginWithCredentials.mockClear();
        authMock.refreshFromActiveServer.mockClear();
        generatedAsyncBytes.length = 0;
        serverFetchMock.mockReset();
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/features'
                ? new Response(JSON.stringify(buildWelcomeFeaturesResponse()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(null, { status: 404 })
        ));
        setRuntimeFetch((input, init) => (
            serverFetchMock(new URL(input instanceof Request ? input.url : String(input)).pathname, init)
        ));
        modalAlertMock.mockClear();
        modalAlertAsyncMock.mockReset();
        modalAlertAsyncMock.mockResolvedValue(undefined);
        modalShowMock.mockClear();
        trackAccountCreatedMock.mockClear();
        activeServerSwitchMock.mockReset();
        activeServerSwitchMock.mockResolvedValue('switched');
        routerMocks.push.mockClear();
        routerMocks.replace.mockClear();
        routerMocks.back.mockClear();
    });

    it('opens the public Home step inside the welcome pane', async () => {
        routerMocks.params = { step: 'home' };
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);
        expect(screen.findByTestId('unauth-shell-route-setup-pre-auth')).toBeTruthy();
        expect(screen.findByTestId('relay-select-route-content')).toBeTruthy();
    });

    it('holds the real Welcome E2EE provision destination behind the canonical recovery-key decision and skips it for Plain', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const runProvision = async (mode: 'keyed' | 'keyless') => {
            const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);
            const panel = screen.find((candidate) => (
                candidate.props.authEntryOptions != null
                && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
                && typeof candidate.props.onOpenSecretKeyLogin === 'function'
            ));
            if (!panel?.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home auth entry');
            const target = panel.props.authEntryOptions.homeTarget;
            await panel.props.onContinueWithHomeAuthentication({
                method: { id: 'email_password', enabledActions: [{ id: 'provision', mode }] },
                action: { id: 'provision', mode },
                execution: { kind: 'email_password', action: 'provision', mode },
                authority: { purpose: 'home', target },
                intendedHome: target,
            }, { signal: new AbortController().signal });
            await flushHookEffects();
            const step = findEmailPasswordStep(screen);
            if (!step) throw new Error('Expected the email/password workflow step');
            return { finish: step.onAuthenticated, unmount: screen.unmount };
        };

        const recoverySecret = new Uint8Array(32).fill(9);
        const e2ee = await runProvision('keyed');
        let destinationCompleted = false;
        const pending = e2ee.finish({
            credentials: { token: 'e2ee-token', secret: 'e2ee-secret' },
            accountId: 'account-a',
            teamId: null,
            recoverySecret,
        }).then(() => { destinationCompleted = true; });

        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledOnce());
        expect(authMock.loginWithCredentials).toHaveBeenCalledWith(
            { token: 'e2ee-token', secret: 'e2ee-secret' },
            { target: { serverId: 'server-a', serverUrl: 'https://relay.example.test' }, signInMethodId: 'email_password' },
        );
        expect(destinationCompleted).toBe(false);
        expect(trackAccountCreatedMock).not.toHaveBeenCalled();
        const disclosure = modalShowMock.mock.calls.at(-1)?.[0] as unknown as {
            dismissible?: boolean;
            props?: { secret?: Uint8Array; onSaved?: () => Promise<void>; onDefer?: () => Promise<void> };
        };
        expect(disclosure.dismissible).toBe(false);
        expect(disclosure.props?.onSaved).toBeTypeOf('function');
        await disclosure.props!.onSaved!();
        await pending;
        expect(destinationCompleted).toBe(true);
        expect(trackAccountCreatedMock).toHaveBeenCalledOnce();
        expect([...recoverySecret]).toEqual(new Array(32).fill(0));
        expect([...(disclosure.props?.secret ?? [])]).toEqual(new Array(32).fill(0));
        await e2ee.unmount();

        modalShowMock.mockClear();
        trackAccountCreatedMock.mockClear();
        const deferredRecoverySecret = new Uint8Array(32).fill(8);
        const deferred = await runProvision('keyed');
        let deferredDestinationCompleted = false;
        const deferredPending = deferred.finish({
            credentials: { token: 'deferred-e2ee-token', secret: 'deferred-e2ee-secret' },
            accountId: 'account-deferred',
            teamId: null,
            recoverySecret: deferredRecoverySecret,
        }).then(() => { deferredDestinationCompleted = true; });
        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledOnce());
        const deferredDisclosure = modalShowMock.mock.calls.at(-1)?.[0] as unknown as {
            props?: { secret?: Uint8Array; onDefer?: () => Promise<void> };
        };
        expect(deferredDestinationCompleted).toBe(false);
        await deferredDisclosure.props!.onDefer!();
        await deferredPending;
        expect(deferredDestinationCompleted).toBe(true);
        expect(trackAccountCreatedMock).toHaveBeenCalledOnce();
        expect([...deferredRecoverySecret]).toEqual(new Array(32).fill(0));
        await deferred.unmount();
        expect([...(deferredDisclosure.props?.secret ?? [])]).toEqual(new Array(32).fill(0));

        modalShowMock.mockClear();
        trackAccountCreatedMock.mockClear();
        const plain = await runProvision('keyless');
        await plain.finish({
            credentials: { token: 'plain-token' },
            accountId: 'account-b',
            teamId: null,
            recoverySecret: null,
        });
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(trackAccountCreatedMock).toHaveBeenCalledOnce();
    });

    it('carries Welcome Connect through exact-Home login into Account Security enrollment', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);
        // The Welcome panel's own action, so the request runs through the wizard controller.
        const panel = screen.find((candidate) => (
            candidate.props.authEntryOptions != null
            && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
            && typeof candidate.props.onOpenSecretKeyLogin === 'function'
        ));
        if (!panel?.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home auth entry');
        const target = panel.props.authEntryOptions.homeTarget;
        await panel.props.onContinueWithHomeAuthentication({
            method: { id: 'email_password', enabledActions: [{ id: 'connect', mode: 'either' }] },
            action: { id: 'connect', mode: 'either' },
            execution: { kind: 'email_password', action: 'connect', mode: 'either' },
            authority: { purpose: 'home', target },
            intendedHome: target,
        }, { signal: new AbortController().signal });
        await flushHookEffects();
        // Email/password is a step of Welcome's own workflow pane, never a modal over it.
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-bare-title')).toBeNull();
        const step = findEmailPasswordStep(screen);
        if (!step) throw new Error('Expected the email/password workflow step');
        // Welcome has no other step behind this one, so Connect's exact-Home
        // activation is handed to the step as its arrival rather than run as a
        // side effect of the login whose answer nobody reads.
        if (!step.reachExactHome) throw new Error('Expected an exact-Home arrival for Connect');
        await step.onAuthenticated({ credentials: { token: 'home-a-token' } });
        expect(activeServerSwitchMock).not.toHaveBeenCalled();

        let finishSwitch!: (result: 'switched') => void;
        activeServerSwitchMock.mockImplementationOnce(async () => await new Promise<'switched'>((resolve) => {
            finishSwitch = resolve;
        }));
        const pending = step.reachExactHome();

        await vi.waitFor(() => expect(activeServerSwitchMock).toHaveBeenCalledOnce());
        expect(activeServerSwitchMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            scope: 'device',
            refreshAuth: authMock.refreshFromActiveServer,
            requireExactProfile: true,
        });
        expect(routerMocks.replace).not.toHaveBeenCalled();
        finishSwitch('switched');
        await expect(pending).resolves.toBe(true);
        expect(routerMocks.replace).toHaveBeenCalledWith({
            pathname: '/settings/account/security',
            params: { serverId: 'server-a', intent: 'email_password_connect' },
        });
    });

    afterEach(() => {
        if (previousAuthHistory === undefined) onboardingAuthHistoryState.remove('completed');
        else onboardingAuthHistoryState.set('completed', previousAuthHistory);
        act(() => {
            storage.setState(previousStorageState, true);
        });
        standardCleanup();
        resetRuntimeFetch();
    });

    it('creates an anonymous account from the desktop Welcome workflow', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/features'
                ? new Response(JSON.stringify(buildWelcomeFeaturesResponse()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : path === '/v1/auth'
                ? new Response(JSON.stringify({ token: 'account-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : path === '/v1/account/encryption'
                ? new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(null, { status: 404 })
        ));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard')).toBeTruthy());
        expect(screen.findByTestId('unauth-shell-route-welcome')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-workflow-pane')).toBeTruthy();

        const panel = screen.find((candidate) => (
            candidate.props.authEntryOptions != null
            && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
        ));
        if (!panel) throw new Error('Expected welcome decision panel');
        const projected = panel.props.authEntryOptions.authenticationActions.find(
            (candidate: { execution: { kind: string } }) => candidate.execution.kind === 'generated_key',
        );
        if (!projected || !panel.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home provision action');
        await act(async () => {
            await panel.props.onContinueWithHomeAuthentication({
                ...projected,
                authority: { purpose: 'home', target: panel.props.authEntryOptions.homeTarget },
                intendedHome: panel.props.authEntryOptions.homeTarget,
            }, { signal: new AbortController().signal });
        });
        await flushHookEffects();

        expect(modalAlertMock).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(authMock.loginWithCredentials).toHaveBeenCalledWith(
                { token: 'account-token' },
                { target: { serverId: 'server-a', serverUrl: 'https://relay.example.test' }, signInMethodId: 'key_challenge' },
            );
        });
    });

    it('surfaces raced signup policy and requests a capability refresh instead of a generic failure', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/features'
                ? new Response(JSON.stringify(buildWelcomeFeaturesResponse()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : path === '/v1/auth'
                ? new Response(JSON.stringify({ error: 'signup-disabled' }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                })
                : new Response(null, { status: 404 })
        ));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        const panel = screen.find((candidate) => (
            candidate.props.authEntryOptions != null
            && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
        ));
        if (!panel) throw new Error('Expected welcome decision panel');
        const projected = panel.props.authEntryOptions.authenticationActions.find(
            (candidate: { execution: { kind: string } }) => candidate.execution.kind === 'generated_key',
        );
        if (!projected || !panel.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home provision action');
        const countFeatureFetches = () => serverFetchMock.mock.calls.filter(([path]) => path === '/v1/features').length;
        const featureFetchesBeforeSignup = countFeatureFetches();
        await act(async () => {
            await panel.props.onContinueWithHomeAuthentication({
                ...projected,
                authority: { purpose: 'home', target: panel.props.authEntryOptions.homeTarget },
                intendedHome: panel.props.authEntryOptions.homeTarget,
            }, { signal: new AbortController().signal });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'errors.signupDisabled'));
        expect(countFeatureFetches()).toBeGreaterThan(featureFetchesBeforeSignup);
        expect(authMock.login).not.toHaveBeenCalled();
    });

    it('retries encryption-mode resolution without provisioning a second account after authentication succeeded', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        let encryptionModeAttempts = 0;
        modalAlertAsyncMock.mockImplementation(async (
            _title: string,
            _message?: string,
            buttons?: Array<{ text?: string; style?: string; onPress?: () => void }>,
        ) => {
            buttons?.find((button: { text?: string }) => button.text === 'common.retry')?.onPress?.();
        });
        serverFetchMock.mockImplementation(async (path: string) => {
            if (path === '/v1/features') {
                return new Response(JSON.stringify(buildWelcomeFeaturesResponse()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v1/auth') {
                return new Response(JSON.stringify({ token: 'retained-account-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v1/account/encryption') {
                encryptionModeAttempts += 1;
                return encryptionModeAttempts === 1
                    ? new Response(null, { status: 503 })
                    : new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
            }
            return new Response(null, { status: 404 });
        });

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);
        const panel = screen.find((candidate) => (
            candidate.props.authEntryOptions != null
            && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
        ));
        if (!panel) throw new Error('Expected welcome decision panel');
        const projected = panel.props.authEntryOptions.authenticationActions.find(
            (candidate: { execution: { kind: string } }) => candidate.execution.kind === 'generated_key',
        );
        if (!projected || !panel.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home provision action');
        const request = {
            ...projected,
            authority: { purpose: 'home', target: panel.props.authEntryOptions.homeTarget },
            intendedHome: panel.props.authEntryOptions.homeTarget,
        };

        await act(async () => {
            await panel.props.onContinueWithHomeAuthentication(request, { signal: new AbortController().signal });
        });

        expect(serverFetchMock.mock.calls.filter(([path]) => path === '/v1/auth')).toHaveLength(1);
        expect(serverFetchMock.mock.calls.filter(([path]) => path === '/v1/account/encryption')).toHaveLength(2);
        expect(authMock.loginWithCredentials).toHaveBeenCalledWith(
            { token: 'retained-account-token' },
            { target: { serverId: 'server-a', serverUrl: 'https://relay.example.test' }, signInMethodId: 'key_challenge' },
        );
        expect(modalAlertAsyncMock).toHaveBeenCalledWith('common.error', 'errors.operationFailed', [
            expect.objectContaining({ text: 'common.retry' }),
            expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
        ]);
    });

    it('releases retained generated-key material when the journey aborts during mode recovery', async () => {
        reactNativeState.width = 1100;
        reactNativeState.height = 720;
        serverFetchMock.mockImplementation(async (path: string) => (
            path === '/v1/features'
                ? new Response(JSON.stringify(buildWelcomeFeaturesResponse()), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
                : path === '/v1/auth'
                    ? new Response(JSON.stringify({ token: 'cancelled-account-token' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    })
                    : path === '/v1/account/encryption'
                        ? new Response(null, { status: 503 })
                        : new Response(null, { status: 404 })
        ));
        modalAlertAsyncMock.mockImplementation(() => new Promise<void>(() => {}));

        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);
        const panel = screen.find((candidate) => (
            candidate.props.authEntryOptions != null
            && typeof candidate.props.onContinueWithHomeAuthentication === 'function'
        ));
        if (!panel) throw new Error('Expected welcome decision panel');
        const projected = panel.props.authEntryOptions.authenticationActions.find(
            (candidate: { execution: { kind: string } }) => candidate.execution.kind === 'generated_key',
        );
        if (!projected || !panel.props.authEntryOptions.homeTarget) throw new Error('Expected exact Home provision action');
        const controller = new AbortController();
        const launch = panel.props.onContinueWithHomeAuthentication({
            ...projected,
            authority: { purpose: 'home', target: panel.props.authEntryOptions.homeTarget },
            intendedHome: panel.props.authEntryOptions.homeTarget,
        }, { signal: controller.signal });

        await vi.waitFor(() => expect(modalAlertAsyncMock).toHaveBeenCalledTimes(1));
        controller.abort();
        await launch;

        expect(authMock.loginWithCredentials).not.toHaveBeenCalled();
        expect(generatedAsyncBytes).toHaveLength(1);
        expect([...generatedAsyncBytes[0]!]).toEqual(new Array(32).fill(0));
    });

    it('keeps returning mobile users in workflow and navigates restore and relay through the shell', async () => {
        const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
        const screen = await renderScreen(<PreAuthOnboardingWizardEntry />);

        await vi.waitFor(() => expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy());
        expect(screen.findByTestId('unauth-shell-route-welcome')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeNull();

        await screen.pressByTestIdAsync('welcome-scan-existing-home');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('unauth-shell-route-restore')).toBeTruthy();
        expect(screen.findByTestId('restore-route-content')).toBeTruthy();
        // Approve on the Home already in use chooses nothing: no re-selection that would
        // turn the welcome corner from "Run your own Home" into that Home's address.
        expect(activeServerSwitchMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-scan-existing-home')).toHaveLength(0);

        await screen.pressByTestIdAsync('unauth-shell-back-chevron');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('welcome-scan-existing-home')).toBeTruthy();

        await screen.pressByTestIdAsync('welcome-self-hosting');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('unauth-shell-route-setup-pre-auth')).toBeTruthy();
        expect(screen.findByTestId('relay-select-route-content')).toBeTruthy();
        expect(screen.findByTestId('unauth-shell-back-chevron')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-scan-existing-home')).toHaveLength(0);
    });
});
