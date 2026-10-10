import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';

import {
    collectRenderedTestIds,
    createDeferred,
    createHomeGovernanceHarness,
    decideApprovalAsInbox,
    homeAccountPickerRowFixture,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamGroupFixture,
    teamInvitationRowFixture,
    teamMembershipFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

/**
 * The last mile of a deferred Team journey.
 *
 * An explicit UI-approval requirement turns a Team Action into a durable
 * approval request instead of an immediate answer. These cases are about what
 * the *initiating surface* then owes the person: that the wait is visible and
 * the control is withheld rather than silently doing nothing, and that when the
 * approval executes the journey continues at the Home's own result — the Team
 * or Group it created, the membership whose history was to be prepared, the
 * bearer that was minted — instead of degrading into "something changed".
 *
 * Every deferred case runs the real approval lifecycle: the Team operation
 * reaches the shared Action front door, which persists an open approval in the
 * Home's stateful Artifact store; the Inbox then decides it through the generic
 * executor, whose replay is the one Home operation; and the mounted surface
 * learns the outcome only through the real `useApprovalArtifact` and
 * `useActionApprovalContinuation`. Only the network, the credential store and
 * genuine platform boundaries are replaced.
 *
 * Invitation creation and reissue are the deliberate exception. They mint a raw
 * bearer, so they are declared live-only custody: the invocation waits, the
 * link returns to it alone, and the durable Artifact keeps only the safe
 * projection. Their case therefore proves the opposite property — that no
 * continuation is registered and the surface's own lifetime owns the wait.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const focusEffects = vi.hoisted(() => new Set<() => void | (() => void)>());

vi.mock('@/components/appShell/workspace/destinationRoute', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/appShell/workspace/destinationRoute')>();
    const ReactModule = await import('react');
    return {
        ...original,
        useFocusEffect: (effect: () => void | (() => void)) => {
            ReactModule.useEffect(() => {
                focusEffects.add(effect);
                const cleanup = effect();
                return () => { focusEffects.delete(effect); cleanup?.(); };
            }, [effect]);
        },
    };
});

/**
 * Invitation creation is live-only custody: its invocation, not an Artifact,
 * owns the wait. Armed per case; unarmed it keeps its real implementation.
 */
const deferrals = vi.hoisted(() => ({
    createTeamInvitation: null as null | ((params: never) => Promise<never>),
    calls: { createTeamInvitation: 0 },
}));

vi.mock('@/sync/ops/teams/teamInvitationOperations', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/teams/teamInvitationOperations')>();
    return {
        ...original,
        createTeamInvitation: (params: never) => {
            deferrals.calls.createTeamInvitation += 1;
            return deferrals.createTeamInvitation
                ? deferrals.createTeamInvitation(params)
                : original.createTeamInvitation(params);
        },
    };
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, replace: routerReplace, back: routerBack }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => routeParams.current,
    }),
    // The real client store: the approval writer publishes the settled
    // Artifact into it and the mounted continuation reads it back, so a stub
    // here would sever exactly the path these journeys prove.
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({ importOriginal, overrides: {} });
    },
});

// The clipboard and share sheet are genuine platform boundaries reached by the
// invitation link delivery; everything below them stays real.
const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: setClipboardStringSafeMock }));
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

// App-bundled plugin bytes are an unrelated generated build boundary. The
// synchronized test target intentionally has no generated inventory, so keep
// that boundary inert while these Team approval journeys exercise their real
// continuation and screen owners.
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
    }),
    createBundledPluginUiAppExactArtifactSourceFromInventory: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: async () => null,
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(),
    createPluginAccountAvailabilityReaderStore: () => Object.freeze({
        replace: () => null,
        clear: () => null,
        subscribe: () => () => undefined,
        bind: vi.fn(),
    }),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(),
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const TEAM_GET_PATH = '/v1/teams/get';
const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const ACCOUNT_SEARCH_PATH = '/v1/home/accounts/search';
const INVITATIONS_LIST_PATH = '/v1/teams/invitations/list';

const GROUP_CREATE_PATH = '/v1/teams/groups/create';
const MEMBER_ADD_PATH = '/v1/teams/members/add';
const TEAM_CREATE_PATH = '/v1/teams/create';
const TEAM_LOGO_SET_PATH = '/v1/teams/logo/set';

