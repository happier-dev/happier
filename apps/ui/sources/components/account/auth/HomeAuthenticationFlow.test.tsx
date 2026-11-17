import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

import { projectAuthEntryMethodCapabilities } from '@/auth/capabilities/authMethodCapabilities';
import { AuthEntryProjectionV1Schema, type AuthEntryActionV1 } from '@happier-dev/protocol/auth/entry';


const nativeStorage = new Map<string, string>();
const boundary = vi.hoisted(() => ({ request: vi.fn(), openURL: vi.fn(async () => {}), platformOS: 'web' as 'web' | 'ios' }));

installTokenStorageWebPlatformMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platformOS; } }, Linking: { openURL: boundary.openURL } });
}, secureStore: async () => ({
    getItemAsync: async (key: string) => nativeStorage.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { nativeStorage.set(key, value); },
    deleteItemAsync: async (key: string) => { nativeStorage.delete(key); },
}) });
installTokenStorageTestIsolation('home-authentication-flow');

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { renderScreen } = await import('@/dev/testkit');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { HomeAuthenticationFlow } = await import('./HomeAuthenticationFlow');

function actionFromEntry(action: Extract<AuthEntryActionV1, { kind: 'authenticate' }>) {
    return projectAuthEntryMethodCapabilities(AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'ready', scope: { kind: 'home' }, actions: [action], autoRedirect: null,
    })).authenticationActions[0]!;
}
const keyAction = actionFromEntry({ kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed', origin: 'home', presentation: { displayName: 'Secret key' } });
const oauthAction = actionFromEntry({ kind: 'authenticate', methodId: 'team-oidc', action: 'connect', mode: 'either', origin: 'home',
    presentation: { displayName: 'Acme SSO' } });
const mtlsAction = actionFromEntry({ kind: 'authenticate', methodId: 'mtls', action: 'login', mode: 'keyless', origin: 'home',
    presentation: { displayName: 'Certificate' } });

describe('HomeAuthenticationFlow', () => {
    let restoreStorage: () => void;
    let restoreLocks: () => void;
    beforeEach(() => {
        boundary.platformOS = 'web';
        nativeStorage.clear();
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
        boundary.request.mockReset();
        setRuntimeFetch(boundary.request);
        boundary.request.mockImplementation(async () => Response.json({ error: 'signup-disabled' }, { status: 403 }));
        boundary.openURL.mockClear();
    });
    afterEach(() => { vi.restoreAllMocks(); restoreLocks(); restoreStorage(); });
    it('returns from exact key entry to the admitted method chooser', async () => {
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[keyAction]}
                returnTo="/setup/wizard"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await screen.pressByTestIdAsync('home-auth-key_challenge-login-keyed');
        expect(screen.findByTestId('home-auth-key-back')).toBeTruthy();

        await screen.pressByTestIdAsync('home-auth-key-back');
        expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).toBeTruthy();
    });

    it('opens a chosen key form directly, leaving the step\'s own back as the only way out', async () => {
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[keyAction]}
                openChosenAction
                returnTo="/setup/wizard"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        expect(screen.findByTestId('restore-manual-secret-input')).not.toBeNull();
        expect(screen.findByTestId('home-auth-key_challenge-login-keyed')).toBeNull();
        expect(screen.findByTestId('home-auth-key-back')).toBeNull();
    });

    it('runs a chosen one-tap action on arrival, so the person\'s one tap is the only tap', async () => {
        const generatedKeyAction = actionFromEntry({ kind: 'authenticate', methodId: 'key_challenge',
            action: 'provision', mode: 'keyed', origin: 'home', presentation: { displayName: 'Secret key' } });
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[generatedKeyAction]}
                openChosenAction
                returnTo="/teams/team-1/sign-in?serverId=srv_home"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await vi.waitFor(() => expect(boundary.request).toHaveBeenCalled());
        expect(boundary.request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/features']);
        expect(screen.findByTestId('home-auth-key_challenge-provision-keyed')).toBeTruthy();
        // No Back card beside the step's own back, and the card stays as the retry if the run did not finish.
        expect(screen.findByTestId('home-auth-back')).toBeNull();
        expect(screen.findByTestId('home-auth-key_challenge-provision-keyed')).toBeTruthy();
    });

    it('does not run any action on arrival when the caller did not choose one', async () => {
        await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[oauthAction]}
                returnTo="/teams/team-1/sign-in?serverId=srv_home"
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        expect(boundary.request).not.toHaveBeenCalled();
        expect(boundary.openURL).not.toHaveBeenCalled();
    });

    it('runs native Team mTLS through the shared executor and persists its admission continuation', async () => {
        boundary.platformOS = 'ios';
        boundary.request.mockImplementation(async () => Response.json({
            startUrl: '/v1/auth/mtls/start?request=exact-team', admissionReference: 'r'.repeat(43),
        }));
        const screen = await renderScreen(<AuthProvider initialCredentials={null}>
            <HomeAuthenticationFlow
                target={{
                    kind: 'descriptor',
                    authority: 'account_directory',
                    descriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_home',
                        canonicalServerUrl: 'https://home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
                    },
                }}
                actions={[mtlsAction]}
                returnTo="/teams/team-1/sign-in?target=srv_home"
                teamAdmission={{ teamId: 'team-1' }}
                onAuthenticated={vi.fn()}
                onBack={vi.fn()}
            />
        </AuthProvider>);

        await screen.pressByTestIdAsync('home-auth-mtls-login-keyless');

        expect(boundary.request.mock.calls.map(([url, init]) => ({
            url: String(url), body: JSON.parse(String(init.body)),
        }))).toEqual([{
            url: 'https://home.example.test/v1/auth/mtls/start',
            body: { returnTo: expect.stringMatching(/:\/\/\/mtls$/), teamId: 'team-1' },
        }]);
        expect(boundary.openURL).toHaveBeenCalledWith('https://home.example.test/v1/auth/mtls/start?request=exact-team');
        expect(await TokenStorage.readPendingExternalAuthStateForServerUrl('https://home.example.test', { serverId: 'srv_home' }))
            .toMatchObject({ serverMismatch: false, value: { teamContinuation: { teamId: 'team-1', admissionReference: 'r'.repeat(43) } } });
    });
});
