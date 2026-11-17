import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const serverFetchMock = vi.hoisted(() => vi.fn());
const accountAuthorityMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    serverFetch: serverFetchMock,
    createServerFetchAtEndpoint: vi.fn(() => runtimeFetchMock),
}));

// Navigation is a platform boundary owned by the testkit; everything below it —
// admission, credential resolution, the Action front door and the transport —
// stays real, so this test can only pass if the screen genuinely issues nothing.
const setOptionsSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
// A cold-start deep link has no history behind it: the safe exit owner must
// replace to the root instead of issuing a `back` that goes nowhere.
const routerCanGoBackMock = vi.hoisted(() => vi.fn(() => false));
// The route reads its link from the router, and Expo Router updates a mounted
// dynamic route's params IN PLACE. This holder is how a second link arrives.
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const routePathname = vi.hoisted(() => ({ current: '/' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        navigation: { setOptions: setOptionsSpy },
        router: { replace: routerReplaceSpy, canGoBack: routerCanGoBackMock },
        params: () => routeParams.current,
        pathname: () => routePathname.current,
    }).module;
});

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));

// Focus itself stays real: `focusExactHomeAndRefresh` owns `requireExactProfile`,
// the already-active refresh and the blocked outcome. Only the connection switch
// underneath it — a genuine runtime boundary — is replaced.
const activeServerSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/server/activeServerSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/activeServerSwitch')>(),
    setActiveServerAndSwitch: activeServerSwitchMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope')>(),
    runWithServerRequestAuthorityForServerAccountScope: accountAuthorityMock,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: getCredentialsForServerUrlMock },
    });
});

vi.mock('@/components/account/auth/HomeAuthenticationFlow', async () => {
    const React = await import('react');
    return {
        HomeAuthenticationFlow: (props: Readonly<{
            onBack: () => void;
            onAuthenticated: (result: Readonly<{ teamId: string; credentials: { token: string }; homeServerIdentityId: string }>) => void;
        }>) => React.createElement(React.Fragment, null,
            React.createElement('HomeAuthenticationFlowMock',
                { ...props, testID: 'team-join-account-authentication', onPress: props.onBack }),
            React.createElement('HomeAuthenticationSuccessMock', {
                testID: 'team-join-account-authentication-success',
                onPress: () => props.onAuthenticated({
                    teamId: 'team-1',
                    credentials: { token: tokenForSub('fresh-account') },
                    homeServerIdentityId: 'srv_acme_home',
                }),
            }),
        ),
    };
});

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    getActiveServerId,
    listServerProfiles,
    setActiveServerId,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createTeamInvitationTargetBindingV1 } from '@happier-dev/protocol/teams';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { t } from '@/text';
