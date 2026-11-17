import * as React from 'react';
import { act } from 'react-test-renderer';
import { MMKV } from 'react-native-mmkv';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import {
    installWebLockManagerMock,
} from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    createAccountTokenForTests,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { resolveServerProfileScopeIdForIdentifier, setActiveServerId, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { TeamInvitationAcceptResultV1Schema, TeamInvitationPreviewResultV1Schema, createTeamInvitationTargetBindingV1 } from '@happier-dev/protocol/teams';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

installTokenStorageWebPlatformMocks();
// Vitest unwinds afterEach hooks in reverse order, so retain this scope through cleanup.
// The real connection singleton retains its generation across cases.
installTokenStorageTestIsolation('team-join-authentication', { preserveGenerations: true });
const browserStorage = await vi.hoisted(async () => {
    const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    return { ...installLocalStorageMock(), backend: globalThis.localStorage };
});

function answerSavedAccountInvitation(serverId: string, identity: string, accountId: string) {
    home.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: accountId }) });
    home.answer(serverId, '/v1/team-invitations/preview', { body: TeamInvitationPreviewResultV1Schema.parse({
        outcome: 'ok', preview: {
            home: { serverId: identity, displayName: 'Acme', storageMode: null },
            team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
            role: 'member', historyAccess: 'from_membership', state: 'active',
            expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
        },
    }) });
    home.answer(serverId, '/v1/auth/entry', { body: AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'admission_required', scope: { kind: 'invitation' },
        home: { serverId: identity, displayName: 'Acme', storageMode: null },
        team: { teamId: 'team-1', name: 'Acme Team', logo: null },
        account: { firstName: null, lastName: null, username: null, avatarUrl: null },
        invitationEmailVerificationRequired: false, actions: [], autoRedirect: null,
    }) });
    home.answer(serverId, '/v1/team-invitations/accept', { body: TeamInvitationAcceptResultV1Schema.parse({ outcome: 'joined', teamId: 'team-1' }) });
}

