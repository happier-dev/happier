import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture, teamCredentialResourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerBack = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const pickImages = vi.hoisted(() => vi.fn());

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('@/utils/files/nativePickImages', () => ({
    nativePickImages: pickImages,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
}));

// App-bundled plugin bytes are a generated build boundary unrelated to this
// source-level Team settings contract. The synchronized target intentionally
// has no generated inventory, so keep that boundary inert while the real
// Action policy, approval continuation and Team screen paths execute below it.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    // The Agent marks on the members' defaults rows read brand marks from the same inventory.
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]),
    BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
}));

// The logo picker reads picked bytes through the platform file API, which has no
// implementation in this runtime. It is a genuine process boundary, and the
// screen's own decisions — capability gating, validation, the Team-owned media
// mutation — all stay real below it.
vi.mock('expo-file-system', () => ({
    File: class {
        constructor(readonly uri: string) {}
        async bytes(): Promise<Uint8Array> {
            return new Uint8Array();
        }
    },
}));

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: routerBack }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
        usePathname: () => '/settings/teams',
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
    // Approval writers and continuation subscribers must share the real store.
    storage: 'real',
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.doUnmock('@/sync/domains/state/storage');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Collect the real graphs after boundary installation, alongside their reset
// owners, so cold module loading cannot outlive a case and render into its successor.
const { TeamSettingsScreen } = await import('./TeamSettingsScreen');
const { TeamNewMembersScreen } = await import('./newMembers/TeamNewMembersScreen');
await import('@/sync/ops/actions/defaultActionExecutor');

const TEAM_GET_PATH = '/v1/teams/get';
const TEAM_UPDATE_PATH = '/v1/teams/update';
const TEAM_POLICY_PATH = '/v1/teams/policy/set';
const TEAM_ARCHIVE_PATH = '/v1/teams/archive';
const TEAM_RESTORE_PATH = '/v1/teams/restore';
const TEAM_LOGO_SET_PATH = '/v1/teams/logo/set';
const TEAM_LOGO_REMOVE_PATH = '/v1/teams/logo/remove';
const ACCOUNT_SETTINGS_V2_PATH = '/v2/account/settings';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

async function renderSettings(serverId: string) {
    return renderScreen(<TeamSettingsScreen serverId={serverId} teamId="team-1" />);
}

/** The member-defaults editor lives on What new members get; Team Settings links to it. */
async function renderNewMembers(serverId: string) {
    return renderScreen(<TeamNewMembersScreen serverId={serverId} teamId="team-1" />);
}

async function addHomeWithTeam(
    team: ReturnType<typeof teamSummaryFixture>,
    options: Readonly<{ waiveDangerousUi?: boolean; homeKey?: string }> = {},
): Promise<string> {
    const homeKey = options.homeKey ?? 'a';
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: `https://home-${homeKey}.example`,
        accountId: homeKey === 'a' ? 'account-ada' : `account-${homeKey}`,
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, { body: team });
    // Default UI + present-user dispatches rely on the shared policy's normal
    // surface-confirmation behavior. The opt-out branch models a user who has
    // explicitly required another approval on the UI surface.
    harness.answer(serverId, ACCOUNT_SETTINGS_V2_PATH, {
        body: {
            content: {
                t: 'plain',
                v: {
                    actionsSettingsV1: options.waiveDangerousUi !== false
                        ? { v: 1, actions: {} }
                        : {
                            v: 1,
                            actions: {
                                'teams.policy.set': { approvalRequiredSurfaces: ['ui'] },
                                'teams.update': { approvalRequiredSurfaces: ['ui'] },
                                'teams.logo.set': { approvalRequiredSurfaces: ['ui'] },
                                'teams.logo.remove': { approvalRequiredSurfaces: ['ui'] },
                                'teams.archive': { approvalRequiredSurfaces: ['ui'] },
                                'teams.restore': { approvalRequiredSurfaces: ['ui'] },
                            },
                        },
                },
            },
            version: 1,
        },
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderSettings>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids, ids.join(', ')).toContain(testID);
    });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerBack.mockReset();
    pickImages.mockReset();
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});

afterEach(() => {
    standardCleanup();
});

