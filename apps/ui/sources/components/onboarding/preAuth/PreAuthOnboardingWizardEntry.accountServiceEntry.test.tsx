import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';

/**
 * Unauthenticated Welcome sign-in against the selected Account Service (Lane 02 A7 / G02-1, G02-2).
 *
 * These assertions are deliberately about the exact request target: a focused Home must never be
 * able to retarget sign-in-service discovery or the provider continuation.
 */

const SELECTED_SERVICE_URL = 'https://api.happier.dev';
const SELECTED_SERVICE_IDENTITY = 'srv_cloud_identity';
const OTHER_SERVICE_URL = 'https://other.happier.dev';
const OTHER_SERVICE_IDENTITY = 'srv_other_identity';
const FOCUSED_HOME_URL = 'https://home-a.example.test';
const accountDirectoryPending = {
    endpoint: SELECTED_SERVICE_URL,
    serverIdentityId: SELECTED_SERVICE_IDENTITY,
    canonicalServerUrl: SELECTED_SERVICE_URL,
    provider: 'github',
    purpose: 'account_directory' as const,
    credentialTarget: 'account_directory' as const,
    entryIntent: { kind: 'enter' as const, target: { kind: 'automatic' as const } },
    mode: 'keyless' as const,
    proof: 'exact-proof',
    createdAt: 1,
    expiresAt: 2,
    returnTo: '/account-entry',
};
const accountDirectoryStartResult: Readonly<{ url: string; pending: typeof accountDirectoryPending }> = {
    url: `${SELECTED_SERVICE_URL}/v1/auth/external/github/start?pending=abc`,
    pending: accountDirectoryPending,
};

const discoverAuthenticationMethodsMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn(async () => null as string | null));
const modalAlertMock = vi.hoisted(() => vi.fn(() => {}));
const modalAlertAsyncMock = vi.hoisted(() => vi.fn(async () => {}));
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({
    serverId: 'home-a',
    serverUrl: 'https://home-a.example.test',
    generation: 1,
})));
// Observe custody without replacing its storage or compare-and-remove decisions.
const setPendingExternalAuthMock = vi.spyOn(TokenStorage, 'setPendingExternalAuth');
const clearPendingExternalAuthMock = vi.spyOn(TokenStorage, 'clearPendingExternalAuth');
const clearPendingAccountDirectoryAuthMock = vi.spyOn(TokenStorage, 'clearPendingAccountDirectoryAuth');
const locationAssignMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const homeCarrier = vi.hoisted(() => ({
    endpointId: 'focused-home-carrier',
    readObservedPath: vi.fn(),
    request: vi.fn(),
    createWebSocket: vi.fn(),
}));
const wizardControllerMock = vi.hoisted(() => {
    const goToStep = vi.fn();
    return {
        goToStep,
        lastProps: null as Record<string, unknown> | null,
        current: {
            stepId: 'welcome',
            currentStepIndex: 0,
            stepCount: 4,
            showBack: false,
            showSkip: undefined,
            navigationLocked: false,
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

const authEntryOptionsState: { current: AuthEntryOptions } = vi.hoisted(() => ({
    current: {
        serverAvailability: 'ready',
        authEntryUnavailable: false,
        serverUrlForCopy: 'https://home-a.example.test',
        showAuthActions: true,
        retentionDisclosure: null as { kind: 'summary'; summary: string } | null,
        retryServerCheck: () => {},
    },
}));
const baseAuthEntryOptions = authEntryOptionsState.current;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
    });
});

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { prompt: modalPromptMock, alert: modalAlertMock, alertAsync: modalAlertAsyncMock },
    }).module;
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: false,
        login: vi.fn(),
        loginWithCredentials: vi.fn(),
    }),
}));

