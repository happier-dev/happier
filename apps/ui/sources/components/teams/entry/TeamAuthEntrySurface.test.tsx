import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { TeamAuthEntrySurface } from './TeamAuthEntrySurface';

const endpointFetch = vi.hoisted(() => vi.fn());
const authorityFetch = vi.hoisted(() => vi.fn());
const runWithServerRequestAuthorityForServerAccountScope = vi.hoisted(() => vi.fn());
const acceptTeamInvitation = vi.hoisted(() => vi.fn());

const routerReplaceSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: routerReplaceSpy, push: routerPushSpy } }).module;
});

/**
 * The account service is a separate endpoint this page never owns. Only its
 * discovery probe is replaced; the sign-in-service policy, the effective-service
 * resolution and the entry-href builder stay real.
 */
const accountServiceDiscovery = vi.hoisted(() => ({
    value: null as null | Record<string, unknown>,
}));
vi.mock('@/auth/accountDirectory/accountDirectoryAuthClient', () => ({
    accountDirectoryAuthClient: {
        discoverAuthenticationMethods: async () => accountServiceDiscovery.value
            ?? { kind: 'unavailable' },
    },
    createVerifiedAccountServiceAuthority: () => null,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(),
    createServerFetchAtEndpoint: vi.fn(() => endpointFetch),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    runWithServerRequestAuthorityForServerAccountScope,
}));

vi.mock('@/sync/ops/teams/teamInvitationOperations', () => ({
    acceptTeamInvitation,
}));

// Only the pending-error predicate is consumed here; the registration binding it
// describes is owned and proven by `teamActionClient` and its own suite.
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    isTeamActionApprovalPendingError: (value: unknown) => (
        typeof value === 'object' && value !== null && 'registration' in value
    ),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 2, fontScale: 2 }),
    });
});

vi.mock('@/assets/onboarding/planet-dark.jpg', () => ({ default: 'planet-dark.jpg' }));
vi.mock('@/assets/onboarding/planet-light.jpg', () => ({ default: 'planet-light.jpg' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

const target: HomeTargetInput = Object.freeze({
    kind: 'descriptor',
    authority: 'trusted_enrollment',
    descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_team-home',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://edge.example.test' }],
    },
});

function readyResponse(
    scope: 'team' | 'invitation' = 'team',
    currentAccountRecipientStatus?: 'already_verified' | 'verification_required',
    account?: Readonly<{ firstName: string | null; lastName: string | null; username: string | null; avatarUrl: string | null }>,
    homeDisplayName = 'Acme Home',
    actions: readonly Record<string, unknown>[] = [{
        kind: 'authenticate',
        methodId: 'home-password',
        action: 'login',
        mode: 'keyed',
        origin: 'home',
        presentation: { displayName: 'Password' },
    }, {
        kind: 'authenticate',
        methodId: 'team-oidc',
        action: 'connect',
        mode: 'either',
        origin: 'team',
        presentation: { displayName: 'Acme SSO' },
    }, ...(currentAccountRecipientStatus === 'verification_required'
        ? [{ kind: 'switch_account' }]
        : [])],
) {
    return new Response(JSON.stringify({
        v: 1,
        state: 'admission_required',
        scope: { kind: scope },
        home: { serverId: 'srv_team-home', displayName: homeDisplayName, storageMode: 'plain' },
        ...(account ? { account } : {}),
        team: {
            teamId: 'team-1',
            name: 'A very long Team name that remains fully available to assistive technology',
            logo: {
                path: '/v1/teams/team-1/logo',
                url: 'https://home.example.test/v1/teams/team-1/logo',
            },
        },
        ...(scope === 'invitation'
            ? { invitationEmailVerificationRequired }
            : {}),
        ...(entrySignInService ? { signInService: entrySignInService } : {}),
        actions,
        ...(currentAccountRecipientStatus ? { currentAccountRecipientStatus } : {}),
        ...(entryInvitationPreview ? { preview: entryInvitationPreview } : {}),
        autoRedirect: null,
    }), { status: 200 });
}

function nativeMtlsReadyResponse() {
    return readyResponse('invitation', undefined, undefined, 'Acme Home', [{
            kind: 'authenticate',
            methodId: 'mtls',
            action: 'login',
            mode: 'keyless',
            origin: 'home',
            presentation: { displayName: 'Certificate' },
        }]);
}

/**
 * The bounded preview the Home returns for an active offer. Every consequence a
 * join screen states comes from here, so a test that changes what the person is
 * agreeing to changes this fixture rather than the screen's own wording.
 */
function activePreview(overrides: Record<string, unknown> = {}) {
    return {
        home: { serverId: 'srv_team-home', displayName: 'home.example.test', storageMode: null, hosting: null },
        team: {
            teamId: 'team-1',
            name: 'A very long Team name that remains fully available to assistive technology',
            logo: null,
            accentSeed: 'team-1',
        },
        role: 'member',
        historyAccess: 'from_membership',
        state: 'active',
        expiresAt: Date.UTC(2030, 0, 1),
        recipientEmailMask: null,
        ...overrides,
    };
}

function actionIconNames(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    actionTestId: string,
): readonly string[] {
    return screen.findAllByTestId(`${actionTestId}-icon`)
        .map((node) => node.props.name)
        .filter((name): name is string => typeof name === 'string');
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const node = screen.findByTestId(testID);
        if (node) return node;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    throw new Error(`Timed out waiting for ${testID}; rendered=${screen.getTextContent()}; fetchCalls=${endpointFetch.mock.calls.length}`);
}

