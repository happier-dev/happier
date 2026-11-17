import * as React from 'react';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, PrivateLabelRecipientCensusResponseV1Schema } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamIdentityConnectionV1Schema, TeamIdentityConnectionListResultV1Schema, type TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds, createDeferred, homeAccountPickerRowFixture, renderScreen, standardCleanup, teamCapabilitiesFixture, teamGroupFixture, teamInvitationRowFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

/** Configured own-UI Ask settles through the canonical native confirmation.
 * These journeys retain real Action admission and Home transport, preserving
 * pending controls, cancellation, exact result navigation and live-only links.
 * See docs/actions.md: explicit UI Ask creates no self-approval Artifact.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn(async () => true));
const routerPush = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));

installSettingsViewCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { confirm: modalConfirm },
    }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => routeParams.current,
        router: { push: routerPush, replace: routerReplace, back: routerBack },
    }).module,
    storage: 'real',
});

// The clipboard and share sheet are genuine platform boundaries reached by the
// invitation link delivery; everything below them stays real.
const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async (_value: string) => true));
vi.mock('expo-clipboard', () => ({ setStringAsync: setClipboardStringSafeMock }));
vi.mock('@/utils/ui/shareText', () => ({
    isTextSharingAvailable: () => true,
    shareTextSafe: vi.fn(async () => 'shared' as const),
}));

const pickImages = vi.hoisted(() => vi.fn());
vi.mock('@/utils/files/nativePickImages', () => ({ nativePickImages: pickImages }));
vi.mock('expo-file-system', () => ({
    File: class {
        async bytes(): Promise<Uint8Array> { return new Uint8Array(); }
    },
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
let setRouteFocused: React.Dispatch<React.SetStateAction<boolean>> | null = null;

/** Drive actual destination focus facts rather than replacing its effect owner. */
function FocusedConnectionRoute(props: React.PropsWithChildren) {
    const [focused, setFocused] = React.useState(true);
    React.useEffect(() => {
        setRouteFocused = setFocused;
        return () => { setRouteFocused = null; };
    }, []);
    return <DestinationInstanceContext.Provider value={{
        tabId: 'team-identity', ref: { kind: 'settings', params: routeParams.current },
        pathname: '/settings/teams/authentication', focused, visible: true, isFocused: () => focused,
        stackOwned: true,
    }}>{props.children}</DestinationInstanceContext.Provider>;
}

const TEAM_GET_PATH = '/v1/teams/get';
const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const ACCOUNT_SEARCH_PATH = '/v1/home/accounts/search';
const INVITATIONS_LIST_PATH = '/v1/teams/invitations/list';

const GROUP_CREATE_PATH = '/v1/teams/groups/create';
const MEMBER_ADD_PATH = '/v1/teams/members/add';
const TEAM_CREATE_PATH = '/v1/teams/create';
const TEAM_LOGO_SET_PATH = '/v1/teams/logo/set';

function holdConfirmation() {
    const decision = createDeferred<boolean>();
    modalConfirm.mockImplementationOnce(() => decision.promise);
    return decision;
}

async function settleConfirmation(decision: ReturnType<typeof holdConfirmation>, accepted: boolean): Promise<void> {
    await act(async () => { decision.resolve(accepted); });
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

async function waitForTestId(screen: Screen, testID: string): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

async function addTeamHome(
    granted: Parameters<typeof teamCapabilitiesFixture>[0],
): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture(granted) }),
    });
    return serverId;
}

/**
 * The reset owners this suite drives, resolved once.
 *
 * They cannot be static imports: the installed boundaries are registered with
 * `vi.doMock`, so anything pulled in at module evaluation would bind the real
 * transport instead. Resolving them here keeps that one-time module-graph cost
 * — which is large enough to exceed the per-hook budget on a cold cache — out
 * of `beforeEach`, where it reads as a hung hook rather than as a slow import.
 */
let resetOwners!: Readonly<{
    resetTeamsSnapshotsForTests: () => void;
    resetTeamsDirectoryEngineForTests: () => void;
    resetTeamActionClientForTests: () => void;
    resetHomeGovernanceEligibilitySnapshotsForTests: () => void;
    resetHomeGovernanceEligibilityEngineForTests: () => void;
    resetHomeGovernanceSnapshotsForTests: () => void;
    resetHomeGovernanceEngineForTests: () => void;
    resetServerFeaturesClientForTests: () => void;
}>;