/** The one approval the Home persisted for this journey, decoded as stored. */
function storedApproval(serverId: string): Readonly<{ id: string; request: Record<string, unknown> }> {
    const rows = harness.artifacts(serverId).list();
    if (rows.length !== 1) throw new Error(`expected_one_approval_artifact:${rows.length}`);
    const body = harness.artifacts(serverId).readPlainBody(rows[0]!.id);
    if (body === null) throw new Error('approval_artifact_not_plain');
    return { id: rows[0]!.id, request: JSON.parse(body) as Record<string, unknown> };
}

/** Waits for the deferral to persist its open approval, and returns its id. */
async function waitForOpenApproval(serverId: string, actionId: string): Promise<string> {
    await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
    const pending = storedApproval(serverId);
    expect(pending.request).toMatchObject({ status: 'open', actionId });
    return pending.id;
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
    focusEffects.clear();
    setClipboardStringSafeMock.mockClear();
    deferrals.createTeamInvitation = null;
    deferrals.calls = { createTeamInvitation: 0 };
    pickImages.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('deferred Team identity reads', () => {
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
        const { TeamAuthenticationSettingsScreen } = await import('./identity/TeamAuthenticationSettingsScreen');
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        const artifactId = await waitForOpenApproval(serverId, 'teams.identity.connections.list');
        await waitForTestId(screen, 'team-approval');
        expect(harness.requestsFor(listPath)).toHaveLength(0);

        await expect(decideApprovalAsInbox(serverId, artifactId, decision)).resolves.toMatchObject({ ok: true });

        await waitForTestId(screen, decision === 'approve' ? 'team-authentication-empty' : 'team-authentication-unavailable');
        expect(harness.requestsFor(listPath)).toHaveLength(decision === 'approve' ? 1 : 0);
        if (decision === 'reject') expect(screen.findByTestId('team-authentication-unavailable')?.props.onPress).toEqual(expect.any(Function));
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
    });
});

