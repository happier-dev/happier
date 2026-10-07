import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    adoptHomeProfile,
    listServerProfiles,
    removeServerProfile,
    resolveSelectedAccountServiceEndpoint,
    setAccountServiceEndpoint,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { t } from '@/text';
import { Modal } from '@/modal';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { ENROLLMENT_POLL_IDLE_DELAY_MS } from '@/auth/enrollment/enrollmentPollingBackoff';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (options: { endpointUrl: string }) => (path: string, init?: RequestInit) => boundary.request(options.endpointUrl, path, init),
    serverFetch: (path: string, init?: RequestInit) => boundary.request('ambient', path, init),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// This settings slice does not render streaming markdown; keep the native SDK outside its boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Account Service settings do not render streaming markdown'); },
}));
// No AuthProvider is mounted; an opened Home refreshes auth through this owner.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: async () => {} }),
}));

import { AccountServiceSettingsSection } from './AccountServiceSettingsSection';

/** Non-secret binding to the Account credential a continuation was created under. */
const ACCOUNT_CREDENTIAL_TOKEN_DIGEST = 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM';

describe('Account Service settings continuation composition', () => {
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let restore: () => void;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    beforeEach(async () => {
        restore = installLocalStorageMock().restore;
        fixture = createDirectoryHttpFixture();
        boundary.request.mockImplementation(fixture.request);
        await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId, source: 'user' });
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { token: 'directory-token' });
    });
    afterEach(async () => {
        await screen?.unmount();
        screen = undefined;
        await cancelPendingDirectoryHomeEnrollment();
        await TokenStorage.removeCredentialsForServerUrl(fixture.home.canonicalServerUrl, {
            serverId: fixture.home.homeServerIdentityId,
        });
        for (const profile of listServerProfiles()) {
            await removeServerProfile(profile.id);
        }
        restore();
    });

    it('loads the real Directory without inferring enrollment from persisted sign-in', async () => {
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-home-srv_home_b')).not.toBeNull());
        expect(fixture.state.calls.some(({ path }) => path.includes('login-assertion') || path === '/v1/auth/home-login')).toBe(false);
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
    });

    it('changes the sign-in service in place, saving it only on "Use"', async () => {
        const otherEndpoint = 'https://studio-accounts.test';
        const homeEndpoint = 'https://plain-home.test';
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (requestEndpoint === otherEndpoint) {
                return fixture.request(fixture.service.endpointUrl, path, init).then(async (response) => (
                    path === '/v1/features'
                        ? new Response(JSON.stringify({
                            ...createRootLayoutFeaturesResponse({ capabilities: {
                                serverIdentity: { serverIdentityId: 'srv_studio' }, accountDirectory: fixture.service.capability,
                                server: { canonicalServerUrl: otherEndpoint }, auth: { keyChallenge: { v2: true } },
                            } }),
                            accountServicePresentation: { v: 1, displayName: 'Studio Accounts' },
                        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
                        : response
                ));
            }
            if (requestEndpoint === homeEndpoint && path === '/v1/features') {
                return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_plain_home' } },
                })), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return fixture.request(requestEndpoint, path, init);
        });
        const before = resolveSelectedAccountServiceEndpoint();
        // Section actions render in page presentation, as on the Account page.
        screen = await renderScreen(<ListPresentationProvider value="page"><AccountServiceSettingsSection /></ListPresentationProvider>);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-identity')).not.toBeNull());

        await act(async () => {
            await screen!.findByTestId('settings-account-service-change-service')!.props.onPress();
        });
        expect(screen.findByTestId('settings-account-service-chooser')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-selection')).toBeNull();
        await act(async () => {
            await screen!.findByTestId('settings-account-service-choice-another')!.props.onPress();
        });

        const address = () => screen!.findByTestId('settings-account-service-address')!;
        const check = async () => {
            await act(async () => { await screen!.findByTestId('settings-account-service-check')!.props.onPress(); });
        };
        await act(async () => { address().props.onChangeText('studio example'); });
        await check();
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-chooser-error')).not.toBeNull());

        await act(async () => { address().props.onChangeText(homeEndpoint); });
        await check();
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-chooser-error')).not.toBeNull());
        expect(screen.findByTestId('settings-account-service-use')?.props.disabled).toBe(true);

        await act(async () => { address().props.onChangeText(otherEndpoint); });
        await check();
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-chooser-verified')).not.toBeNull());
        // Checking saves nothing: the selected service changes only on "Use".
        expect(resolveSelectedAccountServiceEndpoint()).toEqual(before);

        await act(async () => {
            await screen!.findByTestId('settings-account-service-use')!.props.onPress();
        });
        await vi.waitFor(() => expect(resolveSelectedAccountServiceEndpoint()).toMatchObject({
            url: otherEndpoint,
            serverIdentityId: 'srv_studio',
            displayName: 'Studio Accounts',
            source: 'user',
        }));
        // The previous service's sign-in stays on this device.
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({
            endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
        })).toEqual({ token: 'directory-token' });
    });

    it('shows who is signed in, from the account service', async () => {
        screen = await renderScreen(<AccountServiceSettingsSection />);
        const identity = () => screen!.findAll((node) => node.props?.testID === 'settings-account-service-identity' && 'title' in node.props)[0];
        await vi.waitFor(() => expect(identity()?.props.title).toBe('Ada Lovelace'));
        expect(identity()?.props.subtitle).toContain('@ada');
    });

    it('keeps showing who is signed in when the service cannot be reached, and says the Homes could not be read', async () => {
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (requestEndpoint === fixture.service.endpointUrl && path === '/v1/features') throw new TypeError('Failed to fetch');
            return fixture.request(requestEndpoint, path, init);
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-directory-unavailable')).not.toBeNull());

        expect(screen.findByTestId('settings-account-service-identity')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-notice')).toBeNull();
        expect(screen.findByTestId('settings-account-service-invitation')).toBeNull();
    });

    it('keeps checking a slow service instead of calling it unreachable', async () => {
        await TokenStorage.accountDirectoryAuthCredentials.logout({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        });
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (requestEndpoint === fixture.service.endpointUrl && path === '/v1/features') {
                await new Promise((resolve) => setTimeout(resolve, 1_500));
            }
            return fixture.request(requestEndpoint, path, init);
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);

        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_100)); });
        expect(screen.findByTestId('settings-account-service-notice')).toBeNull();
        expect(screen.findByTestId('settings-account-service-methods-loading')).not.toBeNull();

        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-method-key_challenge-login-keyed')).not.toBeNull());
        expect(screen.findByTestId('settings-account-service-notice')).toBeNull();
    });

    it('names a service that presents no name after the Home it is, never by its address', async () => {
        await adoptHomeProfile({ descriptor: {
            ...fixture.home.connectionDescriptor,
            homeServerIdentityId: fixture.service.serverIdentityId,
            canonicalServerUrl: fixture.service.endpointUrl,
            endpoints: [{ kind: 'https', url: fixture.service.endpointUrl }],
        }, source: 'account-directory', suggestedName: 'Studio', preserveUserLabel: false });
        // A name saved from the address alone is not a name.
        await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
            displayName: 'directory.test', source: 'user' });

        screen = await renderScreen(<ListPresentationProvider value="page"><AccountServiceSettingsSection /></ListPresentationProvider>);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-identity')).not.toBeNull());

        const text = screen.getTextContent();
        expect(text).toContain('Studio');
        expect(text).not.toContain('directory.test');
    });

    it('titles a signed-in account with no name by how it signed in, marked by the service', async () => {
        fixture.state.me = { ...fixture.state.me, displayName: null, avatar: null, linkedAuthenticationMethods: [] };
        screen = await renderScreen(<AccountServiceSettingsSection />);
        const identity = () => screen!.findAll((node) => node.props?.testID === 'settings-account-service-identity' && 'title' in node.props)[0];
        await vi.waitFor(() => expect(identity()?.props.subtitle).toBeTruthy());

        expect(identity()?.props.title).toBe(t('settingsAccount.accountServiceSignedIn'));
        expect(screen.findAllByType(Avatar)).toHaveLength(0);
    });

    it('says why a Home other devices cannot reach cannot be linked, instead of a Link that does nothing', async () => {
        const unreachableUrl = 'https://home-c.test';
        await upsertServerProfile({ serverUrl: unreachableUrl, name: 'home-c.test' });
        await setServerProfileIdentityForUrl(unreachableUrl, 'srv_home_c');
        await TokenStorage.setCredentialsForServerUrl(unreachableUrl, { serverId: 'srv_home_c' }, { token: fixture.token });

        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-local-home-srv_home_c')).not.toBeNull());

        expect(screen.findByTestId('settings-account-service-local-home-srv_home_c-link')).toBeNull();
        expect(screen.findByTestId('settings-account-service-local-home-srv_home_c-unreachable')).not.toBeNull();
        await TokenStorage.removeCredentialsForServerUrl(unreachableUrl, { serverId: 'srv_home_c' });
    });

    it('speaks of a self-hosted service by its own name, saying Happier Cloud only for that choice', async () => {
        await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
            displayName: 'Acme Accounts', source: 'user' });
        screen = await renderScreen(<ListPresentationProvider value="page"><AccountServiceSettingsSection /></ListPresentationProvider>);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-identity')).not.toBeNull());
        await act(async () => {
            await screen!.findByTestId('settings-account-service-change-service')!.props.onPress();
        });

        const text = screen.getTextContent();
        expect(text).toContain('Acme Accounts');
        // The default service is one choice among others, named once; nothing else implies it.
        expect(text.split('Happier Cloud')).toHaveLength(2);
        expect(text).not.toMatch(/Happier account/);
    });

    it('reminds about a new account-service recovery key under that service, never under the Home', async () => {
        await setAccountServiceEndpoint({ url: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId,
            displayName: 'Acme Accounts', source: 'user' });
        const service = { kind: 'account_service' as const, serverIdentityId: fixture.service.serverIdentityId };
        const home = { serverUrl: fixture.home.canonicalServerUrl, serverId: fixture.home.homeServerIdentityId };
        await TokenStorage.setRecoveryKeyReminderDismissed(true, home);
        await TokenStorage.setRecoveryKeyReminderDismissed(false, service);
        screen = await renderScreen(<AccountServiceSettingsSection />);
        const reminder = () => screen!.findAll((node) => node.props?.testID === 'settings-account-service-recovery-key' && 'title' in node.props)[0];
        await vi.waitFor(() => expect(reminder()).toBeDefined());
        expect(reminder()!.props.title).toContain('Acme Accounts');

        await act(async () => {
            await screen!.findByTestId('settings-account-service-recovery-key-dismiss')!.props.onPress();
        });
        await vi.waitFor(() => expect(reminder()).toBeUndefined());
        await expect(TokenStorage.getRecoveryKeyReminderPending(service)).resolves.toBe(false);
        await expect(TokenStorage.getRecoveryKeyReminderDismissed(home)).resolves.toBe(true);
    });

    it('shows an encrypted service account key only after its password unlocks it, from the account menu', async () => {
        fixture.state.me = { ...fixture.state.me, recoveryKey: 'password_unlock' };
        screen = await renderScreen(<AccountServiceSettingsSection />);
        const viewKey = () => screen!.findAllByType(ItemRowActions)
            .flatMap((node) => node.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>)
            .find((action) => action.id === 'settings-account-service-view-recovery-key');
        await vi.waitFor(() => expect(viewKey()).toBeDefined());

        await act(async () => { viewKey()!.onPress!(); });
        // Masked in place; revealing it asks for the service account's password (never the Home key).
        expect(screen.findByTestId('settings-account-service-recovery-key-row-reveal')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-recovery-key-row-unavailable')).toBeNull();
        vi.mocked(Modal.show).mockClear();
        await screen.pressByTestIdAsync('settings-account-service-recovery-key-row-reveal');
        expect(vi.mocked(Modal.show)).toHaveBeenCalledTimes(1);
    });

    it('says why a key-only service account has no key to unlock here, with no action', async () => {
        fixture.state.me = { ...fixture.state.me, recoveryKey: 'key_only' };
        screen = await renderScreen(<AccountServiceSettingsSection />);
        const viewKey = () => screen!.findAllByType(ItemRowActions)
            .flatMap((node) => node.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>)
            .find((action) => action.id === 'settings-account-service-view-recovery-key');
        await vi.waitFor(() => expect(viewKey()).toBeDefined());

        await act(async () => { viewKey()!.onPress!(); });
        expect(screen.findByTestId('settings-account-service-recovery-key-row-unavailable')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-recovery-key-row-reveal')).toBeNull();
    });

    it('offers no recovery key for a plain service account', async () => {
        fixture.state.me = { ...fixture.state.me, recoveryKey: 'none' };
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-identity')).not.toBeNull());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        const actions = screen.findAllByType(ItemRowActions)
            .flatMap((node) => node.props.actions as ReadonlyArray<{ id: string }>);
        expect(actions.some((action) => action.id === 'settings-account-service-disconnect')).toBe(true);
        expect(actions.some((action) => action.id === 'settings-account-service-view-recovery-key')).toBe(false);
    });

    it('does not tell someone to link a Home when the only Home here cannot be linked', async () => {
        fixture.state.homes = [];
        fixture.state.preferredHomeServerIdentityId = null;
        const unreachableUrl = 'https://home-c.test';
        await upsertServerProfile({ serverUrl: unreachableUrl, name: 'home-c.test' });
        await setServerProfileIdentityForUrl(unreachableUrl, 'srv_home_c');
        await TokenStorage.setCredentialsForServerUrl(unreachableUrl, { serverId: 'srv_home_c' }, { token: fixture.token });

        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-local-home-srv_home_c-unreachable')).not.toBeNull());
        // Once the Homes are read (the refresh control settles), the section is in its empty state.
        await vi.waitFor(() => expect(fixture.state.calls.some(({ path }) => path === '/v1/account-directory/homes')).toBe(true));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
        expect(screen.findByTestId('settings-account-service-directory-unavailable')).toBeNull();

        // The Home's own row says why; an empty state asking to link a Home would contradict it.
        expect(screen.findByTestId('settings-account-service-directory-empty')).toBeNull();
        await TokenStorage.removeCredentialsForServerUrl(unreachableUrl, { serverId: 'srv_home_c' });
    });

    it('keeps the empty state that invites linking when a Home here can be linked', async () => {
        fixture.state.homes = [];
        fixture.state.preferredHomeServerIdentityId = null;
        const homeC = { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_c',
            canonicalServerUrl: 'https://home-c.test', endpoints: [{ kind: 'https' as const, url: 'https://home-c.test' }] };
        const profile = await adoptHomeProfile({ descriptor: homeC, source: 'account-directory' });
        await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: 'srv_home_c' }, { token: fixture.token });

        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-local-home-srv_home_c-link')).not.toBeNull());

        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-directory-empty')).not.toBeNull());
        await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId: 'srv_home_c' });
    });

    it('shows a failed link on the row of the Home it was for, with its next step', async () => {
        const homeC = { ...fixture.home.connectionDescriptor, homeServerIdentityId: 'srv_home_c',
            canonicalServerUrl: 'https://home-c.test', endpoints: [{ kind: 'https' as const, url: 'https://home-c.test' }] };
        const profile = await adoptHomeProfile({ descriptor: homeC, source: 'account-directory' });
        await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { serverId: 'srv_home_c' }, { token: fixture.token });

        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-local-home-srv_home_c-link')).not.toBeNull());
        await act(async () => {
            await screen!.findByTestId('settings-account-service-local-home-srv_home_c-link')!.props.onPress();
        });

        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-material-srv_home_c')).not.toBeNull());
        await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId: 'srv_home_c' });
    });

    it('offers the advertised ways in, the first OAuth sign-in first, and leaves for the provider directly', async () => {
        await TokenStorage.accountDirectoryAuthCredentials.logout({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        });
        const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (path === '/v1/auth/entry') {
                return new Response(JSON.stringify({
                    v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
                    actions: [
                        { kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed', origin: 'home', presentation: { displayName: 'Account key' } },
                        { kind: 'authenticate', methodId: 'github', action: 'login', mode: 'keyless', origin: 'home', presentation: { displayName: 'GitHub' } },
                        { kind: 'authenticate', methodId: 'key_challenge', action: 'provision', mode: 'keyed', origin: 'home', presentation: { displayName: 'Account key' } },
                    ],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (path.startsWith('/v1/auth/external/github/params')) {
                return new Response(JSON.stringify({
                    url: 'https://github.com/login/oauth/authorize?client_id=happier',
                    purpose: 'account_directory', credentialTarget: 'account_directory',
                    endpointUrl: fixture.service.endpointUrl, endpointServerIdentityId: fixture.service.serverIdentityId,
                    canonicalServerUrl: fixture.service.canonicalServerUrl,
                    expiresAt: new Date(Date.now() + 600_000).toISOString(),
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return fixture.request(requestEndpoint, path, init);
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-method-github-login-keyless')).not.toBeNull());

        // The invitation stays; its sign-in band holds the service's own ways in.
        expect(screen.findByTestId('settings-account-service-invitation')).not.toBeNull();
        const button = (testID: string) => screen!.findAll((node) => node.props?.testID === testID && 'display' in node.props)[0];
        expect(button('settings-account-service-method-github-login-keyless')?.props.display).toBe('default');
        expect(button('settings-account-service-method-key_challenge-login-keyed')?.props.display).toBe('secondary');
        expect(screen.findByTestId('settings-account-service-method-key_challenge-provision-keyed')).not.toBeNull();

        await act(async () => {
            await screen!.findByTestId('settings-account-service-method-github-login-keyless')!.props.onPress();
        });
        await vi.waitFor(() => expect(openURL).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=happier'));
        expect(router.push).not.toHaveBeenCalled();
        openURL.mockRestore();
    });

    it('signs in with email and password inline, in place of the strip, and shows the account', async () => {
        await TokenStorage.accountDirectoryAuthCredentials.logout({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        });
        const passwordRequests: Array<{ path: string; body: unknown }> = [];
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (path === '/v1/auth/entry') {
                return json({
                    v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
                    actions: [
                        { kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed', origin: 'home', presentation: { displayName: 'Account key' } },
                        { kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either', origin: 'home', passwordReset: 'email', presentation: { displayName: 'Email and password' } },
                        { kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email and password' } },
                    ],
                });
            }
            if (path.startsWith('/v1/auth/email/') || path.startsWith('/v1/auth/password/')) {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                passwordRequests.push({ path, body });
                if (path === '/v1/auth/email/prelogin') return json({ v: 1, kind: 'plain_password' });
                if (path === '/v1/auth/email/login') {
                    return body?.password === 'correct password with spaces'
                        ? json({ token: 'directory-token' })
                        : json({ error: 'authentication_failed' }, 401);
                }
                return json({ accepted: true });
            }
            return fixture.request(requestEndpoint, path, init);
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-method-email_password-login-either')).not.toBeNull());
        const button = (testID: string) => screen!.findAll((node) => node.props?.testID === testID && 'display' in node.props)[0];
        // No OAuth here: email and password is the primary way in, and creation is by email.
        expect(button('settings-account-service-method-email_password-login-either')?.props.display).toBe('default');
        expect(screen.findByTestId('settings-account-service-method-email_password-provision-keyless')).not.toBeNull();

        await act(async () => {
            await screen!.findByTestId('settings-account-service-method-email_password-login-either')!.props.onPress();
        });
        expect(screen.findByTestId('settings-account-service-methods')).toBeNull();
        expect(screen.findByTestId('account-service-password-forgot')).not.toBeNull();
        await act(async () => {
            screen!.findByTestId('account-service-password-email')!.props.onChangeText('person@example.test');
        });
        const passwordInput = () => screen!.findAll((node) => node.props?.testID === 'account-service-password-password' && typeof node.props.onChangeText === 'function')[0]!;
        await act(async () => { passwordInput().props.onChangeText('wrong password with spaces'); });
        await act(async () => { await passwordInput().props.onSubmitEditing?.(); });
        await vi.waitFor(() => expect(screen?.findAll((node) => node.props?.testID === 'account-service-password-password' && node.props.error)).not.toHaveLength(0));
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId })).toBeNull();

        await act(async () => { passwordInput().props.onChangeText('correct password with spaces'); });
        await act(async () => { await passwordInput().props.onSubmitEditing?.(); });
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-identity')).not.toBeNull());
        expect(passwordRequests.filter(({ path }) => path === '/v1/auth/email/login').at(-1)?.body).toMatchObject({
            email: 'person@example.test', credentialTarget: 'account_directory',
        });
        expect(await TokenStorage.accountDirectoryAuthCredentials.get({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }))
            .toEqual({ token: 'directory-token' });
        expect(router.push).not.toHaveBeenCalled();
    });

    it('creates an account by proving the mailbox first, with a link marked for this service', async () => {
        await TokenStorage.accountDirectoryAuthCredentials.logout({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        });
        const verifyRequests: unknown[] = [];
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (path === '/v1/auth/entry') {
                return json({
                    v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
                    actions: [
                        // No mailed reset here: "Forgot password?" must not be offered.
                        { kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either', origin: 'home', presentation: { displayName: 'Email and password' } },
                        { kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email and password' } },
                    ],
                });
            }
            if (path === '/v1/auth/email/verify/request') {
                verifyRequests.push(JSON.parse(String(init?.body)));
                return json({ accepted: true });
            }
            return fixture.request(requestEndpoint, path, init);
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-method-email_password-provision-keyless')).not.toBeNull());
        await act(async () => {
            await screen!.findByTestId('settings-account-service-method-email_password-login-either')!.props.onPress();
        });
        expect(screen.findByTestId('account-service-password-forgot')).toBeNull();
        await act(async () => { screen!.findByTestId('account-service-password-cancel')!.props.onPress(); });

        await act(async () => {
            await screen!.findByTestId('settings-account-service-method-email_password-provision-keyless')!.props.onPress();
        });
        expect(screen.findByTestId('account-service-password-create')).not.toBeNull();
        await act(async () => {
            screen!.findByTestId('account-service-password-email')!.props.onChangeText('New.Person@Example.test');
        });
        await act(async () => { await screen!.findByTestId('account-service-password-email')!.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(screen?.findByTestId('account-service-password-create-sent')).not.toBeNull());
        expect(verifyRequests).toEqual([{ v: 1, email: 'new.person@example.test', purpose: 'account_service' }]);
    });

    it('routes generic Account Service authentication through the non-focusing refresh intent', async () => {
        await TokenStorage.accountDirectoryAuthCredentials.logout({
            endpoint: fixture.service.endpointUrl,
            serverIdentityId: fixture.service.serverIdentityId,
        });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-method-key_challenge-login-keyed')).not.toBeNull());

        await act(async () => {
            await screen!.findByTestId('settings-account-service-method-key_challenge-login-keyed')!.props.onPress();
        });

        expect(router.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({
            accountServiceIdentity: fixture.service.serverIdentityId,
            accountIntent: JSON.stringify({ kind: 'refresh' }),
        }) }));
    });

    it('automatically resumes a visible exact pending enrollment through the shared scheduler', async () => {
        const { service } = fixture;
        const input = { service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId },
        };
        expect(await completeAccountServicePostAuth(input)).toMatchObject({ kind: 'approval_required' });
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-home-srv_home_b')).not.toBeNull());
        fixture.state.approval = 'approved';
        fixture.state.mode = 'e2ee';
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, ENROLLMENT_POLL_IDLE_DELAY_MS + 100)); });
        await vi.waitFor(() => expect(getPendingDirectoryHomeEnrollment()).toBeNull());
        expect(screen.findByTestId('settings-account-service-material-srv_home_b')).not.toBeNull();
        expect(await TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl, { serverId: fixture.home.homeServerIdentityId })).toEqual({ token: fixture.token });
        expect(fixture.state.calls.filter(({ path }) => path.includes('login-assertion'))).toHaveLength(1);
        expect(fixture.state.calls.some(({ endpoint }) => endpoint === 'ambient')).toBe(false);
    });

    it('stops delegated sign-in on the Home with that Home\'s own credential and no Account Service write', async () => {
        const homeB = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'account-directory' });
        await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: fixture.home.homeServerIdentityId }, { token: fixture.token });
        const linkRequests: Array<{ endpoint: string; path: string; init?: RequestInit }> = [];
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/account/directory-links/')) {
                linkRequests.push({ endpoint, path, init });
                return new Response(JSON.stringify({ v: 1, deleted: true, issuerServerIdentityId: fixture.service.serverIdentityId }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            return fixture.request(endpoint, path, init);
        });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-home-srv_home_b-link')).not.toBeNull());
        // The unlink action lives in the same row menu as remove/set-preferred, which compact rows
        // fold into the overflow popover, so reach it through the row's real action list.
        const homeRowActions = screen.findAllByType(ItemRowActions)
            .map((node) => node.props.actions as ReadonlyArray<{ id: string; destructive?: boolean; onPress?: () => void }>)
            .find((actions) => actions.some((action) => action.id === 'settings-account-service-home-srv_home_b-remove'));
        const unlink = homeRowActions?.find((action) => action.id === 'settings-account-service-home-srv_home_b-unlink');
        expect(unlink).toMatchObject({ destructive: true });
        if (!unlink?.onPress) throw new Error('Expected the unlink action beside remove');

        await act(async () => { unlink.onPress!(); });

        await vi.waitFor(() => expect(linkRequests).toHaveLength(1));
        expect(linkRequests[0]).toMatchObject({
            endpoint: fixture.home.canonicalServerUrl,
            path: `/v1/account/directory-links/${fixture.service.serverIdentityId}`,
        });
        expect(linkRequests[0]?.init?.method).toBe('DELETE');
        expect(fixture.state.calls.filter(({ init }) => init?.method === 'DELETE')).toHaveLength(0);
        expect(Modal.confirm).toHaveBeenCalledOnce();
    });

    it('reauthenticates the retained enrollment intent instead of changing it to automatic entry', async () => {
        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-home-srv_home_b-enroll')).not.toBeNull());
        fixture.state.loginAssertionStatus = 401;
        await act(async () => { await screen!.findByTestId('settings-account-service-home-srv_home_b-enroll')!.props.onPress(); });
        await vi.waitFor(() => expect(screen?.findByTestId('account-service-continuation-failure-action')).not.toBeNull());
        await act(async () => { await screen!.findByTestId('account-service-continuation-failure-action')!.props.onPress(); });
        expect(router.push).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({
            accountServiceIdentity: fixture.service.serverIdentityId,
            accountIntent: JSON.stringify({ kind: 'enroll', homeServerIdentityId: fixture.home.homeServerIdentityId }),
        }) }));
    });

    it('keeps what the service offers in view when it cannot find Homes, with a way to change it and no sign-in', async () => {
        // A released service that predates Home discovery answers /v1/features without the
        // account-directory capability or a canonical URL. Offering "Sign in" there only leads to
        // a generic failure, so the section says what is true and how to move on.
        const legacyEndpoint = 'https://legacy-cloud.test';
        boundary.request.mockImplementation(async (requestEndpoint: string, path: string, init?: RequestInit) => {
            if (requestEndpoint === legacyEndpoint && path === '/v1/features') {
                return new Response(JSON.stringify(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_legacy' } },
                })), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return fixture.request(requestEndpoint, path, init);
        });
        await setAccountServiceEndpoint({ url: legacyEndpoint, source: 'user' });

        screen = await renderScreen(<AccountServiceSettingsSection />);
        await vi.waitFor(() => expect(screen?.findByTestId('settings-account-service-notice')).not.toBeNull());

        expect(screen.findByTestId('settings-account-service-invitation')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-benefits')).not.toBeNull();
        // The failure and its recovery action share a narrow phone row. Its title must
        // grow with the text rather than hide the reason the service cannot be used.
        const notice = screen.findAll((node) => node.props.testID === 'settings-account-service-notice'
            && typeof node.props.title === 'string')[0]!;
        const paintedTitle = screen.findAll((node) => node.props.children === notice.props.title
            && typeof node.props.numberOfLines === 'number');
        expect(paintedTitle.length).toBeGreaterThan(0);
        expect(paintedTitle.every((node) => node.props.numberOfLines <= 0)).toBe(true);
        expect(screen.findAllByProps({ testID: 'settings-account-service-methods' })).toHaveLength(0);
        expect(screen.findAllByType(ItemRowActions)).toHaveLength(0);
        // One way to change the service: the notice carries it, so the section header does not.
        expect(screen.findByTestId('settings-account-service-change-service')).toBeNull();
        expect(Modal.alertAsync).not.toHaveBeenCalled();

        await act(async () => {
            await screen!.findByTestId('settings-account-service-notice-change')!.props.onPress();
        });
        expect(screen.findByTestId('settings-account-service-chooser')).not.toBeNull();
        expect(screen.findByTestId('settings-account-service-selection')).toBeNull();
    });
});