beforeAll(async () => {
    // Sequentially: these graphs overlap heavily, and resolving them together
    // makes the transform pipeline contend with itself rather than reuse what
    // the previous import already compiled.
    const teamsSnapshots = await import('@/sync/store/teams/teamsSnapshots');
    const teamsDirectoryEngine = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const teamActionClient = await import('@/sync/ops/teams/teamActionClient');
    const eligibilitySnapshots = await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
    const eligibilityEngine = await import('@/sync/engine/home/governance/homeGovernanceEligibilityEngine');
    const governanceSnapshots = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    const governanceEngine = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    const serverFeaturesClient = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetOwners = {
        resetTeamsSnapshotsForTests: teamsSnapshots.resetTeamsSnapshotsForTests,
        resetTeamsDirectoryEngineForTests: teamsDirectoryEngine.resetTeamsDirectoryEngineForTests,
        resetTeamActionClientForTests: teamActionClient.resetTeamActionClientForTests,
        resetHomeGovernanceEligibilitySnapshotsForTests:
            eligibilitySnapshots.resetHomeGovernanceEligibilitySnapshotsForTests,
        resetHomeGovernanceEligibilityEngineForTests:
            eligibilityEngine.resetHomeGovernanceEligibilityEngineForTests,
        resetHomeGovernanceSnapshotsForTests: governanceSnapshots.resetHomeGovernanceSnapshotsForTests,
        resetHomeGovernanceEngineForTests: governanceEngine.resetHomeGovernanceEngineForTests,
        resetServerFeaturesClientForTests: serverFeaturesClient.resetServerFeaturesClientForTests,
    };
    // Resolve the mounted screen graphs before a test starts a pending native
    // decision. A cold import must not outlive that test and render into the
    // next case after cleanup has already run.
    await import('./identity/TeamAuthenticationSettingsScreen');
    await import('@/app/(app)/settings/teams/[serverId]/[teamId]/authentication/[connectionId]');
    await import('./groups/TeamGroupCreateScreen');
    await import('./members/TeamMemberAddScreen');
    await import('./invitations/TeamInvitationCreateScreen');
    await import('./TeamCreateScreen');
    await import('./TeamSettingsScreen');
}, 300_000);