it.each(['none', 'retry', 'new_invitation'] as const)('reaches the admitted profile before offering a name after an off-Home saved Account joins (focus recovery: %s)', async recovery => {
    const identity = 'srv_saved_account_join';
    const origin = 'https://saved-account-join.test';
    const credentials = { token: createAccountTokenForTests('admitted-account', { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Acme', serverUrl: origin,
        serverIdentityId: identity, accountId: 'admitted-account', credentials, teamsEnabled: true });
    const otherCredentials = { token: createAccountTokenForTests('other-account', { currentAccount: true }) };
    const otherIdentity = 'srv_other_account_join';
    const otherServerId = await home.addHome({ name: 'Other Home', serverUrl: 'https://other-home.test',
        serverIdentityId: otherIdentity, accountId: 'other-account', credentials: otherCredentials, teamsEnabled: true });
    await switchConnectionToActiveServer();
    answerSavedAccountInvitation(serverId, identity, 'admitted-account');
    // The saved target uses a device-local profile reference; authenticated
    // Account scope uses the Home's stable identity, as the real join host does.
    const renderEntry = (targetServerId: string, accountId: string, token: string) => <AuthProvider initialCredentials={otherCredentials}>
        <TeamAuthEntrySurface target={{ kind: 'saved_profile', profileRef: targetServerId }}
            invitation={{ token, accountScope: { serverId: resolveServerProfileScopeIdForIdentifier(targetServerId), accountId } }}
            onSelectAction={() => { throw new Error('The saved Account must join without authentication'); }}
            onAdmissionComplete={() => {}} />
    </AuthProvider>;
    const screen = await renderScreen(renderEntry(serverId, 'admitted-account', 'a'.repeat(43)));
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-join'), screen.getTextContent()).not.toBeNull());
    expect(home.requestsFor('/v1/auth/entry').map(request => ({
        serverId: request.serverId,
        authenticatedAsAdmittedAccount: request.token === credentials.token,
    }))).toEqual([{ serverId, authenticatedAsAdmittedAccount: true }]);
    const identityHeading = screen.findByTestId('team-auth-entry-heading');
    const writeStorage = MMKV.prototype.set;
    // Profile selection uses the native SDK boundary in this Node renderer,
    // independently of the credential store's explicit web platform fixture.
    const focusStorage = recovery !== 'none' ? vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
        const state: unknown = key === 'server-state-v1' && typeof value === 'string' ? JSON.parse(value) : null;
        if (state && typeof state === 'object' && 'activeServerId' in state && state.activeServerId === serverId) {
            throw new Error('Device storage is temporarily unavailable');
        }
        writeStorage.call(this, key, value);
    }) : null;
    try {
        await screen.pressByTestIdAsync('team-auth-entry-join');
        if (recovery !== 'none') {
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-destination-home-retry'), screen.getTextContent()).not.toBeNull());
            expect(screen.findByTestId('team-auth-entry-heading')).toBe(identityHeading);
            expect(screen.findByTestId('team-auth-entry-admission-complete-name-field')).toBeNull();
            expect(home.requestsFor('/v1/team-invitations/accept')).toHaveLength(1);
            focusStorage?.mockRestore();
            if (recovery === 'new_invitation') {
                answerSavedAccountInvitation(otherServerId, otherIdentity, 'other-account');
                await screen.update(renderEntry(otherServerId, 'other-account', 'b'.repeat(43)));
                await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-join'), screen.getTextContent()).not.toBeNull());
                await screen.pressByTestIdAsync('team-auth-entry-join');
                await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-complete-action'), screen.getTextContent()).not.toBeNull());
                expect(home.requestsFor('/v1/team-invitations/accept')).toHaveLength(2);
                expect(home.requestsFor('/v1/team-invitations/accept').map(request => ({
                    serverId: request.serverId,
                    authenticatedAsExpectedAccount: request.token === (request.serverId === serverId ? credentials.token : otherCredentials.token),
                }))).toEqual([
                    { serverId, authenticatedAsExpectedAccount: true },
                    { serverId: otherServerId, authenticatedAsExpectedAccount: true },
                ]);
                expect(screen.findByTestId('team-auth-entry-destination-home-retry')).toBeNull();
                expect(screen.findByTestId('team-auth-entry-admission-complete-name-field'), screen.getTextContent()).not.toBeNull();
                return;
            }
            await screen.pressByTestIdAsync('team-auth-entry-destination-home-retry');
        }
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-complete-action'), screen.getTextContent()).not.toBeNull());
        expect(screen.findByTestId('team-auth-entry-admission-complete-name-field'), screen.getTextContent()).not.toBeNull();
        expect(screen.findByTestId('team-auth-entry-heading')).toBe(identityHeading);
        expect(home.requestsFor('/v1/team-invitations/accept')).toEqual([
            expect.objectContaining({ serverId, token: credentials.token }),
        ]);
        expect(home.requestsFor('/v1/account/profile')).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverId, token: credentials.token }),
        ]));
    } finally {
        focusStorage?.mockRestore();
    }
});
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: {} as Record<string, string> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: navigation.push, replace: navigation.replace },
    params: () => navigation.params,
}).module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
setRuntimeFetch(home.request);
// Match the app entry so credential adoption publishes the real Account scope
// instead of stopping at an unloaded Sync singleton in this composed journey.
await import('@/sync/syncEngine');
const { disconnectActiveServerConnection, switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TeamJoinScreen } = await import('./TeamJoinScreen');
const { TeamAuthEntrySurface } = await import('../entry/TeamAuthEntrySurface');
const { default: TeamSignInRoute } = await import('@/app/(app)/teams/[teamId]/sign-in');
const { openAddHome } = await import('@/components/homes/add/openAddHome');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');

it('opens the Home draft through the retained workspace instead of losing its leaf to Settings overview', async () => {
    const credentials = { token: createAccountTokenForTests('home-add-account', { currentAccount: true }) };
    await home.addHome({ name: 'Current Home', serverUrl: 'https://home-add.test', accountId: 'home-add-account', credentials });
    navigation.params = { teamId: 'team-add-home', serverId: 'srv_home_not_saved' };
    let state = createWorkspaceState({ id: 'settings-tab', target: { kind: 'settings', params: {} }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: false, workflows: false, friends: false }, pages: [] });
    const committed: string[] = [];
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); },
        transport: { commit: href => { committed.push(href); } }, createId: () => 'home-draft-tab', onChange: () => {},
    });
    const workspace: WorkspaceNavigationContextValue = {
        active: true, state, catalog, canGoBack: false, canGoForward: false,
        openHref: adapter.openHref.bind(adapter), activateTab: adapter.activateTab.bind(adapter),
        closeTab: adapter.closeTab.bind(adapter), closeTabs: adapter.closeTabs.bind(adapter), dispatch: adapter.dispatch.bind(adapter),
        navigationForTab: () => { throw new Error('Unexpected hosted-tab navigation'); },
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    const screen = await renderScreen(<WorkspaceNavigationProvider value={workspace}>
        <AuthProvider initialCredentials={credentials}><TeamSignInRoute /></AuthProvider>
    </WorkspaceNavigationProvider>);
    await screen.pressByTestIdAsync('team-sign-in-add-home-action');
    expect(state.tabs[state.groups[state.focusedGroupId]!.activeTabId]?.target).toMatchObject({ kind: 'settings', params: { pageId: 'server/add' } });
    expect(committed.at(-1)).toBe('/settings/server/add');
});