import { resolveCompactAppDestinations, hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { storage } from '@/sync/domains/state/storage';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { Platform } from 'react-native';

import { TeamJoinScreen } from './TeamJoinScreen';
import TeamJoinRoute from '@/app/(app)/join/[token]';

const TOKEN = 'a'.repeat(43);
let restoreWebLockManager: (() => void) | null = null;

function boundTarget(homeTarget: string): Readonly<{
    homeTarget: string;
    targetBinding: string;
}> {
    return {
        homeTarget,
        targetBinding: createTeamInvitationTargetBindingV1({ token: TOKEN, homeTarget }),
    };
}

async function waitForTestId(
    rendered: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const node = rendered.findByTestId(testID);
        if (node) return node;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    throw new Error(
        `Timed out waiting for ${testID}; rendered=${rendered.getTextContent()}; `
        + `runtimeFetch=${JSON.stringify(runtimeFetchMock.mock.calls)}; `
        + `serverFetch=${JSON.stringify(serverFetchMock.mock.calls)}`,
    );
}

/** Lets an awaited arrival — focus, then the exact Team route — settle. */
async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

/** One saved, signed-in, Teams-capable Home — the tempting wrong target. */
async function addCapableHome(name: string, serverUrl: string): Promise<string> {
    const id = (await upsertServerProfile({ serverUrl, name })).id;
    const features = createRootLayoutFeaturesResponse();
    (features.features as Record<string, unknown>).teams = { enabled: false };
    tryWriteServerEnabledBitInPlace(features, 'teams', true);
    primeServerFeaturesSnapshot({ serverId: id, snapshot: { status: 'ready', features } });
    return id;
}

beforeEach(() => {
    routePathname.current = '/';
    restoreWebLockManager = installWebLockManagerMock().restore;
    runtimeFetchMock.mockReset();
    serverFetchMock.mockReset();
    accountAuthorityMock.mockReset();
    // The authenticated transport records the exact Account scope its authority was bound to.
    accountAuthorityMock.mockImplementation(
        async (params: Readonly<{ scope: unknown }>, operation: (authority: unknown) => Promise<unknown>) =>
            await operation({ request: (path: string, init?: RequestInit) => serverFetchMock(path, init, { accountScope: params.scope }) }),
    );
    getCredentialsForServerUrlMock.mockReset();
    getCredentialsForServerUrlMock.mockResolvedValue({ token: tokenForSub('account') });
    activeServerSwitchMock.mockReset();
    activeServerSwitchMock.mockResolvedValue('switched');
    resetServerFeaturesClientForTests();
});

afterEach(async () => {
    await standardCleanup();
    restoreWebLockManager?.();
    restoreWebLockManager = null;
    resetServerFeaturesClientForTests();
    vi.clearAllMocks();
});

describe('the exact Home contextual entry refusal', () => {
    it.each(['disabled', 'endpoint_missing', 'invalid_payload', 'network'] as const)(
        'keeps %s unavailable without offering authentication or admission', async (state) => {
            await addCapableHome('Acme', 'https://feature-home.example');
            await setServerProfileIdentityForUrl('https://feature-home.example', 'srv_feature_home');
            // Child 02 TA-R4/TA-R18: contextual entry, not a cached features
            // document, owns Team choices. The capable cache above cannot turn
            // a current refusal or unreadable response into an offered action.
            serverFetchMock.mockImplementation(async () => {
                if (state === 'network') throw new Error('Home unreachable');
                if (state === 'endpoint_missing') return new Response('', { status: 404 });
                return new Response(JSON.stringify(state === 'disabled'
                    ? { v: 1, state: 'unavailable', scope: { kind: 'invitation' }, reason: 'entry_not_available', autoRedirect: null }
                    : { v: 99, state: 'admission_required', team: { name: 'Untrusted Team' }, actions: [] }));
            });
            runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'feature-disabled' }), { status: 403 }));
            const screen = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_feature_home" />);
            await waitForTestId(screen, `team-auth-entry-${state === 'disabled' ? 'unavailable' : state === 'network' ? 'offline' : 'incompatible'}`);
            expect(serverFetchMock).toHaveBeenCalledWith('/v1/auth/entry', expect.anything(), {
                accountScope: { serverId: 'srv_feature_home', accountId: 'account' },
            });
            expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
            expect(screen.findByTestId('team-join-account-authentication')).toBeNull();
            expect(screen.getTextContent()).not.toContain('Untrusted Team');
            expect(runtimeFetchMock.mock.calls.some(([path]) => String(path).includes('/accept'))).toBe(false);
            expect(screen.getTextContent()).not.toContain(t('teams.join.updateRequiredTitle'));
        },
    );

    it.each(['disabled', 'endpoint_missing', 'invalid_payload', 'network'] as const)(
        'uses the exact Home feature decision to explain an unreadable entry (%s)', async (state) => {
            await addCapableHome('Acme', 'https://feature-home.example');
            await setServerProfileIdentityForUrl('https://feature-home.example', 'srv_feature_home');
            const features = createRootLayoutFeaturesResponse();
            tryWriteServerEnabledBitInPlace(features, 'teams', false);
            primeServerFeaturesSnapshot({ serverId: 'srv_feature_home', snapshot: state === 'disabled'
                ? { status: 'ready', features }
                : state === 'network'
                    ? { status: 'error', reason: 'network' }
                    : { status: 'unsupported', reason: state } });
            serverFetchMock.mockResolvedValue(new Response(JSON.stringify({ v: 99 })));
            runtimeFetchMock.mockResolvedValue(new Response('', { status: 503 }));
            const screen = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_feature_home" />);
            await waitForTestId(screen, 'team-auth-entry-incompatible');
            expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
            expect(screen.findByTestId('team-join-account-authentication')).toBeNull();
            if (state === 'endpoint_missing') {
                expect(screen.getTextContent()).toContain(t('teams.join.updateRequiredTitle'));
            } else {
                expect(screen.getTextContent()).not.toContain(t('teams.join.updateRequiredTitle'));
            }
            if (state === 'disabled') expect(screen.getTextContent()).toContain(t('teams.unavailable.disabled'));
        },
    );
});