let entryScope: 'team' | 'invitation' = 'team';
let entrySignInService: unknown;
let previewResult: unknown;
let invitationEmailVerificationRequired = true;
let entryInvitationPreview: unknown;

/** The endpoint calls a join page makes, separated from the preview reads. */
function authEntryCalls(): unknown[][] {
    return [...endpointFetch.mock.calls, ...authorityFetch.mock.calls]
        .filter((call: unknown[]) => String(call[0]).includes('/v1/auth/entry'));
}

describe('TeamAuthEntrySurface', () => {
    beforeEach(async () => {
        standardCleanup();
        if (target.kind !== 'descriptor') throw new Error('Expected the canonical Home descriptor fixture');
        const profile = await upsertServerProfile({ serverUrl: target.descriptor.canonicalServerUrl, name: 'Acme Home' });
        await setServerProfileIdentityForUrl(profile.serverUrl, target.descriptor.homeServerIdentityId);
        await setActiveServerId(profile.id, { scope: 'device' });
        endpointFetch.mockReset();
        authorityFetch.mockReset();
        acceptTeamInvitation.mockReset();
        entryScope = 'team';
        entrySignInService = undefined;
        entryInvitationPreview = undefined;
        accountServiceDiscovery.value = null;
        routerPushSpy.mockReset();
        invitationEmailVerificationRequired = true;
        previewResult = { outcome: 'ok', preview: activePreview() };
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : readyResponse(entryScope)
        ));
        authorityFetch.mockImplementation(async () => readyResponse(entryScope));
        runWithServerRequestAuthorityForServerAccountScope.mockReset();
        // The authenticated transport records the exact Account scope its authority was bound to.
        runWithServerRequestAuthorityForServerAccountScope.mockImplementation(
            async (params: Readonly<{ scope: unknown }>, operation: (authority: unknown) => Promise<unknown>) =>
                await operation({
                    request: (path: string, init?: RequestInit) => authorityFetch(path, init, { accountScope: params.scope }),
                }),
        );
    });

    afterEach(() => standardCleanup());

    it('renders a scoped Team identity and keeps the exact Home target on action selection', async () => {
        const onSelectAction = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={onSelectAction}
                onBack={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(screen.findByTestId('team-auth-entry-shell')).toBeTruthy();
        const shell = screen.findAll((node) => node.props.testID === 'team-auth-entry-shell')
            .find((node) => 'allowMobileBrandHero' in node.props);
        expect(shell?.props.allowMobileBrandHero).toBe(false);
        expect(shell?.props.showMobileWordmark).toBe(true);
        expect(screen.findAllByTestId('unauth-shell-mobile-hero')).toHaveLength(0);
        const heading = screen.findByTestId('team-auth-entry-heading');
        expect(heading?.props.role).toBe('heading');
        expect(heading?.props.accessibilityLabel).toContain('A very long Team name');
        expect(heading?.props.numberOfLines).toBe(2);
        expect(screen.findByTestId('team-auth-entry-logo')?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findAllByTestId('team-auth-entry-account-label')).toHaveLength(0);

        await screen.pressByTestIdAsync('team-auth-entry-action:team-oidc');
        expect(onSelectAction).toHaveBeenCalledWith({
            action: expect.objectContaining({ methodId: 'team-oidc', origin: 'team' }),
            teamId: 'team-1',
            teamName: 'A very long Team name that remains fully available to assistive technology',
            teamLogo: expect.objectContaining({ url: 'https://home.example.test/v1/teams/team-1/logo' }),
            target,
        });
        expect(onSelectAction.mock.calls[0]?.[0].target).toBe(target);
        expect(endpointFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            body: JSON.stringify({ v: 1, scope: { kind: 'team', teamId: 'team-1' } }),
        }), { includeAuth: false, retry: 'none' });
    });

    it('renders native mTLS for invitation entry when the Home admits it', async () => {
        entryScope = 'invitation';
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : nativeMtlsReadyResponse()
        ));
        const onSelectAction = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token: 'M'.repeat(43) }}
                target={target}
                onSelectAction={onSelectAction}
                onAdmissionComplete={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-auth-entry-ready');
        await screen.pressByTestIdAsync('team-auth-entry-action:mtls');

        expect(onSelectAction).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({ methodId: 'mtls' }),
            teamId: 'team-1',
        }));
        // A certificate login wears the certificate glyph here for the same
        // reason it does on Welcome and the shared auth host: one owner answers
        // per execution, so the same journey never looks like two.
        expect(actionIconNames(screen, 'team-auth-entry-action:mtls')).toContain('shield-check');
    });

    it('renders each admitted authentication action with the shared entry icon', async () => {
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={vi.fn()}
                onBack={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(actionIconNames(screen, 'team-auth-entry-action:team-oidc')).toContain('sign-in');
        expect(actionIconNames(screen, 'team-auth-entry-action:home-password')).toContain('sign-in');
    });

    it('offers each Home sign-in and sign-up journey once, named by what it does, leading with New here', async () => {
        // A Home publishes `login` and `provision` per native method. Both are
        // genuinely different journeys; naming both "Continue with <method>"
        // made one invitation page show every method twice.
        entryScope = 'invitation';
        const homeAction = (methodId: string, action: string, mode: string, displayName: string) => ({
            kind: 'authenticate', methodId, action, mode, origin: 'home', presentation: { displayName },
        });
        const actions = [
            homeAction('key_challenge', 'login', 'keyed', 'Device key'),
            homeAction('key_challenge', 'provision', 'keyed', 'Device key'),
            homeAction('email_password', 'login', 'keyless', 'Email and password'),
            homeAction('email_password', 'provision', 'keyless', 'Email and password'),
        ];
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : readyResponse('invitation', undefined, undefined, 'Acme Home', actions)
        ));
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token: 'D'.repeat(43) }}
                target={target}
                onSelectAction={vi.fn()}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        const cards = screen.tree.root.findAll(
            (node) => typeof (node.props as { testID?: unknown }).testID === 'string'
                && String((node.props as { testID: string }).testID).startsWith('team-auth-entry-action:')
                && typeof (node.props as { title?: unknown }).title === 'string',
            { deep: true },
        ).map((node) => node.props as { testID: string; title: string; primary?: boolean });
        const unique = cards.filter((card, index) => cards.findIndex((other) => other.testID === card.testID) === index);
        expect(unique.map((card) => card.title)).toEqual([
            t('welcome.welcomePrimaryButton'),
            t('welcome.continueWithKey'),
            t('settingsAccount.nativePassword.title'),
            t('settingsAccount.nativePassword.createAccount'),
        ]);
        expect(unique.map((card) => card.primary === true)).toEqual([true, false, false, false]);
    });

    it('renders the provider icon hint the Home projected for a Team action', async () => {
        // The Home already sends a bounded icon hint with every Team-origin
        // provider action. Dropping it made every Team provider render the same
        // generic entry glyph, so the surface said less than the wire carried.
        const hinted = () => readyResponse('team', undefined, undefined, 'Acme Home', [{
            kind: 'authenticate',
            methodId: 'team-oidc',
            action: 'connect',
            mode: 'either',
            origin: 'team',
            presentation: { displayName: 'Acme SSO', iconHint: 'github-logo' },
        }, {
            kind: 'authenticate',
            methodId: 'team-unknown-hint',
            action: 'connect',
            mode: 'either',
            origin: 'team',
            presentation: { displayName: 'Other SSO', iconHint: 'not-an-icon-this-app-ships' },
        }]);
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : hinted()
        ));
        authorityFetch.mockImplementation(async () => hinted());
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={vi.fn()}
                onBack={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(actionIconNames(screen, 'team-auth-entry-action:team-oidc')).toContain('github-logo');
        // A hint this app has no glyph for falls back to the shared entry icon
        // rather than blanking the card.
        expect(actionIconNames(screen, 'team-auth-entry-action:team-unknown-hint')).toContain('sign-in');
    });

    it('names an accepted Team sign-in that cannot run with the Home reason, and re-asks the Home on press', async () => {
        // teams-lane-03/01 §10.2 / TA-R17: the per-provider safe unavailable reason
        // is a real wire field, so the page says it instead of dropping the choice.
        const withUnavailable = () => readyResponse('team', undefined, undefined, 'Acme Home', [{
            kind: 'provider_unavailable',
            methodId: 'team-backup',
            origin: 'team',
            presentation: { displayName: 'Backup SSO', providerKind: 'oidc' },
            reason: 'provider_setup_incomplete',
        }, {
            kind: 'authenticate',
            methodId: 'team-oidc',
            action: 'connect',
            mode: 'either',
            origin: 'team',
            presentation: { displayName: 'Acme SSO', providerKind: 'oidc', connectButtonColor: '#0f62fe', supportsProfileBadge: false },
        }]);
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : withUnavailable()
        ));
        authorityFetch.mockImplementation(async () => withUnavailable());
        const onSelectAction = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={onSelectAction}
                onBack={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-auth-entry-ready');
        const unavailable = screen.findByTestId('team-auth-entry-unavailable:team-backup');
        if (!unavailable) throw new Error('expected the unavailable Team sign-in to be named');
        expect(unavailable.props.accessibilityLabel).toBe(t('teams.entry.providerUnavailableTitle', { method: 'Backup SSO' }));
        expect(unavailable.props.accessibilityHint).toBe(t('teams.entry.providerUnavailableSetupIncomplete'));
        // The runnable choice is unaffected by the richer descriptor.
        expect(screen.findByTestId('team-auth-entry-action:team-oidc')).not.toBeNull();

        const requestsBefore = endpointFetch.mock.calls.length + authorityFetch.mock.calls.length;
        await screen.pressByTestIdAsync('team-auth-entry-unavailable:team-backup');
        await waitForTestId(screen, 'team-auth-entry-ready');
        expect(endpointFetch.mock.calls.length + authorityFetch.mock.calls.length).toBeGreaterThan(requestsBefore);
        expect(onSelectAction).not.toHaveBeenCalled();
    });

    it('admits only one action at a time and marks the selected action busy', async () => {
        let releaseAction!: () => void;
        const actionPending = new Promise<void>((resolve) => {
            releaseAction = resolve;
        });
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={() => actionPending}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        await act(async () => {
            screen.pressByTestId('team-auth-entry-action:team-oidc');
            await Promise.resolve();
        });

        expect(screen.findByTestId('team-auth-entry-action:home-password')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-auth-entry-action:team-oidc')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-auth-entry-action:team-oidc')?.props.accessibilityState?.busy).toBe(true);

        await act(async () => releaseAction());
        expect(screen.findByTestId('team-auth-entry-action:home-password')?.props.disabled).toBe(false);
    });

    it('fails a mismatched Team projection closed and retries from a polite terminal state', async () => {
        endpointFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({
                v: 1,
                state: 'admission_required',
                scope: { kind: 'team' },
                home: { serverId: 'srv_team-home', displayName: 'Acme Home', storageMode: 'plain' },
                team: { teamId: 'team-other', name: 'Other', logo: null },
                actions: [],
                autoRedirect: null,
            }), { status: 200 }))
            .mockResolvedValueOnce(readyResponse());
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onSelectAction={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-incompatible');

        const terminal = screen.findByTestId('team-auth-entry-incompatible');
        expect(terminal?.props.accessibilityLiveRegion).toBe('polite');
        expect(terminal?.props['aria-live']).toBe('polite');

        await screen.pressByTestIdAsync('team-auth-entry-incompatible-action');
        expect(await waitForTestId(screen, 'team-auth-entry-ready')).toBeTruthy();
    });

    it('says why a Team destination is unavailable, and stays non-enumerating when the Home will not say', async () => {
        endpointFetch.mockReset();
        endpointFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'sso_required',
            autoRedirect: null,
        }), { status: 200 }));
        const named = await renderScreen(
            <TeamAuthEntrySurface teamId="team-1" target={target} onSelectAction={() => {}} />,
        );
        await waitForTestId(named, 'team-auth-entry-unavailable');

        expect(named.findByTestId('team-auth-entry-unavailable-diagnostic-sso_required')).toBeTruthy();
        expect(named.getTextContent()).toContain(t('teams.entry.ssoRequiredTitle'));
        expect(named.getTextContent()).toContain(t('teams.entry.ssoRequiredBody'));

        endpointFetch.mockReset();
        endpointFetch.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'entry_not_available',
            autoRedirect: null,
        }), { status: 200 }));
        const opaque = await renderScreen(
            <TeamAuthEntrySurface teamId="team-1" target={target} onSelectAction={() => {}} />,
        );
        await waitForTestId(opaque, 'team-auth-entry-unavailable');

        expect(opaque.getTextContent()).toContain(t('teams.errors.notFound'));
        expect(opaque.getTextContent()).not.toContain(t('teams.entry.ssoRequiredTitle'));
        expect(opaque.findAllByTestId('team-auth-entry-unavailable-reason')).toHaveLength(0);
    });

    it('suppresses retry for the terminal non-enumerating entry-not-available answer', async () => {
        endpointFetch.mockReset();
        endpointFetch.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'entry_not_available',
            autoRedirect: null,
        }), { status: 200 }));
        const screen = await renderScreen(
            <TeamAuthEntrySurface teamId="team-1" target={target} onSelectAction={() => {}} />,
        );
        await waitForTestId(screen, 'team-auth-entry-unavailable');

        expect(screen.findByTestId('team-auth-entry-unavailable-action')).toBeNull();
        expect(screen.findByTestId('team-auth-entry-unavailable-secondary-action')).not.toBeNull();
    });

    it('says Teams are turned off on this Home instead of claiming the Team does not exist', async () => {
        // A capable, reachable Home with Teams administratively disabled answers
        // the non-enumerating `entry_not_available` on the entry projection and
        // its own declared `feature_unavailable` on the preview. Reading only
        // the first sent a valid invitation holder to "Team not found".
        const token = 'F'.repeat(43);
        previewResult = { outcome: 'feature_unavailable' };
        endpointFetch.mockReset();
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : new Response(JSON.stringify({
                    v: 1,
                    state: 'unavailable',
                    scope: { kind: 'invitation' },
                    reason: 'entry_not_available',
                    autoRedirect: null,
                }), { status: 200 })
        ));

        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-unavailable');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(screen.getTextContent()).toContain(t('teams.unavailable.title'));
        expect(screen.getTextContent()).toContain(t('teams.unavailable.disabled'));
        expect(screen.getTextContent()).not.toContain(t('teams.errors.notFound'));
    });

    it('offers a way out of a Team it cannot enter instead of only an endless retry', async () => {
        // Every §10 refusal ends with "or go back to your own work". A Team page
        // opened from a public link has no other exit, so the terminal card owns
        // one — the same exit the OAuth Team failure card already offers.
        routerReplaceSpy.mockClear();
        endpointFetch.mockReset();
        endpointFetch.mockResolvedValue(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'sso_required',
            autoRedirect: null,
        }), { status: 200 }));
        const screen = await renderScreen(
            <TeamAuthEntrySurface teamId="team-1" target={target} onSelectAction={() => {}} />,
        );
        await waitForTestId(screen, 'team-auth-entry-unavailable');

        expect(screen.getTextContent()).toContain(t('teams.entry.returnToHappier'));
        await screen.pressByTestIdAsync('team-auth-entry-unavailable-secondary-action');

        expect(routerReplaceSpy).toHaveBeenCalledWith('/');
    });

    it('offers an already-admitted member continuation instead of another sign-in', async () => {
        const accountScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-1' });
        authorityFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'already_member',
            scope: { kind: 'team' },
            home: { serverId: 'srv_team-home', displayName: 'Acme Home', storageMode: 'plain' },
            account: { firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null },
            team: { teamId: 'team-1', name: 'Acme', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        }), { status: 200 }));
        const onContinue = vi.fn();
        const onSelectAction = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                accountScope={accountScope}
                onContinue={onContinue}
                onSelectAction={onSelectAction}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        // The projection is asked for as this exact Account, not anonymously.
        expect(authorityFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.anything(), { accountScope });
        expect(endpointFetch).not.toHaveBeenCalled();
        expect(screen.findAllByTestId('team-auth-entry-action:home-password')).toHaveLength(0);
        expect(screen.findByTestId('team-auth-entry-account-label')?.props.children)
            .toBe('Signed in as Alice Chen');

        await screen.pressByTestIdAsync('team-auth-entry-continue');
        expect(onContinue).toHaveBeenCalledTimes(1);
        expect(onSelectAction).not.toHaveBeenCalled();
    });

    it('renders the authenticated Account on admission and updates it when the exact scope changes', async () => {
        authorityFetch
            .mockResolvedValueOnce(readyResponse('team', undefined, {
                firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null,
            }))
            .mockResolvedValueOnce(readyResponse('team', undefined, {
                firstName: 'Bob', lastName: null, username: 'bob', avatarUrl: null,
            }));
        const firstScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-alice' });
        const secondScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-bob' });
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                accountScope={firstScope}
                onContinue={() => {}}
                onSelectAction={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-account-label');
        expect(screen.findByTestId('team-auth-entry-account-label')?.props.children)
            .toBe('Signed in as Alice Chen');

        await screen.update(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                accountScope={secondScope}
                onContinue={() => {}}
                onSelectAction={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-account-label');
        expect(screen.findByTestId('team-auth-entry-account-label')?.props.children)
            .toBe('Signed in as Bob');
    });

    it('keeps a member on ordinary admission when the Home does not project continuation', async () => {
        authorityFetch.mockResolvedValueOnce(readyResponse());
        const onContinue = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                accountScope={{ serverId: 'srv_team-home', accountId: 'account-1' }}
                onContinue={onContinue}
                onSelectAction={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(screen.findAllByTestId('team-auth-entry-continue')).toHaveLength(0);
        expect(screen.findByTestId('team-auth-entry-action:team-oidc')).toBeTruthy();
        expect(onContinue).not.toHaveBeenCalled();
    });

    it('offers the admitted authentication methods before an invitation has an Account scope', async () => {
        entryScope = 'invitation';
        const onSelectAction = vi.fn();
        const token = 'A'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token }}
                target={target}
                onSelectAction={onSelectAction}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
        expect(await waitForTestId(screen, 'team-join-preview')).toBeTruthy();
        expect(screen.getTextContent()).toContain(t('teams.entry.readyStatus'));
        expect(endpointFetch).toHaveBeenCalledWith('/v1/team-invitations/preview', expect.objectContaining({
            body: JSON.stringify({ v: 1, token }),
        }), { includeAuth: false, retry: 'none' });
        await screen.pressByTestIdAsync('team-auth-entry-action:home-password');
        expect(onSelectAction).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({ methodId: 'home-password', origin: 'home' }),
            invitationEmailVerificationRequired: true,
        }));
    });

    it('keeps addressed invitation provisioning distinct from transferable mailbox proof', async () => {
        entryScope = 'invitation';
        invitationEmailVerificationRequired = false;
        previewResult = {
            outcome: 'ok',
            preview: activePreview({ recipientEmailMask: 'p•••@example.test' }),
        };
        const onSelectAction = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token: 'F'.repeat(43) }}
                target={target}
                onSelectAction={onSelectAction}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        await waitForTestId(screen, 'team-join-preview');

        await screen.pressByTestIdAsync('team-auth-entry-action:home-password');

        expect(onSelectAction).toHaveBeenCalledWith(expect.objectContaining({
            invitationEmailVerificationRequired: false,
        }));
    });

    it('renders the Home name from the auth-entry projection instead of the preview or target URL', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({
                home: { serverId: 'srv_team-home', displayName: 'Stale Preview Home', storageMode: null },
            }),
        };
        endpointFetch.mockImplementation(async (path: string) => (
            String(path).includes('/team-invitations/preview')
                ? new Response(JSON.stringify(previewResult), { status: 200 })
                : readyResponse('invitation', undefined, undefined, 'Canonical Acme Home')
        ));
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token: 'N'.repeat(43) }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );

        await waitForTestId(screen, 'team-join-preview');
        expect(screen.getTextContent()).toContain('Canonical Acme Home');
        expect(screen.getTextContent()).not.toContain('Stale Preview Home');
        expect(screen.getTextContent()).not.toContain('edge.example.test');
    });

    it('accepts an existing-Account invitation only after explicit Join confirmation', async () => {
        entryScope = 'invitation';
        acceptTeamInvitation.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { outcome: 'joined', teamId: 'team-1' },
        });
        const onAdmissionComplete = vi.fn();
        const accountScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-1' });
        const token = 'A'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token, accountScope }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={onAdmissionComplete}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(acceptTeamInvitation).not.toHaveBeenCalled();
        expect(authorityFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.anything(), { accountScope });

        // The consequences of joining are stated before the confirmation exists.
        await waitForTestId(screen, 'team-join-preview');
        expect(screen.findByTestId('team-join-preview-role')).toBeTruthy();
        expect(screen.findByTestId('team-join-preview-history')).toBeTruthy();
        expect(screen.findByTestId('team-join-preview-expiry')).toBeTruthy();
        // Signed in and ready to join: the guidance names that state, never another sign-in.
        expect(screen.getTextContent()).toContain(t('teams.entry.readyToJoinStatus'));
        expect(screen.getTextContent()).not.toContain(t('teams.entry.readyStatus'));

        await screen.pressByTestIdAsync('team-auth-entry-join');
        expect(acceptTeamInvitation).toHaveBeenCalledWith(expect.objectContaining({
            scope: accountScope,
            admission: { token },
        }));

        // Success does not navigate on the person's behalf: opening the Team is
        // an explicit transition they choose from the success state.
        await waitForTestId(screen, 'team-auth-entry-admission-complete');
        expect(onAdmissionComplete).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        expect(onAdmissionComplete).toHaveBeenCalledWith({ outcome: 'joined', teamId: 'team-1' });
    });

    it('requires explicit Join for a server-held post-auth invitation continuation', async () => {
        entryScope = 'invitation';
        entryInvitationPreview = activePreview({ role: 'guest', recipientEmailMask: 'i•••@example.test' });
        authorityFetch.mockImplementation(async () => readyResponse('invitation', 'verification_required'));
        acceptTeamInvitation.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { outcome: 'joined', teamId: 'team-1' },
        });
        const accountScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-1' });
        const continuation = Object.freeze({
            v: 1 as const,
            kind: 'post_auth_invitation' as const,
            reference: 'oauth_pending_exact_1',
            teamId: 'team-1',
        });
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ continuation, accountScope }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
                onRecoverIdentity={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-join-preview')).not.toBeNull();
        expect(screen.findByTestId('team-auth-entry-use-another-account')).not.toBeNull();
        expect(screen.getTextContent()).toContain('i•••@example.test');
        const entryRequest = JSON.parse(authorityFetch.mock.calls[0]?.[1]?.body as string);
        expect(entryRequest.scope).toEqual({ kind: 'invitation', continuation });

        await screen.pressByTestIdAsync('team-auth-entry-join');
        expect(acceptTeamInvitation).toHaveBeenCalledWith(expect.objectContaining({
            scope: accountScope,
            admission: { continuation },
        }));
    });

    it.each([undefined, 'expired'] as const)('withholds held-continuation Join without an active offer (%s)', async (state) => {
        entryScope = 'invitation';
        entryInvitationPreview = state ? activePreview({ state }) : undefined;
        const screen = await renderScreen(<TeamAuthEntrySurface
            invitation={{
                continuation: { v: 1, kind: 'post_auth_invitation', reference: 'oauth_pending_exact_1', teamId: 'team-1' },
                accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
            }}
            target={target}
            onSelectAction={() => {}}
            onAdmissionComplete={() => {}}
        />);
        await waitForTestId(screen, 'team-auth-entry-ready');
        expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
    });

    it.each([200, 404] as const)('does not infer an old Home from an unreadable preview (%s)', async (status) => {
        entryScope = 'invitation';
        endpointFetch.mockImplementation(async (path: string) => String(path).includes('/team-invitations/preview')
            ? new Response(JSON.stringify({ malformed: true }), { status })
            : readyResponse('invitation'));
        const screen = await renderScreen(<TeamAuthEntrySurface
            invitation={{ token: 'G'.repeat(43), accountScope: { serverId: 'srv_team-home', accountId: 'account-1' } }}
            target={target}
            onSelectAction={() => {}}
            onAdmissionComplete={() => {}}
        />);
        await waitForTestId(screen, 'team-auth-entry-ready');
        expect(screen.getTextContent()).not.toContain(t('teams.join.updateRequiredTitle'));
        expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
    });

    it('offers explicit current-Account attachment or Account switching before accepting an addressed invitation', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({ recipientEmailMask: 'p•••@example.test' }),
        };
        authorityFetch.mockResolvedValueOnce(readyResponse('invitation', 'verification_required'));
        const onRecoverIdentity = vi.fn();
        const accountScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-1' });
        const token = 'G'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token, accountScope }}
                target={target}
                onSelectAction={() => {}}
                onRecoverIdentity={onRecoverIdentity}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        await waitForTestId(screen, 'team-join-preview');

        expect(authorityFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.anything(), { accountScope });
        expect(screen.findByTestId('team-auth-entry-join')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Join with this Account');
        expect(screen.getTextContent())
            .toContain('p•••@example.test will be added as a verified address on this Account.');
        expect(screen.findByTestId('team-auth-entry-use-another-account')).toBeTruthy();
        expect(acceptTeamInvitation).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('team-auth-entry-use-another-account');
        expect(onRecoverIdentity).toHaveBeenCalledTimes(1);
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
    });

    it('accepts the explicit current-Account choice and lets the Home attach the addressed mailbox atomically', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({ recipientEmailMask: 'p•••@example.test' }),
        };
        authorityFetch.mockResolvedValueOnce(readyResponse('invitation', 'verification_required'));
        acceptTeamInvitation.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { outcome: 'joined', teamId: 'team-1' },
        });
        const accountScope = Object.freeze({ serverId: 'srv_team-home', accountId: 'account-1' });
        const token = 'J'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token, accountScope }}
                target={target}
                onSelectAction={() => {}}
                onRecoverIdentity={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-join');

        await screen.pressByTestIdAsync('team-auth-entry-join');

        expect(acceptTeamInvitation).toHaveBeenCalledWith(expect.objectContaining({
            scope: accountScope,
            admission: { token },
        }));
        expect(await waitForTestId(screen, 'team-auth-entry-admission-complete')).toBeTruthy();
    });

    // The deferred admission approval runs on the real approval lifecycle in
    // `TeamAuthEntrySurface.approval.test.tsx`.

    it('offers recovery back to the current Account without accepting the invitation', async () => {
        entryScope = 'invitation';
        const onUseCurrentAccount = vi.fn();
        const token = 'U'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{ token }}
                target={target}
                onSelectAction={() => {}}
                onUseCurrentAccount={onUseCurrentAccount}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-use-current-account');

        await screen.pressByTestIdAsync('team-auth-entry-use-current-account');

        expect(onUseCurrentAccount).toHaveBeenCalledTimes(1);
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
    });

    it('opens an invitation Team directly when the authenticated producer proves effective membership', async () => {
        entryScope = 'invitation';
        authorityFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'already_member',
            scope: { kind: 'invitation' },
            home: { serverId: 'srv_team-home', displayName: 'Acme Home', storageMode: 'plain' },
            account: { firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null },
            team: { teamId: 'team-1', name: 'Acme Team', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        }), { status: 200 }));
        const onAdmissionComplete = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'K'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={onAdmissionComplete}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-continue');

        expect(screen.getTextContent()).toContain('Open Acme Team');
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('team-auth-entry-continue');
        expect(onAdmissionComplete).toHaveBeenCalledWith({ outcome: 'already_member', teamId: 'team-1' });
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
    });

    it('keeps matching-address invitation acceptance concise', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({ recipientEmailMask: 'p•••@example.test' }),
        };
        authorityFetch.mockResolvedValueOnce(readyResponse('invitation', 'already_verified'));
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'H'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onRecoverIdentity={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        expect(screen.findByTestId('team-auth-entry-join')).toBeTruthy();
        expect(screen.findAllByTestId('team-auth-entry-join-subtitle')).toHaveLength(0);
        expect(screen.findAllByTestId('team-auth-entry-use-another-account')).toHaveLength(0);
    });

    it('withholds the confirmation and states the reason for a terminal invitation', async () => {
        entryScope = 'invitation';
        previewResult = { outcome: 'ok', preview: activePreview({ state: 'revoked' }) };
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'D'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-join-preview-terminal-revoked');

        // Confirming something the Home has already retired would burn a press on
        // an answer the preview already gave.
        expect(screen.findByTestId('team-auth-entry-join')).toBeNull();
        expect(acceptTeamInvitation).not.toHaveBeenCalled();
        // The preview explains the retired link; the page does not also ask the signed-in person to sign in.
        expect(screen.getTextContent()).not.toContain(t('teams.entry.readyStatus'));
    });

    it('states the Guest restriction and the plain-storage disclosure the Home published', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({
                role: 'guest',
                home: { serverId: 'srv_team-home', displayName: 'home.example.test', storageMode: 'plain', hosting: null },
                recipientEmailMask: 'a\u2026e@example.test',
            }),
        };
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'E'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-join-preview');

        expect(screen.findByTestId('team-join-preview-guest')).toBeTruthy();
        expect(screen.findByTestId('team-join-preview-storage')).toBeTruthy();
        expect(screen.findByTestId('team-join-preview-recipient')).toBeTruthy();
        expect(screen.findByTestId('team-auth-entry-join')).toBeTruthy();
        // Hosting was not published, so nothing is asserted about it.
        expect(screen.findByTestId('team-join-preview-hosting')).toBeNull();
    });

    it('offers another Account on a Team page when the Home says the current one is wrong', async () => {
        // Outside an invitation the surface had no way to act on the Home's
        // switch offer, so somebody signed in as the wrong Account was shown a
        // list of sign-in methods their current credential had already used.
        entryScope = 'team';
        const onRecoverIdentity = vi.fn();
        endpointFetch.mockImplementation(async () => readyResponse('team', undefined, undefined, 'Acme Home', [{
            kind: 'authenticate',
            methodId: 'home-password',
            action: 'login',
            mode: 'keyed',
            origin: 'home',
            presentation: { displayName: 'Password' },
        }, { kind: 'switch_account' }]));
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                teamId="team-1"
                target={target}
                onRecoverIdentity={onRecoverIdentity}
                onSelectAction={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');

        await screen.pressByTestIdAsync('team-auth-entry-use-another-account');
        expect(onRecoverIdentity).toHaveBeenCalledOnce();
    });

    it('states the personal-hosting consequence only when the Home published that purpose', async () => {
        entryScope = 'invitation';
        previewResult = {
            outcome: 'ok',
            preview: activePreview({
                home: { serverId: 'srv_team-home', displayName: 'home.example.test', storageMode: null, hosting: 'personal' },
            }),
        };
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'F'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-join-preview');

        // A Personal Home runs on somebody's own computer, so it can be offline
        // when this person tries to work. That is a consequence of joining, and
        // the Home publishes it as a runtime purpose rather than leaving the
        // joiner to guess it from the address.
        expect(screen.findByTestId('team-join-preview-hosting')).toBeTruthy();
    });

    it('keeps invitation terminal outcomes distinct and never admits through another Home scope', async () => {
        entryScope = 'invitation';
        acceptTeamInvitation.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { outcome: 'revoked' },
        });
        const token = 'B'.repeat(43);
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token,
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        await screen.pressByTestIdAsync('team-auth-entry-join');
        expect(screen.findByTestId('team-auth-entry-admission-revoked')).toBeTruthy();
        const authEntriesBeforeMismatchedScope = authEntryCalls().length;

        standardCleanup();
        const mismatched = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token,
                    accountScope: { serverId: 'another-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(mismatched, 'team-auth-entry-unavailable');
        expect(authEntryCalls()).toHaveLength(authEntriesBeforeMismatchedScope);
        expect(acceptTeamInvitation).toHaveBeenCalledTimes(1);
    });

    it('recovers from an admission result that names a different Team by reloading the exact entry', async () => {
        entryScope = 'invitation';
        acceptTeamInvitation.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { outcome: 'joined', teamId: 'team-other' },
        });
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'M'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        await screen.pressByTestIdAsync('team-auth-entry-join');

        expect(screen.findByTestId('team-auth-entry-admission-incompatible-action')).toBeTruthy();
        const requestsBeforeRetry = authEntryCalls().length;
        await screen.pressByTestIdAsync('team-auth-entry-admission-incompatible-action');
        await waitForTestId(screen, 'team-auth-entry-ready');
        expect(authEntryCalls().length).toBeGreaterThan(requestsBeforeRetry);
        expect(acceptTeamInvitation).toHaveBeenCalledTimes(1);
    });

    it('retries an outcome-unknown invitation acceptance without requiring a second Join confirmation', async () => {
        entryScope = 'invitation';
        acceptTeamInvitation
            .mockResolvedValueOnce({
                kind: 'failed',
                // The write left this client, so the shared Home transport
                // deliberately refuses to call it generically retryable. This
                // screen can offer the same accept again only because the
                // invitation owner proves a committed first request re-enters
                // as `already_member` for this authenticated Account.
                failure: { kind: 'outcome_unknown', retryable: false, code: null },
            })
            .mockResolvedValueOnce({
                kind: 'succeeded',
                value: { outcome: 'already_member', teamId: 'team-1' },
            });
        const onAdmissionComplete = vi.fn();
        const screen = await renderScreen(
            <TeamAuthEntrySurface
                invitation={{
                    token: 'C'.repeat(43),
                    accountScope: { serverId: 'srv_team-home', accountId: 'account-1' },
                }}
                target={target}
                onSelectAction={() => {}}
                onAdmissionComplete={onAdmissionComplete}
            />,
        );
        await waitForTestId(screen, 'team-auth-entry-ready');
        await screen.pressByTestIdAsync('team-auth-entry-join');
        const unknown = await waitForTestId(screen, 'team-auth-entry-admission-failure-outcome_unknown');
        expect(unknown.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('We could not confirm whether you joined');
        await screen.pressByTestIdAsync('team-auth-entry-admission-failure-outcome_unknown-action');

        expect(acceptTeamInvitation).toHaveBeenCalledTimes(2);
        await waitForTestId(screen, 'team-auth-entry-admission-complete');
        await screen.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        expect(onAdmissionComplete).toHaveBeenCalledWith({
            outcome: 'already_member',
            teamId: 'team-1',
        });
    });

    describe('account-service sign-in handoff', () => {
        const service = {
            kind: 'supported_account_service',
            endpointUrl: 'https://accounts.example.test',
            serverIdentityId: 'srv_accounts',
            canonicalServerUrl: 'https://accounts.example.test',
            capability: {},
            keyLoginAvailable: true,
            oauthProviderIds: [],
            preferredProvisionProviderId: null,
            authenticationCatalog: { methods: [] },
            authenticationActions: [],
            accountServiceDisplayName: 'Acme Accounts',
            snapshot: { status: 'ready' },
        };

        it('hands off to the Home-named account service instead of offering only local methods', async () => {
            entrySignInService = {
                v: 1,
                mode: 'external',
                endpoint: 'https://accounts.example.test',
                expectedServerIdentityId: 'srv_accounts',
            };
            accountServiceDiscovery.value = service;
            const screen = await renderScreen(
                <TeamAuthEntrySurface target={target} teamId="team-1" onSelectAction={vi.fn()} />,
            );
            await waitForTestId(screen, 'team-auth-entry-account-service');
            expect(screen.findByTestId('team-auth-entry-sign-in-service-origin')).toBeTruthy();
            expect(screen.getTextContent()).toContain('Acme Accounts');
            const card = screen.tree.root.findAll(
                (node) => (node.props as { testID?: unknown }).testID === 'team-auth-entry-account-service'
                    && typeof (node.props as { title?: unknown }).title === 'string',
                { deep: true },
            ).at(0)?.props as { title: string; onPress: () => void };
            expect(card.title).toBe(t('teams.entry.continueWith', { method: 'Acme Accounts' }));

            await act(async () => { card.onPress(); });
            expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({
                pathname: '/homes/sign-in',
            }));
            // The Home's own methods stay available; the handoff is an addition,
            // never a narrowing of what this page offers.
            expect(screen.findByTestId('team-auth-entry-action:home-password')).toBeTruthy();
        });

        it('says the Home-named account service is unreachable instead of silently offering nothing, and retries it', async () => {
            entrySignInService = {
                v: 1,
                mode: 'external',
                endpoint: 'https://accounts.example.test',
                expectedServerIdentityId: 'srv_accounts',
            };
            // The Home still names the service; only the service's own probe fails.
            accountServiceDiscovery.value = {
                kind: 'endpoint_unavailable',
                endpointUrl: 'https://accounts.example.test',
                reason: 'probe_failed',
            };
            const screen = await renderScreen(
                <TeamAuthEntrySurface target={target} teamId="team-1" onSelectAction={vi.fn()} />,
            );
            await waitForTestId(screen, 'team-auth-entry-account-service-unavailable');
            expect(screen.findByTestId('team-auth-entry-sign-in-service-origin')).toBeTruthy();
            expect(screen.getTextContent()).toContain('accounts.example.test');
            // The Home's own methods stay available beside the statement.
            expect(screen.findByTestId('team-auth-entry-action:home-password')).toBeTruthy();

            const notice = screen.tree.root.findAll(
                (node) => (node.props as { testID?: unknown }).testID === 'team-auth-entry-account-service-unavailable'
                    && typeof (node.props as { onPress?: unknown }).onPress === 'function',
                { deep: true },
            ).at(0)?.props as { title: string; onPress: () => void };
            expect(notice.title).toBe(t('welcome.signInServiceUnavailableTitle'));

            accountServiceDiscovery.value = service;
            await act(async () => { notice.onPress(); });
            await waitForTestId(screen, 'team-auth-entry-account-service');
        });

        it('offers no handoff when the Home signs Accounts in itself', async () => {
            entrySignInService = { v: 1, mode: 'self' };
            accountServiceDiscovery.value = service;
            const screen = await renderScreen(
                <TeamAuthEntrySurface target={target} teamId="team-1" onSelectAction={vi.fn()} />,
            );
            await waitForTestId(screen, 'team-auth-entry-action:home-password');
            expect(screen.findByTestId('team-auth-entry-account-service')).toBeNull();
            expect(screen.findByTestId('team-auth-entry-sign-in-service-origin')).toBeNull();
        });
    });
});