it.each([
    { signedIn: false, expected: '/?step=home' },
    { signedIn: true, expected: '/settings/server/add' },
])('opens Add a Home from both Team entries in the correct shell (signedIn: $signedIn)', async ({ signedIn, expected }) => {
    const credentials = signedIn ? { token: createAccountTokenForTests('home-add-account', { currentAccount: true }) } : null;
    if (credentials) await home.addHome({ name: 'Current Home', serverUrl: 'https://home-add.test', accountId: 'home-add-account', credentials });
    navigation.params = { teamId: 'team-add-home', serverId: 'srv_home_not_saved' };
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}><TeamSignInRoute /></AuthProvider>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-sign-in-add-home')).not.toBeNull());
    // Both Team entries present the missing Home as the same step: a heading and Add Home as its action.
    expect(screen.findByTestId('team-sign-in-add-home-title')).not.toBeNull();
    await screen.pressByTestIdAsync('team-sign-in-add-home-action');
    expect(navigation.push).toHaveBeenLastCalledWith(expected);

    const token = 'a'.repeat(43);
    const homeTarget = 'srv_home_not_saved';
    await screen.update(<AuthProvider initialCredentials={credentials}><TeamJoinScreen token={token} homeTarget={homeTarget}
        targetBinding={createTeamInvitationTargetBindingV1({ token, homeTarget })} /></AuthProvider>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-join-add-home')).not.toBeNull());
    expect(screen.findByTestId('team-join-unknown-home-title')).not.toBeNull();
    await screen.pressByTestIdAsync('team-join-add-home');
    expect(navigation.push).toHaveBeenLastCalledWith(expected);

    openAddHome(navigation, { replace: true, address: 'https://next-home.test', auto: true, source: 'notification', path: 'direct' });
    expect(navigation.replace).toHaveBeenLastCalledWith(signedIn
        ? '/settings/server/add?address=https%3A%2F%2Fnext-home.test&auto=1&source=notification&path=direct'
        : '/?step=home&server=https%3A%2F%2Fnext-home.test');
    const inWelcome = vi.fn();
    openAddHome(navigation, { onWelcomeHomeStep: inWelcome });
    if (signedIn) {
        expect(inWelcome).not.toHaveBeenCalled();
        expect(navigation.push).toHaveBeenLastCalledWith(expected);
    } else expect(inWelcome).toHaveBeenCalledOnce();
});

let restoreLocks: () => void;
let stopCredentialObservation: (() => void) | undefined;
beforeEach(() => {
    navigation.params = {};
    navigation.push.mockClear();
    navigation.replace.mockClear();
    installHomeGovernanceBoundaries(home);
    vi.stubGlobal('localStorage', browserStorage.backend);
    browserStorage.store.clear();
    restoreLocks = installWebLockManagerMock().restore;
});
afterEach(async () => {
    stopCredentialObservation?.();
    stopCredentialObservation = undefined;
    await standardCleanup();
    await disconnectActiveServerConnection();
    await home.reset();
    restoreLocks();
});
afterAll(() => browserStorage.restore());

