import * as React from 'react';
import { TeamIdentityConnectionListResultV1Schema, TeamIdentityConnectionRefInputV1Schema, TeamIdentityConnectionRemoveResultV1Schema, TeamIdentityConnectionV1Schema, type TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import { HomeIdentityConnectionListResultV1Schema, HomeIdentityConnectionRefInputV1Schema, HomeIdentityConnectionV1Schema } from '@happier-dev/protocol/home/identity';
import { homeDomainActionTransportV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { teamCapabilitiesFixture, teamIdentityConnectionFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { homeGovernanceProjectionFixture, homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

/**
 * WorkOS Admin Portal return (teams-lane-03/06 §7.4(6), teams-lane-03/03 §8.2(3)).
 *
 * The screen, Team shell, Action client, policy and projection run against the
 * real Home harness. Only HTTP, device credentials and native UI are replaced.
 */
const appStateChangeMock = vi.hoisted(() => ({ current: null as null | ((state: string) => void) }));
// Screen focus is the React Navigation boundary the destination focus owner
// reads; a route regaining focus is focus going false then true again.
const screenFocusMock = vi.hoisted(() => ({
    focused: true,
    listeners: new Set<() => void>(),
    set(focused: boolean) {
        this.focused = focused;
        for (const listener of this.listeners) listener();
    },
}));
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const routerBackMock = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { back: routerBackMock } }).module,
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
    reactNative: async () => {
        const original = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
        return {
            ...original,
            AppState: {
                ...original.AppState,
                addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
                    appStateChangeMock.current = listener;
                    return { remove: vi.fn() };
                }),
            },
        };
    },
});
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // A rendered screen: the destination owner asks this screen whether it is focused.
        NavigationContext: ReactModule.createContext<Readonly<Record<string, unknown>> | undefined>({}),
        useIsFocused: () => ReactModule.useSyncExternalStore(
            (listener) => {
                screenFocusMock.listeners.add(listener);
                return () => screenFocusMock.listeners.delete(listener);
            },
            () => screenFocusMock.focused,
        ),
    };
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { IdentityConnectionDetailScreen } = await import('./IdentityConnectionDetailScreen');
const { HomeIdentityConnectionDetailScreen } = await import('../../home/identity/HomeIdentityConnectionScreens');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests } = await import('@/sync/store/home/governance/homeSettingsSnapshots');
const listPath = homeDomainActionTransportV1('teams.identity.connections.list').path;
const reconcilePath = homeDomainActionTransportV1('teams.identity.workos.reconcile').path;
const portalPath = homeDomainActionTransportV1('teams.identity.workos.adminPortalLink.create').path;
const previewPath = homeDomainActionTransportV1('teams.identity.connections.remove.preview').path;
let serverId: string;

function workosConnection(
    overrides: Partial<TeamIdentityConnectionV1> = {},
): TeamIdentityConnectionV1 {
    return teamIdentityConnectionFixture({
        provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'Acme SSO' },
        externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: null },
        settings: { v: 1, kind: 'workos_sso' },
        enabled: false,
        firstEnabledAt: null,
        revision: 2,
        state: 'setting_up',
        allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.workos.reconcile'],
        lastObservation: { v: 1, kind: 'workos_sso', presentation: null },
        lastSuccessfulTest: null,
        ...overrides,
    });
}

function serveHome(connections: () => readonly TeamIdentityConnectionV1[]) {
    harness.answer(serverId, listPath, { select: () => ({ body: TeamIdentityConnectionListResultV1Schema.parse({
        items: connections(), eligibleProviders: [], memberSignInUrl: null,
        admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'available' }, jit: { status: 'available' } } },
    }) }) });
    harness.answer(serverId, reconcilePath, { select: () => ({ body: { outcome: 'connected', connection: connections()[0] } }) });
    harness.answer(serverId, portalPath, { body: { url: 'https://setup.workos.test/portal' } });
    harness.answer(serverId, homeDomainActionTransportV1('identity.providers.list').path, { body: { items: [], unreadableCount: 0 } });
    harness.answer(serverId, homeDomainActionTransportV1('teams.externalGroupBindings.list').path, { body: { items: [], nextCursor: null } });
}

function reconcileCalls() {
    return harness.requestsFor(reconcilePath);
}

beforeEach(async () => {
    standardCleanup();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
    routerBackMock.mockReset();
    vi.mocked(Modal.alertAsync).mockClear();
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    openExternalUrlMock.mockReset();
    openExternalUrlMock.mockResolvedValue(true);
    appStateChangeMock.current = null;
    screenFocusMock.focused = true;
    screenFocusMock.listeners.clear();
});

