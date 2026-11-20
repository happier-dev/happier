import { projectAuthEntryMethodCapabilities } from '@/auth/capabilities/authMethodCapabilities';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { AccountServiceAuthenticationFlowProps } from './AccountServiceAuthenticationFlow';

const network = vi.hoisted(() => ({ request: vi.fn() }));
const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => {}) }));
const host = vi.hoisted(() => ({ os: 'web', sameTab: vi.fn(), stored: new Map<string, string>() }));
const desktop = vi.hoisted(() => ({ invoke: vi.fn(), receive: null as ((urls: string[]) => void) | null }));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    listenDesktopHostEvent: async (_event: string, receive: (urls: string[]) => void) => {
        desktop.receive = receive;
        return () => { desktop.receive = null; };
    },
}));

installTokenStorageWebPlatformMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Linking: linking, Platform: { get OS() { return host.os; } } });
}, secureStore: () => ({
    getItemAsync: async (key: string) => host.stored.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { host.stored.set(key, value); },
    deleteItemAsync: async (key: string) => { host.stored.delete(key); },
}) });
installTokenStorageTestIsolation('account-service-auth-flow');

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { installDesktopDeepLinks } = await import('@/desktop/deepLinks/installDesktopDeepLinks');
const { AccountServiceAuthenticationFlow } = await import('./AccountServiceAuthenticationFlow');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