/**
 * Expo Router updates a mounted dynamic route's params in place, so opening a
 * second invitation reuses the same mounted screen. Every state that screen
 * holds — the selected authentication action above all — belongs to ONE
 * invitation, so the second link must start from the entry surface rather than
 * inherit the first link's selection.
 */
describe('the join route receiving a second invitation link', () => {
    const SECOND_TOKEN = 'b'.repeat(43);

    it('starts the next link at the entry surface instead of the previous selection', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        let authEntryReads = 0;
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) {
                return new Response(JSON.stringify({
                    outcome: 'ok',
                    preview: {
                        home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                        team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                        role: 'member',
                        historyAccess: 'from_membership',
                        state: 'active',
                        expiresAt: Date.UTC(2030, 0, 1),
                        recipientEmailMask: 'p\u2022\u2022\u2022@example.test',
                    },
                }), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify({
                    v: 1,
                    state: 'admission_required',
                    scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{
                        kind: 'authenticate',
                        methodId: 'email_password',
                        action: 'login',
                        mode: 'either',
                        origin: 'home',
                        presentation: { displayName: 'Email' },
                    }, ...(authEntryReads === 1 ? [{ kind: 'switch_account' }] : [])],
                    ...(authEntryReads === 1
                        ? { currentAccountRecipientStatus: 'verification_required' }
                        : {}),
                    autoRedirect: null,
                }), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        routeParams.current = { token: TOKEN, target: 'srv_acme_home' };
        const rendered = await renderScreen(<TeamJoinRoute />);

        await waitForTestId(rendered, 'team-auth-entry-use-another-account');
        await rendered.pressByTestIdAsync('team-auth-entry-use-another-account');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
        const first = await waitForTestId(rendered, 'team-join-account-authentication');
        expect(first?.props.teamAdmission).toMatchObject({ invitationToken: TOKEN });

        // The second link arrives as an in-place param update, with no remount.
        routeParams.current = { token: SECOND_TOKEN, target: 'srv_acme_home' };
        await act(async () => {
            rendered.tree.update(<TeamJoinRoute />);
        });
        await settle();

        // The first invitation's selected authentication must not still be
        // mounted for the second invitation's bearer.
        expect(rendered.findByTestId('team-join-account-authentication')).toBeNull();
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[1] && (call[1] as { body?: string }).body)
            .includes(SECOND_TOKEN))).toBe(true);
    });
});