it.each([
    { method: 'key_challenge', offHome: false },
    { method: 'email_password', offHome: false },
    { method: 'email_password', offHome: true },
] as const)('retains the invitation authentication host through credential adoption and offers Open Team after atomic $method provisioning (off-Home: $offHome)', async ({ method, offHome }) => {
    const identity = `srv_${method}_join`;
    const origin = `https://${method.replaceAll('_', '-')}-join.test`;
    const mode = method === 'key_challenge' ? 'keyed' : 'keyless';
    const serverId = await home.addHome({ name: 'Acme', serverUrl: origin,
        serverIdentityId: identity, accountId: null, teamsEnabled: true });
    await setServerProfileIdentityForUrl(origin, identity);
    await setActiveServerId(identity, { scope: 'device' });
    const initialCredentials = offHome ? { token: createAccountTokenForTests('other-account', { currentAccount: true }) } : null;
    if (initialCredentials) {
        await home.addHome({ name: 'Other Home', serverUrl: 'https://other-home.test', accountId: 'other-account', credentials: initialCredentials });
        home.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'new-account' }) });
    }
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: identity }, server: { canonicalServerUrl: origin },
    } });
    tryWriteServerEnabledBitInPlace(features, 'teams', true);
    home.answer(serverId, '/v1/features', { body: features });
    const token = 'a'.repeat(43);
    home.answer(serverId, '/v1/team-invitations/preview', { body: TeamInvitationPreviewResultV1Schema.parse({
        outcome: 'ok', preview: {
            home: { serverId: identity, displayName: 'Acme', storageMode: null },
            team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
            role: 'member', historyAccess: 'from_membership', state: 'active',
            expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
        },
    }) });
    home.answer(serverId, '/v1/auth/entry', { body: AuthEntryProjectionV1Schema.parse({
        v: 1, state: 'admission_required', scope: { kind: 'invitation' },
        home: { serverId: identity, displayName: 'Acme', storageMode: null },
        team: { teamId: 'team-1', name: 'Acme Team', logo: null },
        invitationEmailVerificationRequired: false,
        actions: [{ kind: 'authenticate', methodId: method, action: 'provision',
            mode, origin: 'home', presentation: { displayName: method === 'key_challenge' ? 'Device key' : 'Email and password' } }],
        autoRedirect: null,
    }) });
    const credentials = { token: createAccountTokenForTests('new-account', { currentAccount: true }) };
    const authPath = method === 'key_challenge' ? '/v1/auth' : '/v1/auth/email/provision';
    home.answer(serverId, authPath, { select: () => {
        const record = home.findByServerUrl(origin);
        if (!record) throw new Error('The provisioning Home must exist');
        // Provisioning commits the Account before authenticated Sync reads its cursor.
        record.accountId = 'new-account';
        record.token = credentials.token;
        return { body: method === 'key_challenge' ? credentials : {
            ...credentials, accountId: 'new-account', teamId: 'team-1',
        } };
    } });
    const screen = await renderScreen(<AuthProvider initialCredentials={initialCredentials}>
        <TeamJoinScreen token={token} homeTarget={identity} />
    </AuthProvider>);
    await waitForHomeGovernance(() => expect(screen.findByTestId(`team-auth-entry-action:${method}`), screen.getTextContent()).not.toBeNull());
    const actionId = `home-auth-${method}-provision-${mode}`;
    const submitId = method === 'key_challenge' ? actionId : 'email-password-create';
    const credentialWritten = createDeferred<void>();
    const releaseStorage = createDeferred<void>();
    let credentialChanged = false;
    stopCredentialObservation = subscribeHomeCredentialChange(() => {
        credentialChanged = true;
        credentialWritten.resolve();
    });
    // The genuine browser storage-lock boundary retains the write while its
    // subscribers render. A single async act around the whole submission
    // batches this reachable adoption frame away and misses the cancellation.
    const requestLock = navigator.locks.request.bind(navigator.locks);
    const lockRequest = vi.spyOn(navigator.locks, 'request').mockImplementation(async <T,>(
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
        optionalCallback?: (lock: Lock | null) => T | PromiseLike<T>,
    ): Promise<T> => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback;
        if (!callback) throw new Error('Missing storage-lock callback');
        return await requestLock(name, async lock => {
            const result = await callback(lock);
            if (credentialChanged) await releaseStorage.promise;
            return result;
        });
    });
    try {
        // One-tap authentication starts on selection, so observe adoption and
        // retain the storage lock before that first user action.
        act(() => { screen.pressByTestId(`team-auth-entry-action:${method}`); });
        // The chosen method continues inside the same split shell, under the
        // Team's identity, instead of replacing the page with a bare form.
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-step-shell'), screen.getTextContent()).not.toBeNull());
        expect(screen.findByTestId('team-auth-step-heading')?.props.children).toContain('Acme Team');
        if (method === 'email_password') {
            // The entry card already chose this form; the step does not ask again.
            expect(screen.findByTestId(actionId)).toBeNull();
            await act(async () => {
                screen.changeTextByTestId('email-password-email', 'person@example.test');
                screen.changeTextByTestId('email-password-password', 'a calm sixteen plus password');
                screen.changeTextByTestId('email-password-confirm', 'a calm sixteen plus password');
            });
            act(() => { screen.pressByTestId(submitId); });
        }
        await credentialWritten.promise;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(screen.findByTestId(submitId), screen.getTextContent()).not.toBeNull();
    } finally {
        releaseStorage.resolve();
        lockRequest.mockRestore();
    }
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-complete-action'), screen.getTextContent()).not.toBeNull());
    if (offHome) {
        expect(screen.findByTestId('team-auth-entry-admission-complete-name-field'), screen.getTextContent()).not.toBeNull();
        expect(home.requestsFor('/v1/account/profile')).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverId, token: credentials.token }),
        ]));
        expect(home.requestsFor('/v1/team-invitations/accept')).toHaveLength(0);
    }
    expect(await TokenStorage.getCredentialsForServerUrl(origin, { serverId: identity })).toEqual(credentials);
    expect(home.requestsFor(authPath).map(request => request.input)).toEqual([
        expect.objectContaining({ admission: { kind: 'team_invitation', token } }),
    ]);
    // Provisioning committed admission; re-reading a consumed bearer would lose
    // the completed state and can never be how this journey reaches its Team.
    expect(home.requestsFor('/v1/auth/entry')).toHaveLength(1);
});