const capability = {
    version: 1 as const,
    homeDirectory: true,
    homeEnrollment: true,
    homeLoginAssertion: { keyId: 'a'.repeat(64), publicKeyBase64Url: 'A'.repeat(43) },
};
const service = {
    authority: {
        endpointUrl: 'https://accounts.example.test', serverIdentityId: 'srv_accounts',
        canonicalServerUrl: 'https://accounts.example.test', capability,
        snapshot: { status: 'ready' as const, features: createRootLayoutFeaturesResponse(), serverIdentityId: 'srv_accounts' },
    },
    displayName: 'Acme',
    authenticationActions: projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
        actions: [
            { kind: 'authenticate', methodId: 'github', action: 'provision', mode: 'either', origin: 'home', presentation: { displayName: 'GitHub' } },
            { kind: 'authenticate', methodId: 'github', action: 'login', mode: 'keyless', origin: 'home', presentation: { displayName: 'GitHub' } },
            { kind: 'authenticate', methodId: 'key_challenge', action: 'provision', mode: 'keyed', origin: 'home', presentation: { displayName: 'Secret key' } },
            { kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed', origin: 'home', presentation: { displayName: 'Secret key' } },
        ],
    })).authenticationActions,
    transport: { runtimeOrigin: 'http://127.0.0.1:43123' },
} satisfies AccountServiceAuthenticationFlowProps['service'];
const intent = { kind: 'enter', target: { kind: 'automatic' } } as const;
const target = { endpoint: service.authority.endpointUrl, serverIdentityId: service.authority.serverIdentityId };
function startResponse() {
    return Response.json(ExternalOAuthParamsResponseSchema.parse({
        url: 'https://oauth.example.test/start', purpose: 'account_directory', credentialTarget: 'account_directory',
        endpointUrl: service.authority.endpointUrl, endpointServerIdentityId: service.authority.serverIdentityId,
        canonicalServerUrl: service.authority.canonicalServerUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
}

describe('AccountServiceAuthenticationFlow', () => {
    let restoreStorage: () => void;
    let restoreLocks: () => void;
    beforeEach(() => {
        host.os = 'web';
        host.stored.clear();
        host.sameTab.mockClear();
        vi.stubGlobal('window', { location: { assign: linking.openURL } });
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        network.request.mockReset();
        setRuntimeFetch(network.request);
        network.request.mockImplementation(async () => startResponse());
        linking.openURL.mockClear();
    });
    afterEach(() => { vi.unstubAllGlobals(); restoreLocks(); restoreStorage(); });

    it('preserves exact catalog method/action order and dispatches the tuple mode', async () => {
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent} onPostAuthContinuation={() => {}}
            returnTo="/setup/wizard" onResult={vi.fn()} onExternalAuthStarted={vi.fn()} onBack={vi.fn()} />);
        expect([
            screen.findByTestId('account-service-auth-github-provision-either')?.props.testID,
            screen.findByTestId('account-service-auth-github-login-keyless')?.props.testID,
            screen.findByTestId('account-service-auth-key_challenge-provision-keyed')?.props.testID,
            screen.findByTestId('account-service-auth-key_challenge-login-keyed')?.props.testID,
        ]).toEqual([
            'account-service-auth-github-provision-either',
            'account-service-auth-github-login-keyless',
            'account-service-auth-key_challenge-provision-keyed',
            'account-service-auth-key_challenge-login-keyed',
        ]);
        await screen.pressByTestIdAsync('account-service-auth-github-provision-either');
        expect(screen.findByTestId('oauth-browser-wait-title')).toBeNull();
        const [url] = network.request.mock.calls[0]!;
        expect(new URL(String(url)).origin).toBe(service.transport.runtimeOrigin);
        expect(new URL(String(url)).searchParams.get('mode')).toBe('keyed');
        expect(new URL(String(url)).pathname).toBe('/v1/auth/external/github/params');
        await waitForHomeGovernance(async () => {
            expect(linking.openURL, screen.getTextContent()).toHaveBeenCalledWith('https://oauth.example.test/start');
            expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toMatchObject({
                mode: 'keyed', entryIntent: intent, returnTo: '/setup/wizard',
            });
        });
    });

    it('starts generated-key provisioning without opening the key-entry form', async () => {
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent} onPostAuthContinuation={() => {}}
            returnTo="/setup/wizard" onResult={vi.fn()} onExternalAuthStarted={vi.fn()} onBack={vi.fn()} />);

        await screen.pressByTestIdAsync('account-service-auth-key_challenge-provision-keyed');

        expect(screen.findByTestId('restore-manual-secret-input')).toBeNull();
        expect(screen.findByTestId('account-directory-key-provision-pending') ?? screen.findByTestId('account-directory-key-provision-failed')).not.toBeNull();
    });

    it.each(['ios', 'android'])('opens the GitHub wait on %s and goes Back to the methods', async (os) => {
        host.os = os;
        vi.stubGlobal('window', { location: { assign: host.sameTab } });
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent}
            onPostAuthContinuation={() => {}} returnTo="/setup/wizard" onResult={vi.fn()}
            onExternalAuthStarted={vi.fn()} onBack={vi.fn()} />);

        await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');

        expect(linking.openURL).toHaveBeenCalledExactlyOnceWith('https://oauth.example.test/start');
        expect(host.sameTab).not.toHaveBeenCalled();
        expect(screen.findByTestId('oauth-browser-wait-title')).toBeTruthy();
        expect(screen.findByTestId('account-service-auth-github-login-keyless')).toBeNull();
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toMatchObject({ returnTo: '/setup/wizard' });

        await screen.pressByTestIdAsync('oauth-browser-wait-back');
        expect(screen.findByTestId('account-service-auth-github-login-keyless')).toBeTruthy();
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
    });

    it('routes the desktop GitHub return only to the initiating wait and cancels it on Back', async () => {
        desktop.invoke.mockReset().mockResolvedValue(null);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: desktop.invoke });
        vi.stubGlobal('window', { location: { assign: host.sameTab } });
        const nextAttempt = vi.fn().mockReturnValueOnce('desktop-attempt-one').mockReturnValueOnce('desktop-attempt-two');
        network.request.mockImplementation(async () => Response.json({
            ...await startResponse().json(), desktopAttemptId: nextAttempt(),
        }));
        const navigate = vi.fn();
        const stop = installDesktopDeepLinks(navigate);
        try {
            const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent}
                onPostAuthContinuation={() => {}} returnTo="/setup/wizard" onResult={vi.fn()}
                onExternalAuthStarted={vi.fn()} onBack={vi.fn()} />);

            await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');
            expect(desktop.invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'https://oauth.example.test/start' });
            expect(host.sameTab).not.toHaveBeenCalled();
            expect(screen.findByTestId('oauth-browser-wait-title')).toBeTruthy();
            expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toMatchObject({ desktopAttemptId: 'desktop-attempt-one' });

            await screen.pressByTestIdAsync('oauth-browser-wait-back');
            expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
            await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');

            const returnQuery = new URLSearchParams({
                flow: 'auth', purpose: 'account_directory', endpointUrl: target.endpoint,
                endpointServerIdentityId: target.serverIdentityId, pending: 'oauth-child-pending',
            });
            const returnLink = (id: string) => `happier://oauth/github?${returnQuery}&desktopAttemptId=${id}`;
            await act(async () => {
                desktop.receive?.([returnLink('desktop-attempt-one')]);
                await new Promise(resolve => setTimeout(resolve, 0));
            });
            expect(navigate).not.toHaveBeenCalled();
            expect(screen.findByTestId('oauth-browser-wait-title')).toBeTruthy();
            desktop.receive?.([returnLink('desktop-attempt-two')]);
            await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(
                `/oauth/github?${returnQuery}&desktopAttemptId=desktop-attempt-two`,
            ));
        } finally {
            stop();
        }
    });

    it('shows a neutral launch error when the service starts OAuth but the browser handoff rejects', async () => {
        vi.stubGlobal('window', { location: null });
        linking.openURL.mockRejectedValueOnce(new Error('OS rejected URL handoff'));
        const onExternalAuthStarted = vi.fn();
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent}
            onPostAuthContinuation={() => {}} returnTo="/setup/wizard" onResult={vi.fn()}
            onExternalAuthStarted={onExternalAuthStarted} onBack={vi.fn()} />);

        await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');

        expect(linking.openURL).toHaveBeenCalledWith('https://oauth.example.test/start');
        expect(onExternalAuthStarted).not.toHaveBeenCalled();
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
        expect(screen.findByType(SurfaceStateCard).props.title).toBe('common.error');
        expect(screen.getTextContent()).toContain('errors.operationFailed');
        expect(screen.getTextContent()).not.toContain('welcome.serverUnavailableTitle');
        expect(screen.getTextContent()).not.toContain('welcome.signInServiceUnavailableTitle');
    });

    it('admits one sibling ceremony and releases the guard after a failed launch', async () => {
        const response = createDeferred<Response>();
        network.request.mockReturnValue(response.promise);
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent} onPostAuthContinuation={() => {}}
            returnTo="/setup/wizard" onResult={vi.fn()} onExternalAuthStarted={vi.fn()} onBack={vi.fn()} />);
        const first = screen.findByTestId('account-service-auth-github-provision-either');
        const sibling = screen.findByTestId('account-service-auth-github-login-keyless');
        if (!first || !sibling) throw new Error('Expected both Account Service actions');
        const pressFirst = first.props.onPress;
        const pressSibling = sibling.props.onPress;
        act(() => { pressFirst(); pressSibling(); });
        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));
        await act(async () => response.resolve(Response.json({ error: 'authentication_failed' }, { status: 400 })));
        network.request.mockImplementation(async () => startResponse());
        await screen.pressByTestIdAsync('account-service-auth-launch-failed-action');
        await screen.pressByTestIdAsync('account-service-auth-github-login-keyless');
        expect(network.request).toHaveBeenCalledTimes(2);
    });

    it('does not open a returned OAuth URL after the invoking surface becomes stale', async () => {
        const response = createDeferred<Response>();
        let current = true;
        network.request.mockReturnValue(response.promise);
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent} onPostAuthContinuation={() => {}}
            returnTo="/setup/wizard" onResult={vi.fn()} onExternalAuthStarted={vi.fn()} onBack={vi.fn()}
            isCurrent={() => current} />);

        const launch = screen.pressByTestIdAsync('account-service-auth-github-login-keyless');
        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));
        current = false;
        response.resolve(startResponse());
        await launch;

        expect(linking.openURL).not.toHaveBeenCalled();
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
    });

    it('forwards cancellation and does not open a late OAuth URL after the journey aborts', async () => {
        const response = createDeferred<Response>();
        network.request.mockReturnValue(response.promise);
        const controller = new AbortController();
        const screen = await renderScreen(<AccountServiceAuthenticationFlow service={service} intent={intent} onPostAuthContinuation={() => {}}
            returnTo="/setup/wizard" onResult={vi.fn()} onExternalAuthStarted={vi.fn()} onBack={vi.fn()}
            signal={controller.signal} />);

        const launch = screen.pressByTestIdAsync('account-service-auth-github-login-keyless');
        await vi.waitFor(() => expect(network.request).toHaveBeenCalledTimes(1));
        const signal = network.request.mock.calls[0]?.[1]?.signal as AbortSignal;
        expect(signal.aborted).toBe(false);
        controller.abort();
        expect(signal.aborted).toBe(true);
        response.resolve(startResponse());
        await launch;

        expect(linking.openURL).not.toHaveBeenCalled();
        expect(await TokenStorage.getPendingAccountDirectoryAuth(target)).toBeNull();
        expect(screen.findAllByTestId('account-service-auth-launch-failed')).toHaveLength(0);
    });
});