describe('WorkOS Portal return', () => {
    const listPath = '/v1/teams/identity/connections/list';
    const reconcilePath = '/v1/teams/identity/workos/reconcile';
    function workosConnection(overrides: Partial<TeamIdentityConnectionV1> = {}): TeamIdentityConnectionV1 {
        return {
            v: 1, id: 'workos-connection', teamId: 'team-1',
            provider: { id: 'workos-provider', kind: 'workos_sso', displayName: 'Acme SSO' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_exact', connectionId: 'conn_exact' },
            settings: { v: 1, kind: 'workos_sso' }, enabled: true, firstEnabledAt: 1,
            revision: 2, state: 'connected',
            allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.workos.reconcile'],
            lastObservation: { v: 1, kind: 'workos_sso', presentation: null },
            lastSuccessfulTest: null, createdAt: 1, updatedAt: 1,
            ...overrides,
        };
    }
    function listAnswer(connection: TeamIdentityConnectionV1) {
        return { body: {
            items: [connection], eligibleProviders: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: {
                invite_only: { status: 'available' },
                provisioned: { status: 'unavailable', reason: 'directory_source_required' },
                jit: { status: 'available' },
            } },
        } };
    }
    async function renderConnectionRoute(serverId: string, returnedFromPortal = false) {
        routeParams.current = {
            serverId, teamId: 'team-1', connectionId: 'workos-connection',
            ...(returnedFromPortal ? { purpose: 'workos_admin_portal' } : {}),
        };
        const { default: IdentityConnectionDetailRoute } = await import('@/app/(app)/settings/teams/[serverId]/[teamId]/authentication/[connectionId]');
        return await renderScreen(<IdentityConnectionDetailRoute />);
    }
    async function refocusRoute() {
        await act(async () => {
            for (const effect of focusEffects) effect();
        });
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

describe('deferred Group creation', () => {
    it('shows the wait, withholds the control, then opens the Group the approval produced', async () => {
        const serverId = await addTeamHome({ manageGroups: true });
        await harness.requireUiApproval(serverId, 'teams.groups.create');
        harness.answer(serverId, GROUP_CREATE_PATH, {
            body: teamGroupFixture({ id: 'group-new', name: 'Design', memberCount: 0 }),
        });
        const { TeamGroupCreateScreen } = await import('./groups/TeamGroupCreateScreen');
        const screen = await renderScreen(<TeamGroupCreateScreen serverId={serverId} teamId="team-1" />);
        await waitForTestId(screen, 'team-group-create-name');
        act(() => screen.changeTextByTestId('team-group-create-name', 'Design'));
        await screen.pressByTestIdAsync('team-group-create-submit');

        // The deferral is visible and the control is withheld, so the same
        // creation cannot be asked for a second time while it is undecided.
        const artifactId = await waitForOpenApproval(serverId, 'teams.groups.create');
        await waitForTestId(screen, 'team-approval');
        expect(screen.findByTestId('team-group-create-submit')?.props.disabled).toBe(true);
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(0);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(
                `/settings/teams/${serverId}/team-1/groups/group-new`,
            );
        });
        // The Home created the Group once, through the Inbox's replay.
        expect(harness.requestsFor(GROUP_CREATE_PATH)).toHaveLength(1);
    });
});

describe('deferred Team admission', () => {
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
        await screen.pressByTestIdAsync('team-member-add-submit');

        const artifactId = await waitForOpenApproval(serverId, 'teams.members.add');
        await waitForTestId(screen, 'team-approval');
        expect(routerReplace).not.toHaveBeenCalled();
        expect(routerBack).not.toHaveBeenCalled();
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(0);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

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

    it('reports a refused admission instead of navigating as though it happened', async () => {
        const serverId = await addAdmissionHome();
        const screen = await renderMemberAdd(serverId);
        await screen.pressByTestIdAsync('team-member-add-submit');
        const artifactId = await waitForOpenApproval(serverId, 'teams.members.add');
        await waitForTestId(screen, 'team-approval');

        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.errors.forbidden');
        });
        expect(routerReplace).not.toHaveBeenCalled();
        expect(routerBack).not.toHaveBeenCalled();
        // A refused admission never reaches the Home.
        expect(harness.requestsFor(MEMBER_ADD_PATH)).toHaveLength(0);
        expect(storedApproval(serverId).request).toMatchObject({ status: 'rejected' });
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
        let waiterSettled = false;
        deferrals.createTeamInvitation = (async (params: Readonly<{ signal?: AbortSignal }>) => {
            observedSignal = params.signal ?? null;
            try {
                await new Promise<never>((_resolve, reject) => {
                    const signal = params.signal;
                    if (!signal) return;
                    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    if (signal.aborted) abort();
                    else signal.addEventListener('abort', abort, { once: true });
                });
            } finally {
                waiterSettled = true;
            }
        }) as never;

        const serverId = await addTeamHome({ manageInvitations: true });
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'unavailable', linkDelivery: 'available' },
        });
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
        await vi.waitFor(() => expect(waiterSettled).toBe(true));
        expect(deferrals.calls.createTeamInvitation).toBe(1);
    });

    it('binds a bearer-minting creation to the surface lifetime and reveals nothing while it waits', async () => {
        const joinUrl = `https://home-a.example/join/${'a'.repeat(43)}`;
        let observedSignal: AbortSignal | null = null;
        let releaseCreate = (): void => {};
        const decided = new Promise<void>((resolve) => { releaseCreate = resolve; });
        deferrals.createTeamInvitation = (async (params: Readonly<{ signal?: AbortSignal }>) => {
            observedSignal = params.signal ?? null;
            await decided;
            return { kind: 'succeeded' as const, value: { invitation: teamInvitationRowFixture(), joinUrl } };
        }) as never;

        const serverId = await addTeamHome({ manageInvitations: true });
        harness.answer(serverId, INVITATIONS_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'unavailable', linkDelivery: 'available' },
        });
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
        // Custody is the live call, not a durable registration, and nothing is
        // revealed while the approval is undecided. The bearer is never rendered
        // as text, so its absence is asserted at the controls that hand it over —
        // a text check would pass even on a fully revealed link.
        expect(observedSignal!.aborted).toBe(false);
        const waitingIds = collectRenderedTestIds(screen.tree.toJSON());
        expect(waitingIds).not.toContain('team-approval');
        expect(waitingIds).not.toContain('team-invite-copy-link');
        expect(waitingIds).not.toContain('team-invite-share-link');
        expect(waitingIds).not.toContain('team-invite-qr');
        expect(setClipboardStringSafeMock).not.toHaveBeenCalled();

        await act(async () => {
            releaseCreate();
            await decided;
        });

        // The one confined delivery reaches the invoking surface, and it is the
        // same presentation an immediate creation gets — the exact minted link,
        // copyable, and asked for exactly once.
        await waitForTestId(screen, 'team-invite-copy-link');
        await screen.pressByTestIdAsync('team-invite-copy-link');
        // The exact minted bearer, handed over once: a link rebuilt locally or a
        // second dispatch would both be invisible to a testID-only assertion.
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith(joinUrl);
        expect(deferrals.calls.createTeamInvitation).toBe(1);

        // Leaving the surface cancels the wait rather than stranding a bearer.
        await act(async () => {
            screen.tree.unmount();
        });
        expect(observedSignal!.aborted).toBe(true);
    });
});