describe('IdentityConnectionDetailScreen WorkOS portal return', () => {
    it.each(['direct', 'approval'] as const)('keeps disabled partial removal visible and resumes Remove after %s completion (Home direct, Team approval)', async (completion) => {
        const initial = workosConnection({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: 'conn_1' },
            enabled: true, firstEnabledAt: 1, state: 'connected',
            allowedActions: ['teams.identity.connections.remove'],
        });
        let current = completion === 'direct' ? HomeIdentityConnectionV1Schema.parse({
            ...initial, teamId: null, allowedActions: ['home.identity.connections.remove'],
        }) : initial;
        let removals = 0;
        const removalActionId = completion === 'direct' ? 'home.identity.connections.remove' : 'teams.identity.connections.remove';
        const removalPreviewPath = completion === 'direct' ? homeDomainActionTransportV1('home.identity.connections.remove.preview').path : previewPath;
        const removalPath = homeDomainActionTransportV1(removalActionId).path;
        if (completion === 'direct') {
            harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture({ viewer: { accountId: 'account-1', homeRole: 'owner', status: 'active' } }) });
            harness.answer(serverId, '/v1/home/settings/get', { body: homeSettingsProjectionFixture() });
            harness.answer(serverId, homeDomainActionTransportV1('home.identity.connections.list').path, { select: () => ({ body: HomeIdentityConnectionListResultV1Schema.parse({ items: [current], eligibleProviders: [] }) }) });
            await harness.setActionPolicy(serverId, removalActionId, 'ui', 'allowed');
        } else {
            serveHome(() => [TeamIdentityConnectionV1Schema.parse(current)]);
            await harness.requireUiApproval(serverId, removalActionId);
        }
        harness.answer(serverId, removalPreviewPath, { select: () => ({ body: {
                v: 1, canRemove: true, connection: current,
                impact: { linkedAccounts: 0, accountsRequiringAlternateLogin: 0, directorySources: 0, externalGroupBindings: 0, managedMemberships: 0 },
                blockers: [],
        } }) });
        harness.answer(serverId, removalPath, { select: (input) => {
            const request = completion === 'direct' ? HomeIdentityConnectionRefInputV1Schema.parse(input) : TeamIdentityConnectionRefInputV1Schema.parse(input);
            removals += 1;
            if (removals === 1) {
                current = { ...current, enabled: false, revision: 3 };
                return { body: TeamIdentityConnectionRemoveResultV1Schema.parse({
                    outcome: 'disabled_pending_completion', reason: 'identity_provider_unavailable',
                }) };
            }
            expect(request.expectedRevision).toBe(3);
            return { body: TeamIdentityConnectionRemoveResultV1Schema.parse({ outcome: 'removed' }) };
        } });
        const screen = await renderScreen(completion === 'direct'
            ? <HomeIdentityConnectionDetailScreen serverId={serverId} connectionId="connection-1" />
            : <IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(screen.findByTestId('team-identity-remove')).not.toBeNull());
        await screen.pressByTestIdAsync('team-identity-remove');
        await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledOnce());
        expect(Modal.alertAsync).toHaveBeenCalledWith(t('identityAdministration.disabled'), t('identityAdministration.removalPending'));
        expect(Modal.confirm).toHaveBeenCalledTimes(completion === 'approval' ? 1 : 0);
        expect(routerBackMock).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('team-identity-remove')?.props.disabled).not.toBe(true));
        await screen.pressByTestIdAsync('team-identity-remove');
        expect(removals).toBe(2);
        expect(routerBackMock).toHaveBeenCalledOnce();
    });

    it('checks setup when the portal returns a fresh document to the connection route', async () => {
        // The portal's return URL is this exact route. A new tab has no in-memory
        // "awaiting return" intent, so route focus itself must refresh and reconcile.
        serveHome(() => [workosConnection()]);

        await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />);

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        expect(reconcileCalls()[0]!.input).toEqual({
            v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 2,
        });
    });

    it('checks setup again when the route regains focus with a freshly refreshed projection', async () => {
        let current = workosConnection({ allowedActions: ['teams.identity.workos.adminPortalLink.create'] });
        serveHome(() => [current]);

        await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(harness.requestsFor(listPath)).toHaveLength(1));
        // The first projection did not yet allow reconcile; that snapshot must not decide later focus.
        expect(reconcileCalls()).toHaveLength(0);

        current = workosConnection({ revision: 3 });
        await act(async () => {
            screenFocusMock.set(false);
        });
        await act(async () => {
            screenFocusMock.set(true);
        });

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        expect(reconcileCalls()[0]!.input).toMatchObject({ expectedRevision: 3 });
    });

    it('does not re-check a connected WorkOS connection on ordinary route focus', async () => {
        serveHome(() => [workosConnection({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: 'conn_1' },
            enabled: true,
            firstEnabledAt: 1,
            state: 'connected',
        })]);

        await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(harness.requestsFor(listPath)).toHaveLength(1));
        await act(async () => {
            screenFocusMock.set(false);
        });
        await act(async () => {
            screenFocusMock.set(true);
        });

        await vi.waitFor(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
        expect(reconcileCalls()).toHaveLength(0);
    });

    it('reconciles in the original tab after the portal opens and the app returns to the foreground', async () => {
        serveHome(() => [workosConnection({ externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_1', connectionId: 'conn_1' }, state: 'needs_attention' })]);
        const screen = await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />);
        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(1));
        // The route-focus check and its projection refresh settle before the
        // administrator can open the portal; controls stay busy until then.
        await vi.waitFor(() => expect(screen.findByTestId('team-identity-workos-sso')?.props.disabled).toBe(false));

        await screen.pressByTestIdAsync('team-identity-workos-sso');
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://setup.workos.test/portal');
        await act(async () => appStateChangeMock.current?.('active'));

        await vi.waitFor(() => expect(reconcileCalls()).toHaveLength(2));
    });
});