describe('TeamSettingsScreen', () => {
    it('keeps a read-only member machine default settled when another machine changes', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture());
        const { storage } = await import('@/sync/domains/state/storage');
        const { TeamMemberMachineDefaultRow } = await import('./defaults/TeamMemberMachineDefaultRow');
        const machine = createMachineFixture({ id: 'selected' });
        const other = createMachineFixture({ id: 'other', metadata: { ...machine.metadata!, host: 'other.local' } });
        storage.setState({ profileScope: { serverId, accountId: 'account-ada' },
            machineListByServerId: { [serverId]: [machine, other] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="default" onRender={() => { commits += 1; }}>
            <TeamMemberMachineDefaultRow testID="member-default" conflict={false} state={{
                serverId, teamId: 'team-1', defaults: { placement: { kind: 'machine', target: { serverId, machineId: machine.id } } },
                editable: false, disabled: false, conflictNote: '', save: () => {},
            }} />
        </React.Profiler>);
        const before = commits;
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [machine, { ...other, activeAt: 42 }] } }));
        expect(commits).toBe(before);
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...machine,
            metadata: { ...machine.metadata!, host: 'renamed.local' } }, other] } }));
        expect(screen.getTextContent()).toContain('renamed.local');
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...machine,
            metadata: { ...machine.metadata!, host: 'renamed.local' } }, { ...other,
            metadata: { ...other.metadata!, displayName: 'renamed.local' } }] } }));
        expect(screen.getTextContent()).toContain('renamed.local ·');
    });

    it('keeps credential broker placement settled when another Home inventory changes', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture());
        const { storage } = await import('@/sync/domains/state/storage');
        const { TeamCredentialBrokerPlacementSection } = await import('./credentials/teamCredentialEditorDraft');
        storage.setState({ profileScope: { serverId, accountId: 'account-ada' },
            machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        let commits = 0;
        await renderScreen(<React.Profiler id="broker" onRender={() => { commits += 1; }}>
            <TeamCredentialBrokerPlacementSection scope={{ serverId, accountId: 'account-ada' }}
                brokerPresentation={teamCredentialResourceFixture().brokerPresentation} savedPlacement={null}
                placement={null} disabled={false} onChange={() => {}} testIDPrefix="broker" />
        </React.Profiler>);
        const before = commits;
        await act(async () => storage.setState({ machineListByServerId: {
            ...storage.getState().machineListByServerId, 'unrelated-home': [createMachineFixture()],
        } }));
        expect(commits).toBe(before);
    });

    it('classifies an initial Team 503 as a server read failure, not an unreachable Home', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture());
        harness.answer(serverId, '/v1/teams/get', { status: 503 });
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-unavailable');
        expect(screen.getTextContent()).toContain('teams.errors.loadFailed');
        expect(screen.getTextContent()).not.toContain('teams.unavailable.offline');
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture() });
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const unavailable = screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'team-unavailable');
        await act(async () => unavailable?.props.action.onPress());
        await waitForTestId(screen, 'team-settings-session-creation');
        harness.answer(serverId, '/v1/teams/get', { status: 503 });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} = await import('@happier-dev/protocol/changes');
        await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForTestId(screen, 'team-stale');
        expect(screen.getTextContent()).toContain('teams.errors.loadFailed');
        expect(screen.getTextContent()).not.toContain('teams.unavailable.offline');
    });
    it('UX keeps an unsaved invalid identity draft when navigation is canceled', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) }));
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', ''));
        expect(screen.findByTestId('team-settings-name.error')).toMatchObject({
            props: { accessibilityRole: 'alert' },
        });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockImplementation((_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const leave = vi.fn();
        let departed: boolean | undefined;
        await act(async () => { departed = await runGuardedNavigation(leave); });
        expect(departed).toBe(false);
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('');
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(0);
    });

    it('renames the Team through its own Home and keeps the edit until it lands', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_UPDATE_PATH, { body: { ...team, name: 'Platform Core' } });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        // One save model (DR-18): Cancel and Save exist only while there is a draft.
        expect(screen.findByTestId('team-settings-save')).toBeFalsy();
        expect(screen.findByTestId('team-settings-cancel')).toBeFalsy();
        // The edit has to be committed before the save reads it; without this
        // the submission carries the name the field started with.
        act(() => screen.changeTextByTestId('team-settings-name', 'Platform Core'));
        await waitForTestId(screen, 'team-settings-cancel');
        await screen.pressByTestIdAsync('team-settings-save');

        await vi.waitFor(() => {
            expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1);
        });
        const update = harness.requestsFor(TEAM_UPDATE_PATH)[0];
        expect(update?.serverId).toBe(serverId);
        expect(update?.input).toMatchObject({ teamId: 'team-1', name: 'Platform Core' });
    });

    it('UX clears the dirty guard after the Home commits normalized metadata', async () => {
        const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_UPDATE_PATH, { body: { ...team, name: 'Platform Core' } });
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', '  Platform Core  '));
        await screen.pressByTestIdAsync('team-settings-save');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const leave = vi.fn();
        await act(async () => { await runGuardedNavigation(leave); });
        expect(leave).toHaveBeenCalledOnce();
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('UX retains newer edits made while normalized metadata is being saved', async () => {
        const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) });
        const serverId = await addHomeWithTeam(team);
        let releaseSave = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseSave = resolve; });
        harness.answer(serverId, TEAM_UPDATE_PATH, { body: { ...team, name: 'Submitted' }, respondAfter });
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', '  Submitted  '));
        screen.pressByTestId('team-settings-save');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
        act(() => screen.changeTextByTestId('team-settings-name', 'Newer draft'));
        await act(async () => { releaseSave(); });
        await vi.waitFor(() => expect(screen.findByTestId('team-settings-cancel')?.props.disabled).toBe(false));
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Newer draft');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockImplementation((_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const leave = vi.fn();
        await act(async () => { await runGuardedNavigation(leave); });
        expect(leave).not.toHaveBeenCalled();
    });

    it('preserves a dirty identity draft across refresh and requires deliberate conflict acceptance', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');

        act(() => {
            screen.changeTextByTestId('team-settings-name', 'Pending rename');
            screen.changeTextByTestId('team-settings-description', 'Pending description');
        });

        const { applyTeamProjection } = await import('@/sync/store/teams/teamsSnapshots');
        act(() => applyTeamProjection({
            scope: { serverId, accountId: 'account-ada' },
            address: { serverId, teamId: 'team-1' },
            team: { ...team, name: 'Current server name', description: 'Current server description' },
            observedAt: Date.now(),
        }));

        await waitForTestId(screen, 'team-settings-identity-conflict');
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Pending rename');
        expect(screen.findByTestId('team-settings-description')?.props.value).toBe('Pending description');
        expect(screen.findByTestId('team-settings-save')?.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('team-settings-identity-conflict');
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Pending rename');
        expect(screen.findByTestId('team-settings-save')?.props.disabled).toBe(false);

        await screen.pressByTestIdAsync('team-settings-cancel');
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Current server name');
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(0);
    });

    it('closes the same-frame duplicate save window before the busy state renders', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);
        let releaseResponse = (): void => {};
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
        harness.answer(serverId, TEAM_UPDATE_PATH, { body: { ...team, name: 'Platform Core' }, respondAfter: responseGate });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', 'Platform Core'));

        act(() => {
            screen.pressByTestId('team-settings-save');
            screen.pressByTestId('team-settings-save');
        });
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));

        act(releaseResponse);
    });

    it('does not describe an issued identity mutation with a lost response as definitely unchanged', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);
        let rejectResponse = (_cause: Error): void => {};
        const responseGate = new Promise<void>((_resolve, reject) => {
            rejectResponse = reject;
        });
        harness.answer(serverId, TEAM_UPDATE_PATH, {
            body: team,
            respondAfter: responseGate,
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', 'Maybe renamed'));
        act(() => screen.pressByTestId('team-settings-save'));
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
        act(() => rejectResponse(new Error('response_lost')));

        await waitForTestId(screen, 'team-settings-identity-error');
        expect(screen.getTextContent()).toContain('teams.errors.outcomeUnknown');
        expect(screen.findByTestId('team-settings-identity-error')?.props.accessibilityLiveRegion)
            .toBe('assertive');
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Maybe renamed');
    });

    it('renders only the controls the Home says this viewer has', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            // A Team owner by role, but the Home has withdrawn everything except
            // policy: a control rendered from the role would appear here.
            viewerRole: 'owner',
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
        }));

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-session-creation:team_required');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-settings-name');
        expect(ids).not.toContain('team-settings-logo-set');
        expect(ids).not.toContain('team-settings-archive');
    });

    it.each([undefined, 'team_required'] as const)('shows a viewer who can change nothing the published policy as text (%s)', async (reviewCreationPolicy) => {
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            viewerRole: 'member',
            capabilities: teamCapabilitiesFixture({}),
            policy: teamPolicyFixture({ reviewCreationPolicy }),
        }));

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-read-only');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        for (const row of ['team-settings-session-creation', 'team-settings-review-creation', 'team-settings-external-sharing', 'team-settings-history-default']) {
            expect(ids).toContain(row);
            expect(ids.filter((id) => id.startsWith(`${row}:`))).toEqual([]);
        }
        expect(screen.getTextContent())
            .toContain(reviewCreationPolicy === undefined ? 'common.unknown' : 'teams.settings.option.alwaysShared');
        expect(ids).toContain('team-settings-name-fact');
        expect(ids).not.toContain('team-settings-archive');
    });

    it('changes one policy field at a time against the Team it is showing', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: {
                ...team,
                policy: teamPolicyFixture({ externalSharingPolicy: 'disabled' }),
            },
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-external-sharing:disabled');
        await screen.pressByTestIdAsync('team-settings-external-sharing:disabled');

        await vi.waitFor(() => {
            expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1);
        });
        const request = harness.requestsFor(TEAM_POLICY_PATH)[0]?.input as Record<string, unknown>;
        expect(request).toMatchObject({ teamId: 'team-1', externalSharingPolicy: 'disabled' });
        // A history-default change must not ride along: it would look like a
        // rewrite of existing membership horizons.
        expect(request).not.toHaveProperty('defaultSessionHistoryAccess');
    });

    it('orders shared Reviews before other files and opens their resource list', async () => {
        const { TeamSharedResourcesView } = await import('./TeamSharedResourcesSection');
        const open = vi.fn();
        const screen = await renderScreen(<TeamSharedResourcesView
            teamName="Design" serverId="home-a"
            summary={{ status: 'ready', kinds: [
                { kind: 'otherArtifacts', status: 'available', count: 1 },
                { kind: 'reviews', status: 'available', count: 2 },
            ], error: null, reload: vi.fn() }}
            destinationOf={kind => `/settings/teams/team-1/shared/${kind}`} onOpen={open}
        />);
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.indexOf('team-overview-shared:reviews')).toBeLessThan(ids.indexOf('team-overview-shared:otherArtifacts'));
        await screen.pressByTestIdAsync('team-overview-shared:reviews');
        expect(open).toHaveBeenCalledWith('/settings/teams/team-1/shared/reviews');
    });

    it('changes Review creation policy independently and retains the published choice after refusal for retry', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
            policy: teamPolicyFixture({ reviewCreationPolicy: 'private_default', sessionCreationPolicy: 'team_default' }),
        });
        const serverId = await addHomeWithTeam(team);
        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-review-creation:private_default');
        await screen.pressByTestIdAsync('team-settings-review-creation:private_default');
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);

        harness.answer(serverId, TEAM_POLICY_PATH, { status: 403, body: { error: 'team_forbidden' } });
        await screen.pressByTestIdAsync('team-settings-review-creation:team_default');
        await waitForTestId(screen, 'team-settings-policy-error');
        expect(screen.findByTestId('team-settings-review-creation:private_default')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('team-settings-session-creation:team_default')?.props.accessibilityState)
            .toMatchObject({ checked: true });

        harness.answer(serverId, TEAM_POLICY_PATH, { body: { ...team,
            policy: { ...team.policy, reviewCreationPolicy: 'team_required' } } });
        await screen.pressByTestIdAsync('team-settings-review-creation:team_required');
        await vi.waitFor(() => expect(screen.findByTestId('team-settings-review-creation:team_required')?.props.accessibilityState)
            .toMatchObject({ checked: true }));
        expect(harness.requestsFor(TEAM_POLICY_PATH).map(request => request.input)).toEqual([
            { v: 1, teamId: 'team-1', reviewCreationPolicy: 'team_default' },
            { v: 1, teamId: 'team-1', reviewCreationPolicy: 'team_required' },
        ]);
        expect(screen.findByTestId('team-settings-policy-error')).toBeNull();
    });

    it('closes the same-frame duplicate policy window before the busy state renders', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
        });
        const serverId = await addHomeWithTeam(team);
        let releaseResponse = (): void => {};
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
        harness.answer(serverId, TEAM_POLICY_PATH, {
            body: { ...team, policy: teamPolicyFixture({ externalSharingPolicy: 'disabled' }) },
            respondAfter: responseGate,
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-external-sharing:disabled');
        act(() => {
            screen.pressByTestId('team-settings-external-sharing:disabled');
            screen.pressByTestId('team-settings-history-default:all_existing');
        });
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));

        act(releaseResponse);
    });

    it('exposes each policy choice set as a labeled radio group with checked state', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
        }));

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-session-creation:private_default');
        for (const option of ['private_default', 'team_default', 'team_required']) {
            expect(screen.findByTestId(`team-settings-review-creation:${option}`)?.props.accessibilityState)
                .toMatchObject({ checked: false });
        }

        const selectedChoices = [
            ['team-settings-session-creation:team_default', 'teams.settings.sessionDefaultsSection'],
            ['team-settings-external-sharing:allowed', 'teams.settings.sharingOutsideTeam'],
            ['team-settings-history-default:from_membership', 'teams.settings.historyDefaultSection'],
        ] as const;

        for (const [testID, groupLabel] of selectedChoices) {
            const selected = screen.findByTestId(testID);
            expect([selected?.props.accessibilityRole, selected?.props.role]).toContain('radio');
            expect(selected?.props.accessibilityState).toMatchObject({ checked: true });

            let ancestor = selected?.parent ?? null;
            while (ancestor
                && ancestor.props.accessibilityRole !== 'radiogroup'
                && ancestor.props.role !== 'radiogroup') {
                ancestor = ancestor.parent;
            }
            expect(ancestor).not.toBeNull();
            expect(ancestor?.props.accessibilityLabel ?? ancestor?.props['aria-label']).toBe(groupLabel);
        }
    });

    it('offers the Team logo once, in the Team section', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-logo-set');
        const logoControls = collectRenderedTestIds(screen.tree.toJSON())
            .filter((id) => id === 'team-settings-logo-set');
        expect(logoControls).toHaveLength(1);
    });

    it('previews a picked logo and uploads only after explicit confirmation', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team);
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: {
                type: 'image/png',
                arrayBuffer: async () => bytes.buffer,
            },
        }]);
        harness.answer(serverId, TEAM_LOGO_SET_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-logo-set');
        await screen.pressByTestIdAsync('team-settings-logo-set');

        await waitForTestId(screen, 'team-settings-logo-use');
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('data:image/png;base64,');

        await screen.pressByTestIdAsync('team-settings-logo-cancel');
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);
        await screen.pressByTestIdAsync('team-settings-logo-set');
        await waitForTestId(screen, 'team-settings-logo-use');

        await screen.pressByTestIdAsync('team-settings-logo-use');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-settings-logo-use');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('data:image/png;base64,');

        harness.answer(serverId, TEAM_LOGO_SET_PATH, {
            body: {
                ...team,
                logo: {
                    path: 'public/teams/team-1/logo/team-logo.webp',
                    url: 'https://home-a.example/team-logo.webp',
                    width: 512,
                    height: 512,
                    thumbhash: 'logo',
                },
            },
        });
        await screen.pressByTestIdAsync('team-settings-logo-use');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(2));
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)[0]?.input).toMatchObject({
            teamId: 'team-1',
            image: { mimeType: 'image/png' },
        });
    });

    it('starts only one confirmed logo upload when activated twice before busy renders', async () => {
        let releaseUpload = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseUpload = resolve; });
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team, { homeKey: 'logo-set-default-policy' });
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: {
                type: 'image/png',
                arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
            },
        }]);
        harness.answer(serverId, TEAM_LOGO_SET_PATH, {
            body: {
                ...team,
                logo: {
                    path: 'public/teams/team-1/logo/team-logo.webp',
                    url: 'https://home-a.example/team-logo.webp',
                    width: 512,
                    height: 512,
                    thumbhash: 'logo',
                },
            },
            respondAfter,
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-logo-set');
        await screen.pressByTestIdAsync('team-settings-logo-set');
        await waitForTestId(screen, 'team-settings-logo-use');
        act(() => {
            screen.pressByTestId('team-settings-logo-use');
            screen.pressByTestId('team-settings-logo-use');
        });

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        await act(async () => releaseUpload());
    });

    it('starts only one confirmed logo removal when activated twice', async () => {
        let releaseRemoval = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseRemoval = resolve; });
        const team = teamSummaryFixture({
            logo: {
                path: 'public/teams/team-1/logo/team-logo.webp',
                url: 'https://home-a.example/team-logo.webp',
                width: 512,
                height: 512,
                thumbhash: 'logo',
            },
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team, { homeKey: 'logo-remove-default-policy' });
        harness.answer(serverId, TEAM_LOGO_REMOVE_PATH, {
            body: { ...team, logo: null },
            respondAfter,
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-logo-remove');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        act(() => {
            screen.pressByTestId('team-settings-logo-remove');
            screen.pressByTestId('team-settings-logo-remove');
        });

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_REMOVE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        expect(Modal.confirm).not.toHaveBeenCalled();
        await act(async () => releaseRemoval());
    });

    it.each(['external-sharing:disabled', 'review-creation:team_required'])('confirms an explicit Ask policy change locally and saves it without a self-approval Artifact (%s)', async (choice) => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ managePolicy: true, archiveTeam: true }),
        });
        const serverId = await addHomeWithTeam(team, {
            waiveDangerousUi: false,
            // This assertion depends on the fetched Account settings. A unique
            // scope prevents a previously focused test Account from supplying
            // an intentionally different live settings snapshot.
            homeKey: 'policy-approval',
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, `team-settings-${choice}`);
        await screen.pressByTestIdAsync(`team-settings-${choice}`);

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });

    it('confirms an explicit Ask identity save locally and sends the mutation once', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team, {
            waiveDangerousUi: false,
            homeKey: 'identity-approval',
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', 'Approval rename'));
        await screen.pressByTestIdAsync('team-settings-save');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });

    it('keeps a declined Ask identity draft available for a later confirmed save', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        const serverId = await addHomeWithTeam(team, {
            waiveDangerousUi: false,
            homeKey: 'identity-approval-canceled',
        });
        // A live Account activates both scopes before Artifact publication.
        await harness.requireUiApproval(serverId, 'teams.update');

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-name');
        act(() => screen.changeTextByTestId('team-settings-name', 'Approval rename'));
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-settings-save');

        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(screen.findByTestId('team-settings-save')?.props.disabled).not.toBe(true));
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(0);
        expect(screen.findByTestId('team-settings-name')?.props.value).toBe('Approval rename');
        expect(screen.findByTestId('team-settings-save')?.props.disabled).not.toBe(true);
        harness.answer(serverId, TEAM_UPDATE_PATH, { body: { ...team, name: 'Approval rename' } });
        await screen.pressByTestIdAsync('team-settings-save');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
    });

    it('leaves the Team after archiving it and offers restore from the archived Team', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true, archiveTeam: true }),
        });
        const serverId = await addHomeWithTeam(team, { homeKey: 'archive-default-policy' });
        harness.answer(serverId, TEAM_ARCHIVE_PATH, {
            body: { ...team, archivedAt: 1_700_000_000_000 },
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-archive');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        // The row opens a confirmation; the final confirm button owns the
        // destructive emphasis.
        const archiveRow = screen.findAll((node) => (
            node.props.testID === 'team-settings-archive'
            && node.props.title === 'teams.archive.action'
        ))[0];
        expect(archiveRow).toBeDefined();
        expect(archiveRow?.props.destructive).not.toBe(true);
        act(() => {
            screen.pressByTestId('team-settings-archive');
            screen.pressByTestId('team-settings-archive');
        });

        await vi.waitFor(() => {
            expect(harness.requestsFor(TEAM_ARCHIVE_PATH)).toHaveLength(1);
        });
        // The shared default recognizes UI + present-user dispatch, so the
        // modal-confirmed action reaches the Home once without an Artifact.
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(routerBack).toHaveBeenCalled());
    });

    it('confirms archive once under explicit Ask and executes without a self-approval Artifact', async () => {
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true, archiveTeam: true }),
        });
        const serverId = await addHomeWithTeam(team, {
            waiveDangerousUi: false,
            homeKey: 'archive-explicit-approval',
        });
        harness.answer(serverId, TEAM_ARCHIVE_PATH, {
            body: { ...team, archivedAt: 1_700_000_000_000 },
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-archive');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        await screen.pressByTestIdAsync('team-settings-archive');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_ARCHIVE_PATH)).toHaveLength(1));
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        await vi.waitFor(() => expect(routerBack).toHaveBeenCalled());
    });

    it('keeps restore reachable while its local Ask confirmation is unresolved', async () => {
        const team = teamSummaryFixture({
            archivedAt: 1_700_000_000_000,
            capabilities: teamCapabilitiesFixture({ restoreTeam: true }),
        });
        const serverId = await addHomeWithTeam(team, {
            waiveDangerousUi: false,
            homeKey: 'restore-explicit-approval',
        });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-settings-restore');
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        let settleConfirmation!: (confirmed: boolean) => void;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { settleConfirmation = resolve; }));
        act(() => screen.pressByTestId('team-settings-restore'));

        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
        expect(harness.requestsFor(TEAM_RESTORE_PATH)).toHaveLength(0);
        expect(screen.findByTestId('team-settings-restore')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId('team-settings-restore')?.props.accessibilityState?.disabled).toBe(true));
        await act(async () => settleConfirmation(true));
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_RESTORE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
    });

    it('keeps an archived Team read-only while restore stays reachable', async () => {
        const team = teamSummaryFixture({
            archivedAt: 1_700_000_000_000,
            capabilities: teamCapabilitiesFixture({
                manageSettings: true,
                managePolicy: true,
                archiveTeam: true,
                restoreTeam: true,
            }),
        });
        const serverId = await addHomeWithTeam(team, { homeKey: 'restore-default-policy' });
        harness.answer(serverId, TEAM_RESTORE_PATH, { body: { ...team, archivedAt: null } });

        const screen = await renderSettings(serverId);
        // Settings says the Team is archived itself, once, with Restore on that one banner.
        await waitForTestId(screen, 'team-settings-archived');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-archived');
        expect(ids).toContain('team-settings-restore');
        expect(ids).not.toContain('team-settings-archive');
        const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
        expect(screen.tree.findByType(AttentionBanner).props.action.display).toBe('default');
        // Nothing can change, so nothing is drawn as a control: the values read as text.
        expect(ids).toContain('team-settings-session-creation');
        expect(ids.filter((id) => id.startsWith('team-settings-session-creation:'))).toEqual([]);
        expect(ids).not.toContain('team-settings-name');

        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        await screen.pressByTestIdAsync('team-settings-restore');
        await vi.waitFor(() => {
            expect(harness.requestsFor(TEAM_RESTORE_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        // Restore is legitimate *because* the Team is archived, so it is not
        // gated on the ordinary-write rule that archiving withdraws.
        expect(harness.requestsFor(TEAM_UPDATE_PATH)).toHaveLength(0);
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('routes a Team-authentication refusal to the exact-Home Team sign-in instead of a dead end', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { status: 403, body: { error: 'team_authentication_required' } });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-authentication-required');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-unavailable');

        routerPush.mockClear();
        await screen.pressByTestIdAsync('team-authentication-required-action');
        // The canonical explicit-Home Team entry, addressed by this route's own
        // Home rather than by whichever Home is focused.
        expect(routerPush).toHaveBeenCalledWith(`/teams/team-1/sign-in?serverId=${encodeURIComponent(serverId)}`);
    });

    it('keeps an ordinary permission refusal a settled denial without a sign-in offer', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { status: 403, body: { error: 'team_forbidden' } });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-unavailable');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-authentication-required-action');
    });

    it('explains an unreachable Home instead of showing an empty Team', async () => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'account-ada',
            teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderSettings(serverId);
        await waitForTestId(screen, 'team-unavailable');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-settings-name');
        expect(screen.findByTestId('team-unavailable')?.props.accessibilityRole).toBe('alert');
        expect(screen.findByTestId('team-unavailable')?.props.accessibilityLiveRegion).toBe('assertive');
    });
});