vi.mock('@/components/account/auth/useAuthEntryOptions', () => ({
    useAuthEntryOptions: () => authEntryOptionsState.current,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string, scope?: unknown) => ({
        featureId,
        state: 'disabled',
        blockedBy: 'server',
        blockerCode: 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 0,
        scope: scope ?? { scopeKind: 'runtime' },
    }),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => null,
    clearPendingSetupIntent: () => {},
}));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: runtimeFetchMock }));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));
vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnvRaw: () => '',
    readConfiguredServerUrlEnv: () => '',
}));

vi.mock('@/auth/accountDirectory/accountDirectoryAuthClient', () => ({
    accountDirectoryAuthClient: {
        discoverAuthenticationMethods: (input: unknown) => discoverAuthenticationMethodsMock(input),
        startOAuth: (input: unknown) => startOAuthMock(input),
    },
}));

vi.mock('@/components/onboarding/surfaces/OnboardingWizardSurface', () => ({
    OnboardingWizardSurface: (props: Record<string, unknown>) =>
        React.createElement('OnboardingWizardSurface', props),
    OnboardingWizardSurfacePresentation: (props: Record<string, unknown>) =>
        React.createElement('OnboardingWizardSurfacePresentation', props),
}));

vi.mock('@/components/onboarding/surfaces/useOnboardingWizardController', () => ({
    useOnboardingWizardController: (props: Record<string, unknown>) => {
        wizardControllerMock.lastProps = props;
        return wizardControllerMock.current;
    },
}));

vi.mock('@/components/onboarding/unauthShell', () => ({
    UnauthenticatedSplitShell: (props: Record<string, unknown>) =>
        React.createElement('UnauthenticatedSplitShell', props, props.children as React.ReactNode),
    useApplyBrandHeroSeen: () => vi.fn(),
}));

