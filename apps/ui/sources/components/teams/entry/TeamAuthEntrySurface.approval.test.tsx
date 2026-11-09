import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams/invitation';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    installDisconnectedServerSocketBoundary,
    restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit';

/**
 * A deferred invitation admission, end to end.
 *
 * Accepting an invitation is a dangerous, deferred, result-required intent, so an
 * explicit UI-approval requirement produces a durable approval request instead of
 * a join. The real surface asks the shared Action front door, which persists an
 * open approval in the Home's stateful Artifact store; the Inbox decides it
 * through the generic executor, whose replay is the one admission on the Home;
 * and the surface settles only through the real approval reader and the
 * continuation its own operation registered. The network, the credential store,
 * navigation, the separate account-service discovery probe and the platform view
 * layer are the replaced boundaries.
 */

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

/** The account service is a separate endpoint this page never owns; it publishes nothing here. */
vi.mock('@/auth/accountDirectory/accountDirectoryAuthClient', () => ({
    accountDirectoryAuthClient: {
        discoverAuthenticationMethods: async () => ({ kind: 'unavailable' }),
    },
    createVerifiedAccountServiceAuthority: () => null,
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

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();

const ACCOUNT_ID = 'account-1';
const SERVER_IDENTITY_ID = 'srv_team-home';
const TOKEN = 'P'.repeat(43);
const ENTRY_PATH = '/v1/auth/entry';
const PREVIEW_PATH = '/v1/team-invitations/preview';
const ACCEPT_PATH = '/v1/team-invitations/accept';
const ACCEPT_PREPARE_PATH = '/v1/team-invitations/accept/prepare-approval';

const PREVIEW = {
    home: { serverId: SERVER_IDENTITY_ID, displayName: 'Acme Home', storageMode: 'plain', hosting: null },
    team: { teamId: 'team-1', name: 'Platform', logo: null, accentSeed: 'team-1' },
    role: 'member',
    historyAccess: 'from_membership',
    state: 'active',
    expiresAt: Date.UTC(2030, 0, 1),
    recipientEmailMask: null,
} as const;

/** The Home's admission projection for this invitation, for the signed-in Account. */
const INVITATION_ENTRY = {
    v: 1,
    state: 'admission_required',
    scope: { kind: 'invitation' },
    home: { serverId: SERVER_IDENTITY_ID, displayName: 'Acme Home', storageMode: 'plain' },
    team: { teamId: 'team-1', name: 'Platform', logo: null },
    invitationEmailVerificationRequired: true,
    actions: [{
        kind: 'authenticate',
        methodId: 'home-password',
        action: 'login',
        mode: 'keyed',
        origin: 'home',
        presentation: { displayName: 'Password' },
    }],
    autoRedirect: null,
} as const;

/** The bearer-free continuation the Home prepares before a deferred accept is persisted. */
const PREPARED_ACCEPT = {
    outcome: 'ok',
    continuation: {
        v: 1,
        kind: 'post_auth_invitation',
        reference: 'continuation-reference-1',
        teamId: 'team-1',
    },
    preview: { ...PREVIEW, home: { serverId: SERVER_IDENTITY_ID, displayName: 'Acme Home', storageMode: 'plain' } },
} as const;

/** One saved Team Home that publishes its portable identity; its Account requires approval to accept. */
async function addTeamHome(requireApproval = true): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Acme Home',
        serverUrl: 'https://team-home.example',
        serverIdentityId: SERVER_IDENTITY_ID,
        accountId: ACCOUNT_ID,
        teamsEnabled: true,
    });
    if (requireApproval) await harness.requireUiApproval(serverId, 'teams.invitations.accept');
    harness.answer(serverId, ENTRY_PATH, { body: INVITATION_ENTRY });
    harness.answer(serverId, PREVIEW_PATH, { body: { outcome: 'ok', preview: PREVIEW } });
    harness.answer(serverId, ACCEPT_PREPARE_PATH, { body: PREPARED_ACCEPT });
    harness.answer(serverId, ACCEPT_PATH, { body: { outcome: 'joined', teamId: 'team-1' } });
    return serverId;
}

async function renderJoin(serverId: string, onAdmissionComplete: (result: TeamInvitationAcceptResultV1) => void) {
    const target: HomeTargetInput = { kind: 'saved_profile', profileRef: serverId };
    // The join screen passes the credential-scope binding's Account scope, which
    // names an identity-bearing Home by its scope id (its published identity).
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const accountScope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: ACCOUNT_ID };
    const screen = await renderScreen(
        <TeamAuthEntrySurface
            invitation={{ token: TOKEN, accountScope }}
            target={target}
            onSelectAction={() => {}}
            onAdmissionComplete={onAdmissionComplete}
        />,
    );
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-join'), JSON.stringify({
        text: screen.getTextContent(),
        requests: harness.requests.map((request) => [request.path, request.token !== null]),
    })).not.toBeNull());
    return screen;
}