beforeEach(async () => {
    resetOwners.resetTeamsSnapshotsForTests();
    resetOwners.resetTeamsDirectoryEngineForTests();
    resetOwners.resetTeamActionClientForTests();
    resetOwners.resetHomeGovernanceEligibilitySnapshotsForTests();
    resetOwners.resetHomeGovernanceEligibilityEngineForTests();
    resetOwners.resetHomeGovernanceSnapshotsForTests();
    resetOwners.resetHomeGovernanceEngineForTests();
    resetOwners.resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerReplace.mockReset();
    routerPush.mockReset();
    routerBack.mockReset();
    routeParams.current = {};
    setClipboardStringSafeMock.mockClear();
    installBrowserClipboardBoundary(async value => { await setClipboardStringSafeMock(value); });
    modalConfirm.mockReset().mockResolvedValue(true);
    const { Modal } = await import('@/modal');
    // The canonical factory wraps this controller in its own spy. Clear that
    // outer spy too, including unused one-shot choices from Portal cases.
    vi.mocked(Modal.confirm).mockReset().mockImplementation(modalConfirm);
    pickImages.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('native-confirmed Team identity reads', () => {
    it.each(['approve', 'reject'] as const)('settles a configured list confirmation in the mounted loader after %s', async (decision) => {
        const serverId = await addTeamHome({ manageAuthentication: true });
        await harness.requireUiApproval(serverId, 'teams.identity.connections.list');
        const listPath = '/v1/teams/identity/connections/list';
        harness.answer(serverId, listPath, {
            body: {
                items: [], eligibleProviders: [], memberSignInUrl: null,
                admissionModeApplicability: { v: 1, modes: {
                    invite_only: { status: 'available' },
                    provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                    jit: { status: 'unavailable', reason: 'team_connection_required' },
                } },
            },
        });
        harness.answer(serverId, '/v1/identity/github-apps/list', { body: { registrations: [], installations: [] } });
        const confirmation = holdConfirmation();
        const { TeamAuthenticationSettingsScreen } = await import('./identity/TeamAuthenticationSettingsScreen');
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(harness.requestsFor(listPath)).toHaveLength(0);

        await settleConfirmation(confirmation, decision === 'approve');

        await waitForTestId(screen, decision === 'approve' ? 'team-authentication-empty' : 'team-authentication-unavailable');
        expect(harness.requestsFor(listPath)).toHaveLength(decision === 'approve' ? 1 : 0);
        if (decision === 'reject') {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-authentication-unavailable-action');
        }
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
});

describe('WorkOS Portal return', () => {
    const listPath = '/v1/teams/identity/connections/list';
    const reconcilePath = '/v1/teams/identity/workos/reconcile';
    function workosConnection(overrides: Partial<TeamIdentityConnectionV1> = {}): TeamIdentityConnectionV1 {
        return TeamIdentityConnectionV1Schema.parse({
            v: 1, id: 'workos-connection', teamId: 'team-1',
            provider: { id: 'workos-provider', kind: 'workos_sso', displayName: 'Acme SSO' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_exact', connectionId: 'conn_exact' },
            settings: { v: 1, kind: 'workos_sso' }, enabled: true, firstEnabledAt: 1,
            revision: 2, state: 'connected',
            allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.workos.reconcile'],
            lastObservation: { v: 1, kind: 'workos_sso', presentation: null },
            lastSuccessfulTest: null, createdAt: 1, updatedAt: 1,
            ...overrides,
        });
    }
    function listAnswer(connection: TeamIdentityConnectionV1) {
        return { body: TeamIdentityConnectionListResultV1Schema.parse({
            items: [connection], eligibleProviders: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: {
                invite_only: { status: 'available' },
                provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                jit: { status: 'available' },
            } },
        }) };
    }
    async function renderConnectionRoute(serverId: string, returnedFromPortal = false) {
        routeParams.current = {
            serverId, teamId: 'team-1', connectionId: 'workos-connection',
            ...(returnedFromPortal ? { purpose: 'workos_admin_portal' } : {}),
        };
        const { default: IdentityConnectionDetailRoute } = await import('@/app/(app)/settings/teams/[serverId]/[teamId]/authentication/[connectionId]');
        return await renderScreen(<FocusedConnectionRoute><IdentityConnectionDetailRoute /></FocusedConnectionRoute>);
    }
    async function refocusRoute() {
        await act(async () => { setRouteFocused?.(false); });
        await act(async () => { setRouteFocused?.(true); });
    }

    it.each([true, false])('reconciles connected state only for explicit Portal return (%s)', async (returnedFromPortal) => {
        const serverId = await addTeamHome({ manageAuthentication: true });
        const current = workosConnection();
        harness.answer(serverId, listPath, listAnswer(current));
        const reconcileAnswer = createDeferred<void>();
        const missing = workosConnection({ state: 'needs_attention', revision: 3 });
        harness.answer(serverId, reconcilePath, {
            body: { outcome: 'needs_attention', connection: missing },
            respondAfter: reconcileAnswer.promise,
        });
        const screen = await renderConnectionRoute(serverId, returnedFromPortal);
        await waitForTestId(screen, 'team-identity-workos-reconcile');
        if (returnedFromPortal) {
            await vi.waitFor(() => expect(harness.requestsFor(reconcilePath)).toHaveLength(1));
            harness.answer(serverId, listPath, listAnswer(missing));
            await act(async () => reconcileAnswer.resolve());
            const { t } = await import('@/text');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('teams.authentication.status.needsAttention')));
            expect(harness.requestsFor(reconcilePath)[0]?.input).toMatchObject({ teamId: 'team-1', connectionId: 'workos-connection', expectedRevision: 2 });
        } else {
            await refocusRoute();
            await vi.waitFor(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
            expect(harness.requestsFor(reconcilePath)).toHaveLength(0);
        }
    });

    it('checks unfinished setup on a fresh ordinary route', async () => {
        const serverId = await addTeamHome({ manageAuthentication: true });
        const connection = workosConnection({ state: 'setting_up', enabled: false, firstEnabledAt: null });
        harness.answer(serverId, listPath, listAnswer(connection));
        harness.answer(serverId, reconcilePath, { body: { outcome: 'connected', connection } });
        await renderConnectionRoute(serverId);
        await vi.waitFor(() => expect(harness.requestsFor(reconcilePath)).toHaveLength(1));
        expect(harness.requestsFor(reconcilePath)[0]?.input).toMatchObject({
            teamId: 'team-1', connectionId: connection.id, expectedRevision: 2,
        });
    });

    it('checks setup against the refreshed revision when the route regains focus', async () => {
        const serverId = await addTeamHome({ manageAuthentication: true });
        const initial = workosConnection({ state: 'setting_up', allowedActions: ['teams.identity.workos.adminPortalLink.create'] });
        harness.answer(serverId, listPath, listAnswer(initial));
        const screen = await renderConnectionRoute(serverId);
        await waitForTestId(screen, 'team-identity-workos-sso');
        expect(harness.requestsFor(reconcilePath)).toHaveLength(0);
        const refreshed = workosConnection({ state: 'setting_up', revision: 3 });
        harness.answer(serverId, listPath, listAnswer(refreshed));
        harness.answer(serverId, reconcilePath, { body: { outcome: 'connected', connection: refreshed } });
        await refocusRoute();
        await vi.waitFor(() => expect(harness.requestsFor(reconcilePath)).toHaveLength(1));
        expect(harness.requestsFor(reconcilePath)[0]?.input).toMatchObject({ expectedRevision: 3 });
    });

    it('reconciles the original tab after opening the Portal and returning to the foreground', async () => {
        const serverId = await addTeamHome({ manageAuthentication: true });
        const connection = workosConnection({ state: 'needs_attention' });
        harness.answer(serverId, listPath, listAnswer(connection));
        harness.answer(serverId, reconcilePath, { body: { outcome: 'connected', connection } });
        harness.answer(serverId, '/v1/teams/identity/workos/admin-portal-link/create', { body: { url: 'https://setup.workos.test/portal' } });
        const { AppState } = await import('react-native');
        const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
        const appState = createReactNativeAppStateEmitter();
        const restoreAppState = appState.install(AppState);
        const openBrowser = vi.fn();
        vi.stubGlobal('open', openBrowser);
        try {
            const { Modal } = await import('@/modal');
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            const screen = await renderConnectionRoute(serverId);
            await vi.waitFor(() => expect(harness.requestsFor(reconcilePath)).toHaveLength(1));
            await vi.waitFor(() => expect(screen.tree.findAllByTestId('team-identity-workos-sso')
                .some((node) => node.props.disabled === false)).toBe(true));
            await screen.pressByTestIdAsync('team-identity-workos-sso');
            expect(openBrowser).toHaveBeenCalledWith('https://setup.workos.test/portal', '_blank', 'noopener,noreferrer');
            await act(async () => { appState.emit('background'); appState.emit('active'); });
            await vi.waitFor(() => expect(harness.requestsFor(reconcilePath)).toHaveLength(2));
        } finally {
            restoreAppState();
            vi.unstubAllGlobals();
        }
    });
});

describe('native-confirmed Group creation', () => {
    it('withholds submission during confirmation, then opens the created Group', async () => {
        const serverId = await addTeamHome({ manageGroups: true });
        harness.answer(serverId, PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, {
            body: PrivateLabelRecipientCensusResponseV1Schema.parse({ contentEncryptionMode: 'plain', recipients: [] }),
        });
        await harness.requireUiApproval(serverId, 'teams.groups.create');
        harness.answer(serverId, GROUP_CREATE_PATH, {
            body: teamGroupFixture({ id: 'group-new', name: 'Design', memberCount: 0 }),
        });
        const { TeamGroupCreateScreen } = await import('./groups/TeamGroupCreateScreen');
        const screen = await renderScreen(<TeamGroupCreateScreen serverId={serverId} teamId="team-1" />);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        await vi.waitFor(() => expect(screen.findByTestId('team-group-create-submit')?.props.disabled).toBe(false));
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('team-group-create-submit'));

        // One pending confirmation owns this submission.
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.findHostByTestId('team-group-create-submit')?.props.accessibilityState)
            .toMatchObject({ disabled: true, busy: true }));
        act(() => screen.pressByTestId('team-group-create-submit'));
        expect(modalConfirm).toHaveBeenCalledOnce();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(0);

        await settleConfirmation(confirmation, true);

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(
                `/settings/teams/${serverId}/team-1/groups/group-new`,
            );
        });
        // The admitted invocation creates the Group once.
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(1);
    });
});