vi.mock('@/components/updates/UpdatesPopoverButton', () => ({
    UpdatesEntry: (props: Record<string, unknown>) => React.createElement('UpdatesEntry', props),
    UpdatesPopoverButton: (props: Record<string, unknown>) => React.createElement('UpdatesPopoverButton', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function supportedDiscovery() {
    return {
        kind: 'supported_account_service' as const,
        endpointUrl: SELECTED_SERVICE_URL,
        serverIdentityId: SELECTED_SERVICE_IDENTITY,
        canonicalServerUrl: SELECTED_SERVICE_URL,
        capability: { homeDirectory: true, homeEnrollment: true },
        keyLoginAvailable: false,
        oauthProviderIds: ['github'] as const,
        preferredProvisionProviderId: 'github',
        authenticationCatalog: {
            provenance: 'structured' as const,
            methods: [{ id: 'github', enabledActions: [{ id: 'login' as const, mode: 'keyless' as const }] }],
        },
        authenticationActions: [{
            method: { id: 'github', enabledActions: [{ id: 'login' as const, mode: 'keyless' as const }] },
            action: { id: 'login' as const, mode: 'keyless' as const },
            execution: { kind: 'oauth' as const, providerId: 'github', mode: 'keyless' as const },
        }],
        accountServiceDisplayName: 'Happier Cloud',
        snapshot: { status: 'ready' as const, features: {}, serverIdentityId: SELECTED_SERVICE_IDENTITY },
    };
}

function keyOnlyDiscovery() {
    return {
        kind: 'supported_account_service' as const,
        endpointUrl: SELECTED_SERVICE_URL,
        serverIdentityId: SELECTED_SERVICE_IDENTITY,
        canonicalServerUrl: SELECTED_SERVICE_URL,
        capability: {
            version: 1,
            homeDirectory: true,
            homeEnrollment: true,
            homeLoginAssertion: {
                keyId: 'a'.repeat(64),
                publicKeyBase64Url: 'A'.repeat(43),
            },
        },
        keyLoginAvailable: true,
        oauthProviderIds: [] as const,
        preferredProvisionProviderId: null,
        authenticationCatalog: {
            provenance: 'structured' as const,
            methods: [{ id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] }],
        },
        authenticationActions: [{
            method: { id: 'key_challenge', enabledActions: [{ id: 'login' as const, mode: 'keyed' as const }] },
            action: { id: 'login' as const, mode: 'keyed' as const },
            execution: { kind: 'key_entry' as const },
        }],
        accountServiceDisplayName: 'Happier Cloud',
        snapshot: { status: 'ready' as const, features: {}, serverIdentityId: SELECTED_SERVICE_IDENTITY },
    };
}

async function renderEntry() {
    const { PreAuthOnboardingWizardEntry } = await import('./PreAuthOnboardingWizardEntry');
    const screen = await renderScreen(React.createElement(PreAuthOnboardingWizardEntry));
    await act(async () => {
        await Promise.resolve();
    });
    return screen;
}

function capturedAccountServiceEntry() {
    return wizardControllerMock.lastProps?.accountServiceEntry as
        | Readonly<{ status: string; endpoint: { url: string }; discovery: unknown }>
        | undefined;
}

describe('PreAuthOnboardingWizardEntry — Account Service welcome sign-in', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'http://localhost:8081/', onNavigate: locationAssignMock });
        delete process.env.EXPO_PUBLIC_DEBUG;
        await setAccountServiceEndpoint({
            url: SELECTED_SERVICE_URL,
            source: 'default',
        });
        discoverAuthenticationMethodsMock.mockReset();
        discoverAuthenticationMethodsMock.mockResolvedValue(supportedDiscovery());
        startOAuthMock.mockReset();
        startOAuthMock.mockResolvedValue(accountDirectoryStartResult);
        modalPromptMock.mockReset();
        modalPromptMock.mockResolvedValue(null);
        modalAlertMock.mockClear();
        modalAlertAsyncMock.mockClear();
        getActiveServerSnapshotMock.mockClear();
        setPendingExternalAuthMock.mockClear();
        clearPendingExternalAuthMock.mockClear();
        clearPendingAccountDirectoryAuthMock.mockClear();
        locationAssignMock.mockReset();
        runtimeFetchMock.mockReset();
        runtimeFetchMock.mockResolvedValue(new Response(null, { status: 401 }));
        authEntryOptionsState.current = {
            ...baseAuthEntryOptions,
            homeTransport: { homeCarrier },
        };
        wizardControllerMock.lastProps = null;
    });

    afterEach(() => {
        standardCleanup();
        browser?.restore();
        vi.unstubAllGlobals();
    });

    it('discovers the selected sign-in service on its exact endpoint while another Home is focused', async () => {
        await renderEntry();

        expect(discoverAuthenticationMethodsMock).toHaveBeenCalledTimes(1);
        const discoveryInputs = discoverAuthenticationMethodsMock.mock.calls.map(([input]) => input) as Array<
            Readonly<{ endpointUrl: string; expectedServerIdentityId?: string | null }>
        >;
        expect(discoveryInputs).toEqual([
            { endpointUrl: SELECTED_SERVICE_URL, signal: expect.any(AbortSignal) },
        ]);
        expect(discoveryInputs.every((input) => input.endpointUrl !== FOCUSED_HOME_URL)).toBe(true);

        const entry = capturedAccountServiceEntry();
        expect(entry?.status).toBe('ready');
        expect(entry?.endpoint.url).toBe(SELECTED_SERVICE_URL);
        expect(entry?.discovery).toMatchObject({
            serverIdentityId: SELECTED_SERVICE_IDENTITY,
            oauthProviderIds: ['github'],
        });
    });

    it('carries the exact Home carrier when policy selects the Home as its own sign-in service', async () => {
        authEntryOptionsState.current = {
            ...authEntryOptionsState.current,
            requestedHomeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
            homeTarget: { kind: 'saved_profile', profileRef: 'home-a' },
            observedHomeServerIdentityId: 'home-a-identity',
            signInServicePolicy: { v: 1, mode: 'self' },
        };
        discoverAuthenticationMethodsMock.mockResolvedValue({
            ...supportedDiscovery(),
            endpointUrl: FOCUSED_HOME_URL,
            canonicalServerUrl: FOCUSED_HOME_URL,
            serverIdentityId: 'home-a-identity',
        });

        await renderEntry();

        expect(discoverAuthenticationMethodsMock).toHaveBeenCalledWith({
            endpointUrl: FOCUSED_HOME_URL,
            expectedServerIdentityId: 'home-a-identity',
            homeCarrier,
            signal: expect.any(AbortSignal),
        });
    });

    it('starts provider sign-in with the exact observed authority and no-target automatic intent', async () => {
        await renderEntry();
        getActiveServerSnapshotMock.mockClear();

        const start = wizardControllerMock.lastProps
            ?.onContinueWithAccountServiceProvider as (
                request: Record<string, unknown>,
                context: { signal: AbortSignal },
            ) => Promise<void>;
        expect(typeof start).toBe('function');
        const discovery = supportedDiscovery();
        await act(async () => {
            await start({
                method: discovery.authenticationActions[0]!.method,
                action: discovery.authenticationActions[0]!.action,
                execution: discovery.authenticationActions[0]!.execution,
                authority: {
                    purpose: 'account_service',
                    service: {
                        endpointUrl: discovery.endpointUrl,
                        serverIdentityId: discovery.serverIdentityId,
                        canonicalServerUrl: discovery.canonicalServerUrl,
                        capability: discovery.capability,
                        snapshot: discovery.snapshot,
                    },
                },
                intendedHome: null,
            }, { signal: new AbortController().signal });
        });

        expect(startOAuthMock).toHaveBeenCalledTimes(1);
        expect(startOAuthMock.mock.calls[0]?.[0]).toMatchObject({
            endpointUrl: SELECTED_SERVICE_URL,
            endpointServerIdentityId: SELECTED_SERVICE_IDENTITY,
            canonicalServerUrl: SELECTED_SERVICE_URL,
            providerId: 'github',
            entryIntent: { kind: 'enter', target: { kind: 'automatic' } },
            returnTo: '/homes/sign-in',
            accountEntryReturnTo: '/',
        });
        expect(locationAssignMock).toHaveBeenCalledWith(
            `${SELECTED_SERVICE_URL}/v1/auth/external/github/start?pending=abc`,
        );

        // Ordinary Home OAuth custody and the focused-Home snapshot are never consulted.
        expect(setPendingExternalAuthMock).not.toHaveBeenCalled();
        expect(getActiveServerSnapshotMock).not.toHaveBeenCalled();

        // Authentication is bound by its own exact continuation custody. It must not rewrite the
        // device's selected service merely because discovery observed a stable identity.
        const { getAccountServiceEndpointSnapshot } = await import('@/sync/domains/server/serverProfiles');
        expect(getAccountServiceEndpointSnapshot()).toMatchObject({
            url: SELECTED_SERVICE_URL,
        });
        expect(getAccountServiceEndpointSnapshot()).not.toHaveProperty('serverIdentityId');
    });

    it('does not open a late Account Service OAuth URL after the step cancels', async () => {
        let resolveOAuth!: (result: typeof accountDirectoryStartResult) => void;
        startOAuthMock.mockImplementation(() => new Promise<typeof accountDirectoryStartResult>((resolve) => {
            resolveOAuth = resolve;
        }));
        await renderEntry();
        const start = wizardControllerMock.lastProps
            ?.onContinueWithAccountServiceProvider as (
                request: Record<string, unknown>,
                context: { signal: AbortSignal },
            ) => Promise<void>;
        const discovery = supportedDiscovery();
        const controller = new AbortController();
        const launch = start({
            method: discovery.authenticationActions[0]!.method,
            action: discovery.authenticationActions[0]!.action,
            execution: discovery.authenticationActions[0]!.execution,
            authority: {
                purpose: 'account_service',
                service: {
                    endpointUrl: discovery.endpointUrl,
                    serverIdentityId: discovery.serverIdentityId,
                    canonicalServerUrl: discovery.canonicalServerUrl,
                    capability: discovery.capability,
                    snapshot: discovery.snapshot,
                },
            },
            intendedHome: null,
        }, { signal: controller.signal });

        controller.abort();
        resolveOAuth({
            ...accountDirectoryStartResult,
            url: `${SELECTED_SERVICE_URL}/v1/auth/external/github/start?pending=late`,
        });
        await launch;

        expect(locationAssignMock).not.toHaveBeenCalled();
        expect(clearPendingAccountDirectoryAuthMock).toHaveBeenCalledWith({
            endpoint: SELECTED_SERVICE_URL,
            serverIdentityId: SELECTED_SERVICE_IDENTITY,
        }, {
            expected: accountDirectoryPending,
        });
        expect(modalAlertMock).not.toHaveBeenCalled();
    });

    it('reports the selected service unavailable when it is an ordinary Home without Account Directory', async () => {
        discoverAuthenticationMethodsMock.mockResolvedValue({
            kind: 'not_account_service',
            endpointUrl: SELECTED_SERVICE_URL,
            serverIdentityId: SELECTED_SERVICE_IDENTITY,
        });

        await renderEntry();

        const entry = capturedAccountServiceEntry();
        expect(entry?.status).toBe('unsupported');
        expect(entry?.discovery).toBeNull();
        expect(startOAuthMock).not.toHaveBeenCalled();
    });

    it('changes the selected sign-in service only after the entered endpoint proves Account Service support', async () => {
        await renderEntry();
        discoverAuthenticationMethodsMock.mockResolvedValueOnce({
            ...supportedDiscovery(),
            endpointUrl: OTHER_SERVICE_URL,
            canonicalServerUrl: OTHER_SERVICE_URL,
            serverIdentityId: OTHER_SERVICE_IDENTITY,
        });

        const choose = wizardControllerMock.lastProps
            ?.onSelectAccountService as (
                url: string,
                options: Readonly<{ signal: AbortSignal }>,
            ) => Promise<{ kind: string }>;
        expect(typeof choose).toBe('function');
        const controller = new AbortController();
        let result: { kind: string } | undefined;
        await act(async () => {
            result = await choose(OTHER_SERVICE_URL, {
                signal: controller.signal,
            });
        });

        expect(result).toEqual({ kind: 'selected' });
        expect(modalPromptMock).not.toHaveBeenCalled();
        expect(discoverAuthenticationMethodsMock).toHaveBeenCalledWith({
            endpointUrl: OTHER_SERVICE_URL,
            signal: controller.signal,
        });
        const { getAccountServiceEndpointSnapshot } = await import('@/sync/domains/server/serverProfiles');
        expect(getAccountServiceEndpointSnapshot()).toMatchObject({
            url: OTHER_SERVICE_URL,
            serverIdentityId: OTHER_SERVICE_IDENTITY,
            source: 'user',
        });
    });

    it('hands key-only service entry to the full-screen controller with exact automatic intent', async () => {
        discoverAuthenticationMethodsMock.mockReset();
        discoverAuthenticationMethodsMock.mockResolvedValue(keyOnlyDiscovery());
        await renderEntry();

        expect(capturedAccountServiceEntry()).toMatchObject({
            status: 'ready',
            discovery: {
                serverIdentityId: SELECTED_SERVICE_IDENTITY,
                keyLoginAvailable: true,
                oauthProviderIds: [],
            },
        });
        expect(wizardControllerMock.lastProps?.accountContinuationIntent).toEqual({
            kind: 'enter',
            target: { kind: 'automatic' },
        });
        expect(wizardControllerMock.lastProps?.onAccountDirectoryKeyResult).toEqual(expect.any(Function));
        expect(wizardControllerMock.lastProps?.onContinueWithAccountServiceKey).toBeUndefined();
        expect(modalPromptMock).not.toHaveBeenCalled();
    });

});