describe('TeamJoinScreen', () => {
    it('never sends the bearer to a Home the link did not name, even when only one is saved', async () => {
        const only = await addCapableHome('Only Home', 'https://only-home.example');
        await setActiveServerId(only, { scope: 'device' });

        const rendered = await renderScreen(<TeamJoinScreen token={TOKEN} />);

        // The issuing Home is unknown, so nothing may be asked of any Home. A
        // sole saved Home is not evidence that it minted this invitation, and
        // previewing against it would disclose the bearer to an unrelated Home.
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
        // The chooser is explicitly forbidden by the link contract.
        expect(rendered.findByTestId(`team-join-home:${only}`)).toBeNull();
        expect(rendered.findByTestId('team-join-accept')).toBeNull();
    });

    it('never sends the bearer when several Homes are saved either', async () => {
        const first = await addCapableHome('First', 'https://first.example');
        await addCapableHome('Second', 'https://second.example');
        await setActiveServerId(first, { scope: 'device' });

        const rendered = await renderScreen(<TeamJoinScreen token={TOKEN} />);

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
    });

    it('addresses the Home the carrier names even though its profile id differs', async () => {
        runtimeFetchMock.mockResolvedValue(new Response('', { status: 503 }));
        serverFetchMock.mockResolvedValue(new Response('', { status: 503 }));
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(other, { scope: 'device' });

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        // The carrier is the Home's portable identity, not a device-local
        // profile id, so the link resolves on any device that saved that Home
        // rather than dead-ending the way a profile-id comparison would. Which
        // Home it resolves *to* is asserted directly against the resolver in
        // teamJoinTarget.test.ts; here the contract is that this screen does not
        // fail closed on a link it can route.
        expect(rendered.findByTestId('team-join-unresolved-home')).toBeNull();
        expect(rendered.findByTestId('team-join-unknown-home')).toBeNull();
        expect(rendered.findByTestId('team-join-invalid')).toBeNull();
    });

    it('fails a binding-less unknown-Home identity closed before manual acquisition', async () => {
        const only = await addCapableHome('Only Home', 'https://only-home.example');
        await setServerProfileIdentityForUrl('https://only-home.example', 'srv_only_home');
        await setActiveServerId(only, { scope: 'device' });

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_home_elsewhere" />,
        );

        // The identity supplies no endpoint, but it also cannot be resolved to a
        // saved Home. A newly issued invitation must be requested before any
        // later acquisition can decide where the bearer belongs.
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
    });

    it('exits a cold-start invitation link through the safe back owner when there is no history', async () => {
        const rendered = await renderScreen(<TeamJoinScreen token="not-a-token" />);
        // The state reads as a step: its heading names the problem and the shell's
        // back chevron is the one way out, never a second Back row under it.
        expect(rendered.findByTestId('team-join-invalid-title')).not.toBeNull();
        expect(rendered.findByTestId('team-join-back')).toBeNull();

        await rendered.pressByTestIdAsync('unauth-shell-back-chevron');

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });

    it('rejects a malformed bearer before it can reach any Home', async () => {
        const only = await addCapableHome('Only Home', 'https://only-home.example');
        await setActiveServerId(only, { scope: 'device' });

        const rendered = await renderScreen(<TeamJoinScreen token="not-a-token" />);

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
        expect(rendered.findByTestId('unauth-shell-back-chevron')).not.toBeNull();
        expect(rendered.findByTestId('team-join-shell')).not.toBeNull();
        expect(rendered.findAll((node) => node.props.role === 'status'
            && node.props['aria-live'] === 'polite'
            && node.props.accessibilityRole === 'text'
            && node.props.accessibilityLiveRegion === 'polite')).not.toHaveLength(0);
    });

    it('switches Account before acceptance without consuming the invitation or changing Homes', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        let authEntryReads = 0;
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) {
                return new Response(JSON.stringify({
                    outcome: 'ok',
                    preview: {
                        home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                        team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                        role: 'member',
                        historyAccess: 'from_membership',
                        state: 'active',
                        expiresAt: Date.UTC(2030, 0, 1),
                        recipientEmailMask: 'p•••@example.test',
                    },
                }), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify({
                    v: 1,
                    state: 'admission_required',
                    scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{
                        kind: 'authenticate',
                        methodId: 'email_password',
                        action: 'login',
                        mode: 'either',
                        origin: 'home',
                        presentation: { displayName: 'Email' },
                    }, ...(authEntryReads === 1 ? [{ kind: 'switch_account' }] : [])],
                    ...(authEntryReads === 1
                        ? { currentAccountRecipientStatus: 'verification_required' }
                        : {}),
                    autoRedirect: null,
                }), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        await waitForTestId(rendered, 'team-auth-entry-use-another-account');
        await rendered.pressByTestIdAsync('team-auth-entry-use-another-account');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
        const authentication = await waitForTestId(rendered, 'team-join-account-authentication');
        expect(authentication?.props.returnTo).toBe(
            '/teams/team-1/sign-in?target=srv_acme_home',
        );
        expect(authentication?.props.teamAdmission).toEqual({
            teamId: 'team-1',
            invitationToken: TOKEN,
            origin: 'home',
            accountSelection: 'another',
        });
        expect(authentication?.props.nativeAdmission).toEqual({
            kind: 'team_invitation',
            token: TOKEN,
        });
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);

        await rendered.pressByTestIdAsync('team-join-account-authentication');
        expect(await waitForTestId(rendered, 'team-auth-entry-action:email_password')).toBeTruthy();
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);

        await rendered.pressByTestIdAsync('team-auth-entry-use-current-account');
        expect(await waitForTestId(rendered, 'team-auth-entry-join')).toBeTruthy();
        expect(getActiveServerId()).toBe('srv_acme_home');
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
    });

    it('opens an already-admitted Team directly without consuming the invitation', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({
                outcome: 'ok',
                preview: {
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: 'p•••@example.test',
                },
            }), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify({
                v: 1,
                state: 'already_member',
                scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                account: { firstName: 'Ada', lastName: null, username: 'ada', avatarUrl: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                actions: [{ kind: 'continue' }],
                autoRedirect: null,
            }), { status: 200 });
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        await waitForTestId(rendered, 'team-auth-entry-continue');
        expect(rendered.getTextContent()).toContain('Open Acme Team');
        await rendered.pressByTestIdAsync('team-auth-entry-continue');
        await settle();

        // The Team route is reached only after this exact Home is focused, which
        // an already-active Home settles through its refresh.
        expect(activeServerSwitchMock).toHaveBeenCalledWith({
            serverId: home,
            scope: 'device',
            refreshAuth: expect.any(Function),
            requireExactProfile: true,
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/teams/srv_acme_home/team-1');
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
        expect(serverFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
    });

    it('never opens a Team before the Home its admission committed on is focused', async () => {
        // The device is looking at Home A while the invitation belongs to Home B.
        // Routing first would render Home A's Teams stack under Home B's Team id.
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(other, { scope: 'device' });
        activeServerSwitchMock.mockResolvedValue('blocked');
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({
                outcome: 'ok',
                preview: {
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
                },
            }), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify({
                v: 1,
                state: 'already_member',
                scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                account: { firstName: 'Ada', lastName: null, username: 'ada', avatarUrl: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                actions: [{ kind: 'continue' }],
                autoRedirect: null,
            }), { status: 200 });
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );
        await waitForTestId(rendered, 'team-auth-entry-continue');
        await rendered.pressByTestIdAsync('team-auth-entry-continue');
        await settle();

        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(await waitForTestId(rendered, 'team-join-destination-home-action')).toBeTruthy();

        activeServerSwitchMock.mockResolvedValue('switched');
        await rendered.pressByTestIdAsync('team-join-destination-home-action');
        await settle();

        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/teams/srv_acme_home/team-1');
        expect(routerReplaceSpy).toHaveBeenCalledOnce();
        // Retry re-ran the focus and the exact Team route; nothing re-accepted the
        // invitation or asked this Home for admission again.
        expect(activeServerSwitchMock).toHaveBeenCalledTimes(2);
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
        expect(serverFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
    });

    it('retains atomic fresh-Account admission and waits for explicit Open Team', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        // This journey begins without an Account on the issuing Home; the
        // authentication flow creates one and returns the atomic admission.
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        let authEntryReads = 0;
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({
                outcome: 'ok',
                preview: {
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
                },
            }), { status: 200 });
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify({
                    v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: true,
                    actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'home', presentation: { displayName: 'Email' } }],
                    autoRedirect: null,
                }), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        let workspaceState = createWorkspaceState({ id: 'settings-tab',
            target: { kind: 'settings', params: {} }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        }, pages: [] });
        const committed: string[] = [];
        const workspaceAdapter = createWorkspaceNavigationAdapter({
            getState: () => workspaceState, getCatalog: () => catalog,
            dispatch: (action) => { workspaceState = reduceWorkspaceState(workspaceState, action); },
            transport: { commit: (href) => { committed.push(href); } },
            createId: () => 'team-tab', onChange: () => {},
        });
        const workspace: WorkspaceNavigationContextValue = {
            active: true, state: workspaceState, catalog, canGoBack: false, canGoForward: false,
            openHref: workspaceAdapter.openHref.bind(workspaceAdapter),
            activateTab: workspaceAdapter.activateTab.bind(workspaceAdapter),
            closeTab: workspaceAdapter.closeTab.bind(workspaceAdapter),
            closeTabs: workspaceAdapter.closeTabs.bind(workspaceAdapter),
            dispatch: workspaceAdapter.dispatch.bind(workspaceAdapter),
            navigationForTab: () => { throw new Error('Unexpected tab navigation'); },
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        const rendered = await renderScreen(<WorkspaceNavigationProvider value={workspace}>
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />
        </WorkspaceNavigationProvider>);
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
        await waitForTestId(rendered, 'team-join-account-authentication-success');
        await rendered.pressByTestIdAsync('team-join-account-authentication-success');

        expect(await waitForTestId(rendered, 'team-auth-entry-admission-complete')).toBeTruthy();
        expect(authEntryReads).toBe(1);
        expect(committed).toEqual([]);
        expect(routerReplaceSpy).not.toHaveBeenCalled();

        // Open Team is an arrival, not a bare route push: the Account was created
        // on this Home while another was focused.
        await rendered.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        await settle();

        expect(activeServerSwitchMock).toHaveBeenCalledWith({
            serverId: home,
            scope: 'device',
            refreshAuth: expect.any(Function),
            requireExactProfile: true,
        });
        const focused = workspaceState.tabs[workspaceState.groups[workspaceState.focusedGroupId]!.activeTabId]!;
        expect(hrefForDestinationRef(catalog, focused.target)).toBe('/settings/teams/srv_acme_home/team-1');
        expect(committed).toEqual(['/settings/teams/srv_acme_home/team-1']);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['asks the unnamed fresh Account how its colleagues should see it', null, true],
        ['never asks a fresh Account that already has a name', 'Ada Lovelace', false],
    ] as const)('%s on the joined card', async (_label, name, asksName) => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({ outcome: 'ok', preview: {
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                role: 'member', historyAccess: 'from_membership', state: 'active', expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
            } }));
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify({ v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                invitationEmailVerificationRequired: false,
                actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'home', presentation: { displayName: 'Email' } }], autoRedirect: null }));
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);
        try {
            const rendered = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />);
            await waitForTestId(rendered, 'team-auth-entry-action:email_password');
            await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
            // The new Account's profile is the one in sync on the Home it joined.
            await act(async () => {
                storage.setState({
                    profileScope: { serverId: resolveServerProfileScopeIdForIdentifier(home), accountId: 'fresh-account' },
                    profile: { ...profileDefaults, id: 'fresh-account', name, username: 'ada' },
                });
            });
            await rendered.pressByTestIdAsync('team-join-account-authentication-success');

            expect(await waitForTestId(rendered, 'team-auth-entry-admission-complete')).toBeTruthy();
            expect(rendered.findByTestId('team-auth-entry-admission-complete-name-field') !== null).toBe(asksName);
        } finally {
            await act(async () => { storage.setState({ profileScope: previousScope, profile: previousProfile }); });
        }
    });

    it.each([false, true])('opens the admitted Team through the current workspace after exact-Home focus (scope changes=%s)', async scopeChanges => {
        const previousPlatform = Platform.OS;
        const previousScope = storage.getState().profileScope;
        const previousReady = storage.getState().isDataReady;
        Platform.OS = 'web';
        routePathname.current = '/join/invitation';
        const location = { pathname: routePathname.current, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState(state: unknown, _unused: string, href?: string | URL | null) {
                this.state = state;
                if (href) { const next = new URL(href, 'https://workspace.test'); location.pathname = next.pathname; location.search = next.search; }
            },
            pushState(state: unknown, unused: string, href: string) { this.replaceState(state, unused, href); },
            go() {},
        };
        const events = new EventTarget();
        vi.stubGlobal('window', { location, history, sessionStorage: { getItem: () => 'main' },
            addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events) });
        let rendered: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const home = await addCapableHome('Acme', 'https://acme-home.example');
            await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
            await setActiveServerId(home, { scope: 'device' });
            storage.setState({ profileScope: { serverId: scopeChanges ? 'home-a' : 'srv_acme_home', accountId: 'account' }, isDataReady: true });
            getCredentialsForServerUrlMock.mockResolvedValue(null);
            const joinFetch = async (input: string | Readonly<{ url: string }>) => {
                const path = typeof input === 'string' ? input : input.url;
                if (path.includes('/v1/features')) {
                    const features = createRootLayoutFeaturesResponse();
                    tryWriteServerEnabledBitInPlace(features, 'teams', true);
                    return new Response(JSON.stringify(features));
                }
                if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({ outcome: 'ok', preview: {
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active', expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
                } }));
                if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify({ v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'home', presentation: { displayName: 'Email' } }], autoRedirect: null }));
                throw new Error(`Unexpected Team request: ${path}`);
            };
            runtimeFetchMock.mockImplementation(joinFetch);
            serverFetchMock.mockImplementation(joinFetch);
            const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
                externalSessions: false, inbox: false, workflows: false, friends: false,
            } });
            const element = (enabled = false) => <WorkspaceProvider enabled={enabled} entry catalog={catalog}>
                {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" /></>}
            </WorkspaceProvider>;
            rendered = await renderScreen(element());
            await waitForTestId(rendered, 'team-auth-entry-action:email_password');
            await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
            await rendered.pressByTestIdAsync('team-join-account-authentication-success');
            const focusedHome = createDeferred<'switched'>();
            activeServerSwitchMock.mockImplementation(async () => await focusedHome.promise);
            act(() => { rendered!.pressByTestId('team-auth-entry-admission-complete-action'); });
            // Focus remains in flight while the real store publishes its new
            // Home/Account binding and the workspace retires the old dispatcher.
            await act(async () => {
                storage.setState({ profileScope: { serverId: 'srv_acme_home', accountId: scopeChanges ? 'new-account' : 'account' } });
                await rendered!.update(element());
            });
            await act(async () => { focusedHome.resolve('switched'); });
            await settle();
            routePathname.current = '/settings';
            if (location.pathname.startsWith('/join/')) history.replaceState(history.state, '', '/settings');
            await rendered.update(element(true));
            const navigation = rendered.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            const state = navigation.state;
            const focused = state.tabs[state.groups[state.focusedGroupId]!.activeTabId]!;
            expect(hrefForDestinationRef(catalog, focused.target)).toBe('/settings/teams/srv_acme_home/team-1');
            expect(location.pathname).toBe('/settings/teams/srv_acme_home/team-1');
        } finally {
            await rendered?.unmount();
            Platform.OS = previousPlatform;
            await act(async () => { storage.setState({ profileScope: previousScope, isDataReady: previousReady }); });
            vi.unstubAllGlobals();
        }
    });

    /** A current link: the Home's own strict descriptor, as the join producer emits it. */
    function currentLinkCarrier(identity: string, url: string): string {
        return JSON.stringify({
            kind: 'descriptor',
            authority: 'trusted_enrollment',
            descriptor: {
                v: 1,
                homeServerIdentityId: identity,
                canonicalServerUrl: url,
                revision: 1,
                endpoints: [{ kind: 'https', url }],
            },
        });
    }

    /** How the endpoints the link named answer the public feature probe. */
    function featureProbeResponse(observedIdentity: string): Response {
        const features = createRootLayoutFeaturesResponse();
        (features.capabilities as { serverIdentity: { serverIdentityId: string | null } })
            .serverIdentity = { serverIdentityId: observedIdentity };
        (features.features as Record<string, unknown>).teams = { enabled: false };
        tryWriteServerEnabledBitInPlace(features, 'teams', true);
        return new Response(JSON.stringify(features), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }

    function freshHomeJoinFetch(observedIdentity: string) {
        return async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/features')) return featureProbeResponse(observedIdentity);
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({
                outcome: 'ok',
                preview: {
                    home: { serverId: 'srv_fresh_home', displayName: 'Fresh', storageMode: null },
                    team: { teamId: 'team-1', name: 'Fresh Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: 'p\u2022\u2022\u2022@example.test',
                },
            }), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify({
                v: 1,
                state: 'admission_required',
                scope: { kind: 'invitation' },
                home: { serverId: 'srv_fresh_home', displayName: 'Fresh', storageMode: null },
                team: { teamId: 'team-1', name: 'Fresh Team', logo: null },
                invitationEmailVerificationRequired: false,
                actions: [{
                    kind: 'authenticate', methodId: 'email_password', action: 'login',
                    mode: 'either', origin: 'home', presentation: { displayName: 'Email' },
                }],
                autoRedirect: null,
            }), { status: 200 });
            throw new Error(`Unexpected Team join request: ${path}`);
        };
    }

    it('rejects a target changed independently of its invitation binding before probing it', async () => {
        const honestCarrier = currentLinkCarrier('srv_fresh_home', 'https://fresh-home.example');
        const changedCarrier = honestCarrier.replace(
            'https://fresh-home.example',
            'https://attacker-home.example',
        );
        const rendered = await renderScreen(
            <TeamJoinScreen
                token={TOKEN}
                homeTarget={changedCarrier}
                targetBinding={boundTarget(honestCarrier).targetBinding}
            />,
        );
        await settle();

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(listServerProfiles().some((profile) => (
            profile.serverUrl === 'https://attacker-home.example'
        ))).toBe(false);
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
    });

    it.each([
        ['missing', null],
        ['malformed', 'not-a-binding'],
    ])('rejects a %s binding for an unknown-Home descriptor before probing it', async (_label, targetBinding) => {
        const homeTarget = currentLinkCarrier('srv_fresh_home', 'https://fresh-home.example');
        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget={homeTarget} targetBinding={targetBinding} />,
        );
        await settle();

        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(serverFetchMock).not.toHaveBeenCalled();
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
    });

    it('acquires the Home a current link names and continues the same invitation in place', async () => {
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await setActiveServerId(other, { scope: 'device' });
        const joinFetch = freshHomeJoinFetch('srv_fresh_home');
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);
        getCredentialsForServerUrlMock.mockResolvedValue(null);

        const homeTarget = currentLinkCarrier('srv_fresh_home', 'https://fresh-home.example');
        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} {...boundTarget(homeTarget)} />,
        );

        // A fresh device has never saved this Home. The link carries the Home's
        // own descriptor, so the invitation continues on the route it is already
        // mounted on instead of dead-ending at manual Home discovery.
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        expect(rendered.findByTestId('team-join-unknown-home')).toBeNull();
        expect(rendered.findByTestId('team-join-unreachable-home')).toBeNull();
        expect(listServerProfiles().some((profile) => profile.serverIdentityId === 'srv_fresh_home')).toBe(true);
    });

    it('never presents the invitation to endpoints that answer as a different Home', async () => {
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await setActiveServerId(other, { scope: 'device' });
        const joinFetch = freshHomeJoinFetch('srv_impostor_home');
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const homeTarget = currentLinkCarrier('srv_fresh_home', 'https://fresh-home.example');
        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} {...boundTarget(homeTarget)} />,
        );

        await waitForTestId(rendered, 'team-join-unreachable-home');
        // Only the unauthenticated identity probe was made; the bearer stayed here.
        for (const call of [...runtimeFetchMock.mock.calls, ...serverFetchMock.mock.calls]) {
            expect(String(call[0])).not.toContain('/v1/team-invitations');
        }
        expect(listServerProfiles().some((profile) => profile.serverIdentityId === 'srv_fresh_home')).toBe(false);
        expect(rendered.findByTestId('team-join-retry-home')).not.toBeNull();
    });

    it('presents an administratively disabled Teams feature as unavailable, not update-required', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) {
                // Child 05 §8/§9: a capable Home with Teams administratively
                // disabled answers the declared typed outcome; the join screen
                // must not misread an operator's choice as an old binary.
                return new Response(JSON.stringify({ outcome: 'feature_unavailable' }), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                return new Response(JSON.stringify({
                    v: 1,
                    state: 'admission_required',
                    scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [],
                    autoRedirect: null,
                }), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        // The Home is reachable and current and has said so: this is an
        // operator's choice, which is neither an old binary nor an unusable
        // link. Asking for a new link would not help, so the disabled
        // explanation is what the person is shown.
        await waitForTestId(rendered, 'team-join-preview-feature-unavailable');
        expect(rendered.findByTestId('team-join-preview-update-required')).toBeNull();
        expect(rendered.findByTestId('team-join-preview-unavailable')).toBeNull();
        expect(rendered.getTextContent()).toContain(t('teams.unavailable.disabled'));
        // Without a readable offer consequence the Join confirmation stays withheld.
        expect(rendered.findByTestId('team-auth-entry-join')).toBeNull();
    });

    it('never offers sign-in when this device cannot read its saved Home credential', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        // Secure storage failed: whether an Account is saved here is unknown,
        // so authenticating again could replace a credential that still exists.
        // Mirrors the real owner (serverCredentialAccountScope.test.ts): the failure
        // surfaces only to a reader that opted in; tolerant readers see no credential.
        getCredentialsForServerUrlMock.mockImplementation(async (
            _serverUrl: string,
            options?: Readonly<{ storageReadFailure?: 'absent' | 'surface' }>,
        ) => {
            if (options?.storageReadFailure === 'surface') throw new Error('secure storage read failed');
            return null;
        });
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify({
                outcome: 'ok',
                preview: {
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
                    role: 'member', historyAccess: 'from_membership', state: 'active',
                    expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
                },
            }), { status: 200 });
            if (path.includes('/v1/auth/entry')) {
                return new Response(JSON.stringify({
                    v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'either', origin: 'home', presentation: { displayName: 'Email' } }],
                    autoRedirect: null,
                }), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        serverFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />);

        await waitForTestId(rendered, 'team-join-home-unavailable');
        expect(rendered.findByTestId('team-auth-entry-action:email_password')).toBeNull();
        // The card names the local cause and keeps the invitation, never a Home outage.
        expect(rendered.getTextContent()).toContain(t('homeGovernance.credentialUnreadableTitle'));
        expect(rendered.getTextContent()).toContain(t('homeGovernance.credentialUnreadableInviteBody'));
        expect(rendered.getTextContent()).not.toContain(t('homeGovernance.unavailableTitle'));
        expect(rendered.findByTestId('team-join-home-unavailable-secondary-action')).not.toBeNull();

        // Once storage reads again (here: confirmed empty), Retry settles the
        // screen on the real answer instead of leaving it stranded.
        getCredentialsForServerUrlMock.mockImplementation(async () => null);
        await rendered.pressByTestIdAsync('team-join-home-unavailable-action');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        expect(rendered.findByTestId('team-join-home-unavailable')).toBeNull();
    });
});