describe('native-confirmed Team admission', () => {
    async function renderMemberAdd(serverId: string) {
        const { TeamMemberAddScreen } = await import('./members/TeamMemberAddScreen');
        const screen = await renderScreen(<TeamMemberAddScreen serverId={serverId} teamId="team-1" />);
        await waitForTestId(screen, 'team-member-add-search');
        act(() => screen.changeTextByTestId('team-member-add-search', 'Grace'));
        await waitForTestId(screen, 'team-member-add-candidate:account-grace');
        act(() => screen.pressByTestId('team-member-add-candidate:account-grace'));
        return screen;
    }

    async function addAdmissionHome(): Promise<string> {
        const serverId = await addTeamHome({ manageMembers: true });
        await harness.requireUiApproval(serverId, 'teams.members.add');
        harness.answer(serverId, ACCOUNT_SEARCH_PATH, {
            body: { accounts: [homeAccountPickerRowFixture('account-grace', 'Grace')] },
        });
        return serverId;
    }

    it('continues the history journey at the membership an approved admission answered with', async () => {
        const serverId = await addAdmissionHome();
        harness.answer(serverId, MEMBER_ADD_PATH, {
            body: teamMembershipFixture({
                id: 'membership-grace',
                accountId: 'account-grace',
                historyAccess: 'all_existing',
            }),
        });
        const screen = await renderMemberAdd(serverId);

        await waitForTestId(screen, 'team-member-add-history:all_existing');
        act(() => screen.pressByTestId('team-member-add-history:all_existing'));
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('team-member-add-submit'));

        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(routerReplace).not.toHaveBeenCalled();
        expect(routerBack).not.toHaveBeenCalled();
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(0);

        await settleConfirmation(confirmation, true);

        // Including existing history is an instruction, and the membership it
        // is prepared at exists only in the Home's answer.
        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(
                `/settings/teams/${serverId}/team-1/members/membership-grace?prepareHistory=1`,
            );
        });
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(1);
        expect(harness.requestsFor(MEMBER_ADD_PATH)[0]?.input).toMatchObject({
            accountId: 'account-grace',
            historyAccess: 'all_existing',
        });
    });

    it('preserves the admission draft after native cancellation without an error or navigation', async () => {
        const serverId = await addAdmissionHome();
        const screen = await renderMemberAdd(serverId);
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('team-member-add-submit'));
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());

        await settleConfirmation(confirmation, false);

        await vi.waitFor(() => expect(screen.findByTestId('team-member-add-submit')?.props.disabled).toBe(false));
        expect(screen.getTextContent()).not.toContain('teams.errors.forbidden');
        expect(routerReplace).not.toHaveBeenCalled();
        expect(routerBack).not.toHaveBeenCalled();
        // A refused admission never reaches the Home.
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(0);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
});

