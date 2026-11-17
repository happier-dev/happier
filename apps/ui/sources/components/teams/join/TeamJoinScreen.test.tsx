import { teamInvitationPreviewFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn());
// Navigation is a platform boundary owned by the testkit; everything below it —
// admission, credential resolution, the Action front door and the transport —
// stays real, including the refusal cases that must issue no mutation.
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

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

import { createDeferred, renderScreen as renderScreenBase, standardCleanup } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import {
    getActiveServerId,
    listServerProfiles,
    setActiveServerId,
    setServerProfileIdentityForUrl as setIdentity,
} from '@/sync/domains/server/serverProfiles';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { TeamInvitationPreviewResultV1Schema, createTeamInvitationTargetBindingV1 } from '@happier-dev/protocol/teams';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { t } from '@/text';
import { resolveCompactAppDestinations, hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

import { MMKV } from 'react-native-mmkv';
import { Platform } from 'react-native';
import { teamSetupPath } from '@/components/settings/teams/teamsRoutes';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { NativeEmailPasswordProvisionResponseV1Schema } from '@happier-dev/protocol/auth/nativeAuthEmailRoutes';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('team-join-screen', { preserveGenerations: true });
const homeBoundary = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homeBoundary);
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
await import('@/sync/syncEngine');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TeamJoinScreen } = await import('./TeamJoinScreen');
const { default: TeamJoinRoute } = await import('@/app/(app)/join/[token]');

async function renderScreen(element: React.ReactElement) {
    const wrap = (child: React.ReactElement) => <AuthProvider initialCredentials={null}>{child}</AuthProvider>;
    const rendered = await renderScreenBase(wrap(element));
    return { ...rendered, update: (child: React.ReactElement) => rendered.update(wrap(child)) };
}
const originalPlatform = Platform.OS;
let restoreStorage: () => void;
async function clearHomeCredentials() {
    for (const profile of listServerProfiles()) {
        await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
    }
}
async function setServerProfileIdentityForUrl(url: string, identity: string) {
    await setIdentity(url, identity);
    const home = homeBoundary.findByServerUrl(url);
    if (!home) return;
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: identity }, server: { canonicalServerUrl: url },
    } });
    tryWriteServerEnabledBitInPlace(features, 'teams', true);
    homeBoundary.answer(home.serverId, '/v1/features', { body: features });
}
function blockFocus() {
    const write = MMKV.prototype.set;
    return vi.spyOn(MMKV.prototype, 'set').mockImplementation(function (this: MMKV, key, value) {
        const state: unknown = key === 'server-state-v1' && typeof value === 'string' ? JSON.parse(value) : null;
        if (state && typeof state === 'object' && 'activeServerId' in state) {
            throw new Error('Device storage temporarily unavailable');
        }
        write.call(this, key, value);
    });
}
async function completeProvision(rendered: Awaited<ReturnType<typeof renderScreen>>) {
    await waitForHomeGovernance(() => expect(rendered.findByTestId('email-password-email'), rendered.getTextContent()).not.toBeNull());
    await act(async () => {
        rendered.changeTextByTestId('email-password-email', 'person@example.test');
        rendered.changeTextByTestId('email-password-password', 'a calm sixteen plus password');
        rendered.changeTextByTestId('email-password-confirm', 'a calm sixteen plus password');
    });
    await rendered.pressByTestIdAsync('email-password-create');
    await waitForHomeGovernance(() => {
        expect(rendered.findByTestId('team-auth-entry-admission-complete'), rendered.getTextContent()).not.toBeNull();
        expect(storage.getState().profileScope?.accountId).toBe('fresh-account');
        expect(storage.getState().profile.id).toBe('fresh-account');
    });
}

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
    return await waitForHomeGovernance(() => {
        const node = rendered.findByTestId(testID);
        expect(node, rendered.getTextContent()).not.toBeNull();
        return node!;
    });
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
    return createAccountTokenForTests(sub, { currentAccount: true });
}

/** One saved, signed-in, Teams-capable Home — the tempting wrong target. */
async function addCapableHome(name: string, serverUrl: string): Promise<string> {
    return await homeBoundary.addHome({ name, serverUrl, accountId: 'account',
        credentials: { token: tokenForSub('account') }, teamsEnabled: true });
}

beforeEach(() => {
    Platform.OS = 'web';
    routePathname.current = '/';
    restoreWebLockManager = installWebLockManagerMock().restore;
    restoreStorage = installLocalStorageMock().restore;
    runtimeFetchMock.mockReset();
    runtimeFetchMock.mockResolvedValue(new Response('', { status: 503 }));
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/auth/email/provision') {
            const home = homeBoundary.findByServerUrl(url.origin);
            if (!home) throw new Error('Expected provisioning Home');
            home.accountId = 'fresh-account';
            home.token = tokenForSub('fresh-account');
            return Response.json(NativeEmailPasswordProvisionResponseV1Schema.parse({ token: home.token,
                accountId: home.accountId, teamId: 'team-1' }));
        }
        if (url.pathname === '/v1/auth/entry' || url.pathname.startsWith('/v1/team-invitations/')
            || url.pathname === '/v1/features' && !homeBoundary.findByServerUrl(url.origin)) {
            return runtimeFetchMock(String(input), init);
        }
        return homeBoundary.request(input, init);
    });
    resetServerFeaturesClientForTests();
});