describe('deferred Team creation', () => {
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

    it('opens the Team the approval produced rather than re-asking for one', async () => {
        const serverId = await addCreationHome();
        await harness.requireUiApproval(serverId, 'teams.create');
        harness.answer(serverId, TEAM_CREATE_PATH, {
            body: teamSummaryFixture({ id: 'team-new', name: 'Design' }),
        });

        const { TeamCreateScreen } = await import('./TeamCreateScreen');
        const screen = await renderScreen(<TeamCreateScreen />);
        await waitForTestId(screen, 'teams-create-name');
        act(() => screen.changeTextByTestId('teams-create-name', 'Design'));
        await screen.pressByTestIdAsync('teams-create-submit');

        // A Team being created has no Team shell to host its approval, so this
        // screen owns one: the wait is visible and the form is withheld rather
        // than silently creating a second Team.
        const artifactId = await waitForOpenApproval(serverId, 'teams.create');
        await waitForTestId(screen, 'teams-create-approval');
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(0);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(
                `/settings/teams/${serverId}/team-new`,
            );
        });
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
    });

    it('waits for an approved logo publication instead of reporting an upload failure', async () => {
        // The Team is already created. A logo publication that requires explicit
        // approval is a wait on a person, and reporting `teams.logo.failed` here
        // both lies about the Team and offers a Retry that mints a second
        // approval for the same upload.
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
        await screen.pressByTestIdAsync('teams-create-submit');

        const artifactId = await waitForOpenApproval(serverId, 'teams.logo.set');
        await waitForTestId(screen, 'teams-create-approval');
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);
        // A retained press callback must also refuse redispatch while the
        // publication waits for a person, not merely look disabled.
        await act(async () => { screen.findByTestId('teams-create-submit')?.props.onPress(); });
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        expect(routerReplace).not.toHaveBeenCalled();
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);

        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({
            ok: true, result: { status: 'executed' },
        });

        await vi.waitFor(() => {
            expect(routerReplace).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-new`);
        });
        // One Team, one upload intent: the approval finishes the publication
        // that was deferred rather than starting another one.
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1);
    });
});

describe('deferred Team logo replacement', () => {
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
        await screen.pressByTestIdAsync('team-settings-logo-use');

        const artifactId = await waitForOpenApproval(serverId, 'teams.logo.set');
        await waitForTestId(screen, 'team-approval');
        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        expect(screen.findByTestId('team-settings-logo-use')?.props.disabled).toBe(true);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);

        harness.answer(serverId, TEAM_GET_PATH, { body: published });
        await expect(decideApprovalAsInbox(serverId, artifactId, decision)).resolves.toMatchObject({ ok: true });
        if (decision === 'reject') {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('teams.errors.forbidden')));
            expect(screen.findByTestId('team-settings-logo-use')?.props.disabled).toBe(false);
            expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);
            await screen.pressByTestIdAsync('team-settings-logo-use');
            await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
            expect(pickImages).toHaveBeenCalledTimes(1);
            return;
        }
        await waitForTestId(screen, 'team-settings-logo-remove');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-settings-logo-use');
        expect(screen.getTextContent()).not.toContain(t('teams.logo.failed'));
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1);
    });
});