describe('live-only invitation custody', () => {
    /**
     * Creation carries a raw bearer, so it is the one Lane 01 journey that must
     * NOT hand its result to a durable continuation. The invocation itself
     * waits, and the surface's mount lifetime is what can cancel that wait — so
     * leaving the screen ends the request instead of leaving a link to be
     * delivered to nobody.
     */
    it('aborts the original live waiter when its initiating surface unmounts', async () => {
        let observedSignal: AbortSignal | null = null;
        const response = createDeferred<void>();
        const serverId = await addTeamHome({ manageInvitations: true });
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'unavailable', linkDelivery: 'available' },
        });
        harness.answer(serverId, '/v1/teams/invitations/create', { select: (_input, request) => {
            observedSignal = request.signal ?? null;
            return { respondAfter: response.promise, body: { invitation: teamInvitationRowFixture(), joinUrl: null } };
        } });
        const { TeamInvitationForm } = await import('./invitations/TeamInvitationCreateScreen');
        const { TeamSection } = await import('./TeamSection');
        const screen = await renderScreen(
            <TeamSection serverId={serverId} teamId="team-1">
                {(context) => <TeamInvitationForm context={context} />}
            </TeamSection>,
        );
        await waitForTestId(screen, 'team-invite-submit');

        // The row deliberately starts a void-owned async submission. Keeping an
        // async `act` open around the waiter would overlap the unmount's `act`
        // and could suppress the cleanup this test is meant to observe.
        act(() => screen.pressByTestId('team-invite-submit'));
        await vi.waitFor(() => expect(observedSignal).not.toBeNull());

        await act(async () => screen.tree.unmount());

        expect(observedSignal!.aborted).toBe(true);
        response.resolve();
        expect(harness.requestsFor('/v1/teams/invitations/create')).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('binds a bearer-minting creation to the surface lifetime and reveals nothing while it waits', async () => {
        const joinUrl = `https://home-a.example/join/${'a'.repeat(43)}`;
        let observedSignal: AbortSignal | null = null;
        const response = createDeferred<void>();
        const serverId = await addTeamHome({ manageInvitations: true });
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'unavailable', linkDelivery: 'available' },
        });
        harness.answer(serverId, '/v1/teams/invitations/create', { select: (_input, request) => {
            observedSignal = request.signal ?? null;
            return { respondAfter: response.promise, body: { invitation: teamInvitationRowFixture(), joinUrl } };
        } });
        const { TeamInvitationForm } = await import('./invitations/TeamInvitationCreateScreen');
        const { TeamSection } = await import('./TeamSection');
        const screen = await renderScreen(
            <TeamSection serverId={serverId} teamId="team-1">
                {(context) => <TeamInvitationForm context={context} />}
            </TeamSection>,
        );
        await waitForTestId(screen, 'team-invite-submit');
        // The pending invocation is the custody under test. The row owns it as
        // a void async action, so do not hold an async React `act` open across
        // its whole lifetime; doing so would overlap the later unmount cleanup.
        act(() => screen.pressByTestId('team-invite-submit'));

        await vi.waitFor(() => expect(observedSignal).not.toBeNull());
        // Nothing is revealed while the live creation request is pending.
        // The bearer is never rendered
        // as text, so its absence is asserted at the controls that hand it over —
        // a text check would pass even on a fully revealed link.
        expect(observedSignal!.aborted).toBe(false);
        const waitingIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(waitingIds).not.toContain('team-approval');
        expect(waitingIds).not.toContain('team-invite-copy-link');
        expect(waitingIds).not.toContain('team-invite-share-link');
        expect(waitingIds).not.toContain('team-invite-qr');
        expect(setClipboardStringSafeMock).not.toHaveBeenCalled();

        await act(async () => { response.resolve(); });

        // The one confined delivery reaches the invoking surface, and it is the
        // same presentation an immediate creation gets — the exact minted link,
        // copyable, and asked for exactly once.
        await waitForTestId(screen, 'team-invite-copy-link');
        await screen.pressByTestIdAsync('team-invite-copy-link');
        // The exact minted bearer, handed over once: a link rebuilt locally or a
        // second dispatch would both be invisible to a testID-only assertion.
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith(joinUrl);
        expect(harness.requestsFor('/v1/teams/invitations/create')).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);

        // The surface still owns the bearer lifetime after delivery.
        await act(async () => {
            screen.tree.unmount();
        });
        expect(observedSignal!.aborted).toBe(true);
    });
});