describe('TeamSettingsScreen defaults for members', () => {
    async function claudeTargetKey(): Promise<string> {
        const { getResolvedAgentCatalogEntries } = await import('@/agents/backendCatalog/agentCatalogProjection');
        const entry = getResolvedAgentCatalogEntries({ enabledAgentIds: ['claude'] }).find((candidate) => candidate.agentId === 'claude');
        return entry!.backendTargetKey!;
    }

    it('saves a member default through teams.policy.set and keeps every Group default', async () => {
        const key = await claudeTargetKey();
        const groups = { 'group-1': { placement: { kind: 'machine' as const, target: { serverId: 'home', machineId: 'm1' } } } };
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
            policy: teamPolicyFixture({ managedDefaults: { team: {}, groups }, managedDefaultsStatus: 'available' }),
        });
        const serverId = await addHomeWithTeam(team);
        harness.answer(serverId, TEAM_POLICY_PATH, { body: team });

        const screen = await renderNewMembers(serverId);
        await waitForTestId(screen, 'team-new-members-defaults-agent:claude:header');
        await screen.pressByTestIdAsync('team-new-members-defaults-agent:claude:header');
        await waitForTestId(screen, 'team-new-members-defaults-agent:claude:permission');
        // The menu's popover is a web/native overlay this renderer has no window for; choose
        // through the real menu's own selection callback, as a person picking the row does.
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = screen.findAllByType(DropdownMenu).find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'team-new-members-defaults-agent:claude:permission');
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toContain('read-only');
        await act(async () => menu?.props.onSelect('read-only'));

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_POLICY_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            managedDefaults: { team: { permissionModeByAgentTargetKey: { [key]: 'read-only' } }, groups },
        });
    });

    it('explains read-only defaults and leaves unset rows inert', async () => {
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: false, managePolicy: false }),
        }));

        const screen = await renderNewMembers(serverId);
        await waitForTestId(screen, 'team-new-members-defaults-agent:claude:header');
        expect(screen.getTextContent()).toContain('teams.settings.memberDefaults.readOnlyTeam');
        // Nothing is set for Claude, so its read-only row is a value that opens nothing.
        expect(screen.tree.root.findAll((node) => node.props.testID === 'team-new-members-defaults-agent:claude:header'
            && typeof node.props.onPress === 'function')).toHaveLength(0);
    });

    it('shows members\' defaults to a viewer who cannot change them as values, with the reason', async () => {
        const key = await claudeTargetKey();
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            // Sharing policy is theirs to change; Team settings (and so these defaults) are not.
            capabilities: teamCapabilitiesFixture({ managePolicy: true }),
            policy: teamPolicyFixture({
                managedDefaults: { team: { permissionModeByAgentTargetKey: { [key]: 'read-only' } }, groups: {} },
            }),
        }));

        const screen = await renderNewMembers(serverId);
        await waitForTestId(screen, 'team-new-members-defaults-agent:claude:header');
        expect(screen.getTextContent()).toContain('teams.settings.memberDefaults.readOnlyTeam');
        await screen.pressByTestIdAsync('team-new-members-defaults-agent:claude:header');
        await waitForTestId(screen, 'team-new-members-defaults-agent:claude:permission');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.filter((id) => id.startsWith('team-new-members-defaults-agent:claude:permission:'))).toEqual([]);
        expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(0);
    });

    it('says where Groups disagree, as the precedence reader decides it', async () => {
        const machine = (machineId: string) => ({ kind: 'machine' as const, target: { serverId: 'home', machineId } });
        const serverId = await addHomeWithTeam(teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
            policy: teamPolicyFixture({
                managedDefaults: { team: {}, groups: { 'group-1': { placement: machine('m1') }, 'group-2': { placement: machine('m2') } } },
            }),
        }));

        const screen = await renderNewMembers(serverId);
        await waitForTestId(screen, 'team-new-members-defaults-machine');
        expect(screen.getTextContent()).toContain('teams.settings.memberDefaults.conflictTeam');
    });
});