afterEach(async () => {
    await standardCleanup();
    await disconnectActiveServerConnection();
    await homeBoundary.reset();
    restoreStorage();
    Platform.OS = originalPlatform;
    vi.restoreAllMocks();
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
            runtimeFetchMock.mockImplementation(async () => {
                if (state === 'network') throw new Error('Home unreachable');
                if (state === 'endpoint_missing') return new Response('', { status: 404 });
                return new Response(JSON.stringify(state === 'disabled'
                    ? { v: 1, state: 'unavailable', scope: { kind: 'invitation' }, reason: 'entry_not_available', autoRedirect: null }
                    : { v: 99, state: 'admission_required', team: { name: 'Untrusted Team' }, actions: [] }));
            });
            const screen = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_feature_home" />);
            await waitForTestId(screen, `team-auth-entry-${state === 'disabled' ? 'unavailable' : state === 'network' ? 'offline' : 'incompatible'}`);
            expect(runtimeFetchMock).toHaveBeenCalledWith('https://feature-home.example/v1/auth/entry',
                expect.objectContaining({ headers: expect.any(Headers) }));
            const entry = runtimeFetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/auth/entry'))!;
            expect(new Headers(entry[1].headers).get('Authorization')).toBe(`Bearer ${tokenForSub('account')}`);
            expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
            expect(screen.findByTestId('email-password-email')).toBeNull();
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
            homeBoundary.answer(resolveServerProfileScopeIdForIdentifier('srv_feature_home'), '/v1/features', state === 'disabled' ? { body: features } : { status: state === 'network' ? 503 : state === 'endpoint_missing' ? 404 : 200, body: state === 'invalid_payload' ? { invalid: true } : {} });
            runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ v: 99 })));
            const screen = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_feature_home" />);
            await waitForTestId(screen, 'team-auth-entry-incompatible');
            expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
            expect(screen.findByTestId('email-password-email')).toBeNull();
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
                return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                    outcome: 'ok',
                    preview: teamInvitationPreviewFixture({ recipientEmailMask: 'p\u2022\u2022\u2022@example.test' }),
                })), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
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
                })), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

        routeParams.current = { token: TOKEN, target: 'srv_acme_home' };
        const rendered = await renderScreen(<TeamJoinRoute />);

        await waitForTestId(rendered, 'team-auth-entry-use-another-account');
        await rendered.pressByTestIdAsync('team-auth-entry-use-another-account');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
        await waitForTestId(rendered, 'email-password-email');

        // The second link arrives as an in-place param update, with no remount.
        routeParams.current = { token: SECOND_TOKEN, target: 'srv_acme_home' };
        await act(async () => {
            await rendered.update(<TeamJoinRoute />);
        });
        await settle();

        // The first invitation's selected authentication must not still be
        // mounted for the second invitation's bearer.
        expect(rendered.findByTestId('email-password-email')).toBeNull();
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
                return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                    outcome: 'ok',
                    preview: teamInvitationPreviewFixture({ recipientEmailMask: 'p•••@example.test' }),
                })), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
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
                })), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        await waitForTestId(rendered, 'team-auth-entry-use-another-account');
        await rendered.pressByTestIdAsync('team-auth-entry-use-another-account');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
        await waitForTestId(rendered, 'email-password-email');
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);

        await rendered.pressByTestIdAsync('unauth-shell-back-chevron');
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
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                outcome: 'ok',
                preview: teamInvitationPreviewFixture({ recipientEmailMask: 'p•••@example.test' }),
            })), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
                v: 1,
                state: 'already_member',
                scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                account: { firstName: 'Ada', lastName: null, username: 'ada', avatarUrl: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                actions: [{ kind: 'continue' }],
                autoRedirect: null,
            })), { status: 200 });
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );

        await waitForTestId(rendered, 'team-auth-entry-continue');
        expect(rendered.getTextContent()).toContain('Open Acme Team');
        await rendered.pressByTestIdAsync('team-auth-entry-continue');
        await settle();

        // The Team route is reached only after this exact Home is focused, which
        // an already-active Home settles through its refresh.
        expect(getActiveServerId()).toBe('srv_acme_home');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/teams/srv_acme_home/team-1');
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
    });

    it('never opens a Team before the Home its admission committed on is focused', async () => {
        // The device is looking at Home A while the invitation belongs to Home B.
        // Routing first would render Home A's Teams stack under Home B's Team id.
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(other, { scope: 'device' });
        const focusFailure = blockFocus();
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                outcome: 'ok',
                preview: teamInvitationPreviewFixture(),
            })), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
                v: 1,
                state: 'already_member',
                scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                account: { firstName: 'Ada', lastName: null, username: 'ada', avatarUrl: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                actions: [{ kind: 'continue' }],
                autoRedirect: null,
            })), { status: 200 });
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />,
        );
        await waitForTestId(rendered, 'team-auth-entry-continue');
        await rendered.pressByTestIdAsync('team-auth-entry-continue');
        await settle();

        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(await waitForTestId(rendered, 'team-join-destination-home-action')).toBeTruthy();

        focusFailure.mockRestore();
        await rendered.pressByTestIdAsync('team-join-destination-home-action');
        await settle();

        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/teams/srv_acme_home/team-1');
        expect(routerReplaceSpy).toHaveBeenCalledOnce();
        // Retry re-ran the focus and the exact Team route; nothing re-accepted the
        // invitation or asked this Home for admission again.
        expect(getActiveServerId()).toBe('srv_acme_home');
        expect(runtimeFetchMock.mock.calls.some((call) => String(call[0]).includes('/accept'))).toBe(false);
    });

    it('retains atomic fresh-Account admission and waits for explicit setup continuation', async () => {
        const home = await addCapableHome('Acme', 'https://acme-home.example');
        await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
        await setActiveServerId(home, { scope: 'device' });
        // This journey begins without an Account on the issuing Home; the
        // authentication flow creates one and returns the atomic admission.
        await clearHomeCredentials();
        let authEntryReads = 0;
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                outcome: 'ok',
                preview: teamInvitationPreviewFixture(),
            })), { status: 200 });
            if (path.includes('/v1/auth/entry')) {
                authEntryReads += 1;
                return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
                    v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email' } }],
                    autoRedirect: null,
                })), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

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
        await completeProvision(rendered);

        expect(await waitForTestId(rendered, 'team-auth-entry-admission-complete')).toBeTruthy();
        expect(authEntryReads).toBe(1);
        expect(committed).toEqual([]);
        expect(routerReplaceSpy).not.toHaveBeenCalled();

        // Setup is an explicit arrival, not a bare route push: the Account was created
        // on this Home while another was focused.
        await rendered.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        const destination = teamSetupPath({ serverId: 'srv_acme_home', teamId: 'team-1' });
        await waitForHomeGovernance(() => {
            expect(committed).toHaveLength(1);
        });
        expect(committed).toEqual([destination]);

        expect(getActiveServerId()).toBe('srv_acme_home');
        const focused = workspaceState.tabs[workspaceState.groups[workspaceState.focusedGroupId]!.activeTabId]!;
        expect(hrefForDestinationRef(catalog, focused.target)).toBe(destination);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(authEntryReads).toBe(1);
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
        await clearHomeCredentials();
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({ outcome: 'ok', preview: teamInvitationPreviewFixture() })));
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({ v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                invitationEmailVerificationRequired: false,
                actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email' } }], autoRedirect: null })));
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);
        try {
            const rendered = await renderScreen(<TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" />);
            await waitForTestId(rendered, 'team-auth-entry-action:email_password');
            await rendered.pressByTestIdAsync('team-auth-entry-action:email_password');
            homeBoundary.answer(home, '/v1/account/profile', { body: AccountProfileSchema.parse({
                id: 'fresh-account', firstName: name, username: 'ada',
            }) });
            await completeProvision(rendered);

            expect(await waitForTestId(rendered, 'team-auth-entry-admission-complete')).toBeTruthy();
            await waitForHomeGovernance(() => {
                expect(storage.getState().profile.id).toBe('fresh-account');
                expect(rendered.findByTestId('team-auth-entry-admission-complete-name-field') !== null).toBe(asksName);
            });
        } finally {
            await act(async () => { storage.setState({ profileScope: previousScope, profile: previousProfile }); });
        }
    });

    it.each([false, true])('opens an already-admitted Team through the current workspace after real Home focus (scope changes=%s)', async scopeChanges => {
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
            localStorage: globalThis.localStorage,
            addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events) });
        let rendered: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const home = await addCapableHome('Acme', 'https://acme-home.example');
            await setServerProfileIdentityForUrl('https://acme-home.example', 'srv_acme_home');
            await setActiveServerId(home, { scope: 'device' });
            if (scopeChanges) {
                const other = await addCapableHome('Other', 'https://other-home.example');
                await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
                await setActiveServerId(other, { scope: 'device' });
            }
            runtimeFetchMock.mockImplementation(async (input: string) => {
                if (input.includes('/v1/team-invitations/preview')) return Response.json(TeamInvitationPreviewResultV1Schema.parse({ outcome: 'ok', preview: teamInvitationPreviewFixture() }));
                if (input.includes('/v1/auth/entry')) return Response.json(AuthEntryProjectionV1Schema.parse({ v: 1, state: 'already_member', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    account: { firstName: 'Ada', lastName: null, username: 'ada', avatarUrl: null },
                    actions: [{ kind: 'continue' }], autoRedirect: null }));
                throw new Error(`Unexpected Team request: ${input}`);
            });
            const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
                externalSessions: false, inbox: false, workflows: false, friends: false,
            } });
            const element = (enabled = false) => <WorkspaceProvider enabled={enabled} entry catalog={catalog}>
                {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<TeamJoinScreen token={TOKEN} homeTarget="srv_acme_home" /></>}
            </WorkspaceProvider>;
            rendered = await renderScreen(element());
            await waitForTestId(rendered, 'team-auth-entry-continue');
            await rendered.pressByTestIdAsync('team-auth-entry-continue');
            await waitForHomeGovernance(() => expect(location.pathname).toBe('/settings/teams/srv_acme_home/team-1'));
            routePathname.current = '/settings';
            await rendered.update(element(true));
            const navigation = rendered.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            const state = navigation.state;
            const focused = state.tabs[state.groups[state.focusedGroupId]!.activeTabId]!;
            expect(hrefForDestinationRef(catalog, focused.target)).toBe('/settings/teams/srv_acme_home/team-1');
            expect(location.pathname).toBe('/settings/teams/srv_acme_home/team-1');
            expect(getActiveServerId()).toBe('srv_acme_home');
        } finally {
            await rendered?.unmount();
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
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                outcome: 'ok',
                preview: teamInvitationPreviewFixture({ home: { serverId: 'srv_fresh_home', displayName: 'Fresh' }, team: { name: 'Fresh Team' }, recipientEmailMask: 'p\u2022\u2022\u2022@example.test' }),
            })), { status: 200 });
            if (path.includes('/v1/auth/entry')) return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
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
            })), { status: 200 });
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
        expect(rendered.findByTestId('team-join-invalid')).not.toBeNull();
    });

    it('acquires the Home a current link names and continues the same invitation in place', async () => {
        const other = await addCapableHome('Other', 'https://other-home.example');
        await setServerProfileIdentityForUrl('https://other-home.example', 'srv_other_home');
        await setActiveServerId(other, { scope: 'device' });
        const joinFetch = freshHomeJoinFetch('srv_fresh_home');
        runtimeFetchMock.mockImplementation(joinFetch);
        await clearHomeCredentials();

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

        const homeTarget = currentLinkCarrier('srv_fresh_home', 'https://fresh-home.example');
        const rendered = await renderScreen(
            <TeamJoinScreen token={TOKEN} {...boundTarget(homeTarget)} />,
        );

        await waitForTestId(rendered, 'team-join-unreachable-home');
        // Only the unauthenticated identity probe was made; the bearer stayed here.
        for (const call of runtimeFetchMock.mock.calls) {
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
                return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({ outcome: 'feature_unavailable' })), { status: 200 });
            }
            if (path.includes('/v1/auth/entry')) {
                return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
                    v: 1,
                    state: 'admission_required',
                    scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [],
                    autoRedirect: null,
                })), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

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
        const readStorage = vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation(() => {
            throw new Error('secure storage read failed');
        });
        const joinFetch = async (input: string | Readonly<{ url: string }>) => {
            const path = typeof input === 'string' ? input : input.url;
            if (path.includes('/v1/team-invitations/preview')) return new Response(JSON.stringify(TeamInvitationPreviewResultV1Schema.parse({
                outcome: 'ok',
                preview: teamInvitationPreviewFixture(),
            })), { status: 200 });
            if (path.includes('/v1/auth/entry')) {
                return new Response(JSON.stringify(AuthEntryProjectionV1Schema.parse({
                    v: 1, state: 'admission_required', scope: { kind: 'invitation' },
                    home: { serverId: 'srv_acme_home', displayName: 'Acme', storageMode: null },
                    team: { teamId: 'team-1', name: 'Acme Team', logo: null },
                    invitationEmailVerificationRequired: false,
                    actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'provision', mode: 'keyless', origin: 'home', presentation: { displayName: 'Email' } }],
                    autoRedirect: null,
                })), { status: 200 });
            }
            throw new Error(`Unexpected Team join request: ${path}`);
        };
        runtimeFetchMock.mockImplementation(joinFetch);

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
        readStorage.mockRestore();
        await clearHomeCredentials();
        await rendered.pressByTestIdAsync('team-join-home-unavailable-action');
        await waitForTestId(rendered, 'team-auth-entry-action:email_password');
        expect(rendered.findByTestId('team-join-home-unavailable')).toBeNull();
    });
});