describe('native-confirmed Team creation', () => {
    async function addCreationHome(): Promise<string> {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        return serverId;
    }

    it('opens the created Team after confirmation', async () => {
        const serverId = await addCreationHome();
        await harness.requireUiApproval(serverId, 'teams.create');
        harness.answer(serverId, TEAM_CREATE_PATH, {
            body: teamSummaryFixture({ id: 'team-new', name: 'Design' }),
        });

        const { TeamCreateScreen } = await import('./TeamCreateScreen');
        const screen = await renderScreen(<TeamCreateScreen />);
        await waitForTestId(screen, 'teams-create-name');
        act(() => screen.changeTextByTestId('teams-create-name', 'Design'));
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('teams-create-submit'));

        // The initiating form stays disabled until confirmation settles.
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.findHostByTestId('teams-create-submit')?.props.accessibilityState)
            .toMatchObject({ disabled: true, busy: true }));
        act(() => screen.pressByTestId('teams-create-submit'));
        expect(modalConfirm).toHaveBeenCalledOnce();
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(0);

        await settleConfirmation(confirmation, true);

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(
                `/settings/teams/${serverId}/team-new`,
            );
        });
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
    });

    it('waits for an approved logo publication instead of reporting an upload failure', async () => {
        // The Team is already created when its logo awaits confirmation.
        // Pending confirmation must not report an upload failure or offer Retry.
        const created = teamSummaryFixture({ id: 'team-new', name: 'Design' });
        const serverId = await addCreationHome();
        await harness.requireUiApproval(serverId, 'teams.logo.set');
        harness.answer(serverId, TEAM_CREATE_PATH, { body: created });
        harness.answer(serverId, TEAM_LOGO_SET_PATH, { body: created });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: { type: 'image/png', arrayBuffer: async () => bytes.buffer },
        }]);

        const { TeamCreateScreen } = await import('./TeamCreateScreen');
        const screen = await renderScreen(<TeamCreateScreen />);
        await waitForTestId(screen, 'teams-create-name');
        act(() => screen.changeTextByTestId('teams-create-name', 'Design'));
        await screen.pressByTestIdAsync('teams-create-logo-set');
        await screen.pressByTestIdAsync('teams-create-logo-use');
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('teams-create-submit'));

        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(screen.findHostByTestId('teams-create-submit')?.props.accessibilityState)
            .toMatchObject({ disabled: true, busy: true }));
        // A retained press callback must also refuse redispatch while the
        // publication waits for a person, not merely look disabled.
        await act(async () => { screen.findByTestId('teams-create-submit')?.props.onPress(); });
        expect(modalConfirm).toHaveBeenCalledOnce();
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);

        await settleConfirmation(confirmation, true);

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-new`);
        });
        // Confirmation completes the existing publication once.
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1);
    });
});

describe('native-confirmed Team logo replacement', () => {
    it.each(['approve', 'reject'] as const)('settles the picked image truthfully after %s', async (decision) => {
        const serverId = await addTeamHome({ manageSettings: true });
        await harness.requireUiApproval(serverId, 'teams.logo.set');
        const published = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
            logo: { path: 'public/teams/team-1/logo/approved.png', url: 'https://home-a.example/public/teams/team-1/logo/approved.png', width: 32, height: 32, thumbhash: 'logo-hash' },
        });
        harness.answer(serverId, TEAM_LOGO_SET_PATH, { body: published });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web', file: { type: 'image/png', arrayBuffer: async () => bytes.buffer },
        }]);
        const { TeamSettingsScreen } = await import('./TeamSettingsScreen');
        const screen = await renderScreen(<TeamSettingsScreen serverId={serverId} teamId="team-1" />);
        await waitForTestId(screen, 'team-settings-logo-set');
        await screen.pressByTestIdAsync('team-settings-logo-set');
        const confirmation = holdConfirmation();
        act(() => screen.pressByTestId('team-settings-logo-use'));

        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        await vi.waitFor(() => expect(screen.findHostByTestId('team-settings-logo-use')?.props.accessibilityState)
            .toMatchObject({ disabled: true, busy: true }));
        act(() => screen.pressByTestId('team-settings-logo-use'));
        expect(modalConfirm).toHaveBeenCalledOnce();
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);

        harness.answer(serverId, TEAM_GET_PATH, { body: published });
        await settleConfirmation(confirmation, decision === 'approve');
        if (decision === 'reject') {
            await vi.waitFor(() => expect(screen.findByTestId('team-settings-logo-use')?.props.disabled).toBe(false));
            expect(screen.getTextContent()).not.toContain(t('teams.errors.forbidden'));
            expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
            expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);
            await screen.pressByTestIdAsync('team-settings-logo-use');
            await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1));
            expect(harness.artifacts(serverId).list()).toHaveLength(0);
            expect(pickImages).toHaveBeenCalledTimes(1);
            return;
        }
        await waitForTestId(screen, 'team-settings-logo-remove');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-settings-logo-use');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1);
    });
});