/** The ids of the approvals the Home persisted, in creation order. */
function approvalIds(serverId: string): string[] {
    return harness.artifacts(serverId).list().map((row) => row.id);
}

// Load real screen owners after boundary setup, outside behavior deadlines.
const { TeamAuthEntrySurface } = await import('./TeamAuthEntrySurface');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TeamJoinScreen } = await import('@/components/teams/join/TeamJoinScreen');

let restoredAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('TeamAuthEntrySurface deferred admission approval', () => {
    beforeEach(async () => {
        await harness.reset();
    });

    afterEach(async () => {
        standardCleanup();
        await restoredAccount?.dispose();
        restoredAccount = undefined;
    });

    it.each(['token', 'continuation'] as const)('retains the admitted draft across credential rebinding and refuses a stale save without accepting again (%s)', async authority => {
        const serverId = await addTeamHome(false);
        if (authority === 'continuation') {
            harness.answer(serverId, ENTRY_PATH, { body: { ...INVITATION_ENTRY, preview: PREPARED_ACCEPT.preview } });
        }
        restoredAccount = await restoreServerAccountForTest({
            serverUrl: 'https://team-home.example',
            serverIdentityId: SERVER_IDENTITY_ID,
            accountId: ACCOUNT_ID,
            request: harness.request,
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getCurrentAuth } = await import('@/auth/context/currentAuth');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        storage.setState({ profileScope: { serverId: SERVER_IDENTITY_ID, accountId: ACCOUNT_ID } });
        storage.getState().applyProfile({ ...profileDefaults, id: ACCOUNT_ID, name: null });
        const renderEntry = (credentials: AuthCredentials) => (
            <InjectedAuthProvider credentials={credentials}>
                {authority === 'continuation'
                    ? <TeamJoinScreen postAuthContinuation={PREPARED_ACCEPT.continuation} homeTarget={SERVER_IDENTITY_ID} />
                    : <TeamJoinScreen token={TOKEN} homeTarget={SERVER_IDENTITY_ID} />}
            </InjectedAuthProvider>
        );
        const screen = await renderScreen(renderEntry(restoredAccount.credentials));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-join')).not.toBeNull());
        await screen.pressByTestIdAsync('team-auth-entry-join');
        const fieldId = 'team-auth-entry-admission-complete-name-field';
        await waitForHomeGovernance(() => expect(screen.findByTestId(fieldId)).not.toBeNull());
        await act(async () => screen.changeTextByTestId(fieldId, '  Draft must stay  '));
        const entryReads = harness.requestsFor(ENTRY_PATH).length;
        // After admission this bearer has been consumed. A fresh entry read can
        // only retire the success UI; it cannot reconstruct its local draft.
        harness.answer(serverId, ENTRY_PATH, { body: {
            v: 1, state: 'unavailable', scope: { kind: 'invitation' }, reason: 'entry_not_available',
        } });
        harness.answer(serverId, 'GET /v1/account/profile', { body: { id: 'account-b', name: 'Grace' } });
        const bindingReadStarted = createDeferred<void>();
        const releaseBindingRead = createDeferred<void>();
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (...args) => {
            const credentials = await readCredentials(...args);
            if (credentials && parseToken(credentials.token) === 'account-b') {
                bindingReadStarted.resolve(undefined);
                await releaseBindingRead.promise;
            }
            return credentials;
        });
        let switching: Promise<void> | undefined;
        try {
            await act(async () => {
                switching = harness.switchAccount(serverId, 'account-b');
                await bindingReadStarted.promise;
            });
            // Secure storage may take a whole rendered frame to resolve. The
            // caller must not replace the admission owner during that interval.
            expect(screen.findByTestId(fieldId)?.props.value).toBe('  Draft must stay  ');
        } finally {
            await act(async () => {
                releaseBindingRead.resolve(undefined);
                await switching;
                storage.setState({ profileScope: { serverId: SERVER_IDENTITY_ID, accountId: 'account-b' } });
                storage.getState().applyProfile({ ...profileDefaults, id: 'account-b', name: 'Grace' });
            });
            credentialRead.mockRestore();
        }
        const replacement = await TokenStorage.getCredentialsForServerUrl('https://team-home.example', { serverId });
        expect(replacement).not.toBeNull();
        await screen.update(renderEntry(replacement!));

        expect(getActiveServerAccountScope()).toEqual({ serverId: SERVER_IDENTITY_ID, accountId: 'account-b' });
        expect(parseToken(getCurrentAuth()!.credentials!.token)).toBe('account-b');
        expect(screen.findByTestId(fieldId)?.props.value).toBe('  Draft must stay  ');
        await screen.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        await waitForHomeGovernance(() => expect(screen.findByTestId(`${fieldId}.error`)).not.toBeNull());
        expect(screen.findByTestId(fieldId)?.props.value).toBe('  Draft must stay  ');
        expect(harness.requestsFor('/v1/account/profile').filter(request => request.input !== null)).toHaveLength(0);
        expect(storage.getState().profile).toMatchObject({ id: 'account-b', name: 'Grace' });
        expect(harness.requestsFor(ENTRY_PATH)).toHaveLength(entryReads);
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(1);
    });

    it.each(['invitation', 'Home'] as const)('retires completed admission when the destination %s changes', async changed => {
        const serverId = await addTeamHome(false);
        const screen = await renderJoin(serverId, () => {});
        await screen.pressByTestIdAsync('team-auth-entry-join');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-complete')).not.toBeNull());

        let nextServerId = serverId;
        if (changed === 'Home') {
            await act(async () => {
                nextServerId = await harness.addHome({
                    name: 'Second Home',
                    serverUrl: 'https://second-home.example',
                    serverIdentityId: 'srv_second-home',
                    accountId: ACCOUNT_ID,
                    teamsEnabled: true,
                    active: false,
                });
            });
        }
        if (changed === 'Home') {
            harness.answer(nextServerId, ENTRY_PATH, { body: {
                ...INVITATION_ENTRY,
                home: { ...INVITATION_ENTRY.home, serverId: 'srv_second-home' },
            } });
            harness.answer(nextServerId, PREVIEW_PATH, { body: { outcome: 'ok', preview: {
                ...PREVIEW,
                home: { ...PREVIEW.home, serverId: 'srv_second-home' },
            } } });
        }
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        await screen.update(
            <TeamAuthEntrySurface
                target={{ kind: 'saved_profile', profileRef: nextServerId }}
                invitation={{
                    token: changed === 'invitation' ? 'Q'.repeat(43) : TOKEN,
                    accountScope: { serverId: resolveServerProfileScopeIdForIdentifier(nextServerId), accountId: ACCOUNT_ID },
                }}
                onSelectAction={() => {}}
                onAdmissionComplete={() => {}}
            />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-join')).not.toBeNull());
        expect(screen.findByTestId('team-auth-entry-admission-complete')).toBeNull();
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(1);
    });

    it('registers the deferred admission instead of stranding the invitation', async () => {
        const serverId = await addTeamHome();
        const screen = await renderJoin(serverId, () => {});

        await screen.pressByTestIdAsync('team-auth-entry-join');

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-approval')).not.toBeNull());
        expect(approvalIds(serverId)).toHaveLength(1);
        const stored = JSON.parse(harness.artifacts(serverId).readPlainBody(approvalIds(serverId)[0]!)!) as Record<string, unknown>;
        expect(stored).toMatchObject({ status: 'open', actionId: 'teams.invitations.accept' });
        // The durable request never carries the bearer.
        expect(JSON.stringify(stored)).not.toContain(TOKEN);
        // Nobody is admitted before the decision, and Join is withheld while this
        // same request is unresolved, so one admission cannot be asked for twice.
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(0);
        expect(screen.findAllByTestId('team-auth-entry-join')).toHaveLength(0);
    });

    it('settles an approved admission with the Home answer without redispatching it', async () => {
        const serverId = await addTeamHome();
        const onAdmissionComplete = vi.fn();
        const screen = await renderJoin(serverId, onAdmissionComplete);
        await screen.pressByTestIdAsync('team-auth-entry-join');
        await waitForHomeGovernance(() => expect(approvalIds(serverId)).toHaveLength(1));

        await expect(decideApprovalAsInbox(serverId, approvalIds(serverId)[0]!, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-complete')).not.toBeNull());
        // The Home admitted them once, through the Inbox's replay; settling must
        // never repeat the intent.
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(1);
        expect(onAdmissionComplete).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('team-auth-entry-admission-complete-action');
        expect(onAdmissionComplete).toHaveBeenCalledWith({ outcome: 'joined', teamId: 'team-1' });
    });

    it('keeps the same invitation retryable after its approval is refused', async () => {
        const serverId = await addTeamHome();
        const screen = await renderJoin(serverId, () => {});
        await screen.pressByTestIdAsync('team-auth-entry-join');
        await waitForHomeGovernance(() => expect(approvalIds(serverId)).toHaveLength(1));

        await expect(decideApprovalAsInbox(serverId, approvalIds(serverId)[0]!, 'reject')).resolves.toMatchObject({ ok: true });

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-approval-refused')).not.toBeNull());
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(0);

        // A refused approval says nothing about the offer, so the same invitation
        // is asked for again with the same bearer and Account — and, because the
        // Account still requires approval, it waits on a fresh approval.
        await screen.pressByTestIdAsync('team-auth-entry-admission-approval-refused-action');
        await waitForHomeGovernance(() => expect(approvalIds(serverId)).toHaveLength(2));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-auth-entry-admission-approval')).not.toBeNull());
        const prepared = harness.requestsFor(ACCEPT_PREPARE_PATH);
        expect(prepared).toHaveLength(2);
        expect(prepared[1]?.input).toEqual(prepared[0]?.input);
        expect(prepared[1]?.token).toBe(prepared[0]?.token);
        expect(harness.requestsFor(ACCEPT_PATH)).toHaveLength(0);
    });
});
