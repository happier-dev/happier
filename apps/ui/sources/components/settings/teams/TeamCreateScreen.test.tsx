import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, flushHookEffects, homeGovernanceProjectionFixture, homeAccountPickerRowFixture, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
const pickImages = vi.hoisted(() => vi.fn());
const departureChoice = vi.hoisted(() => ({ discard: false }));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: {
            alert: (_title, _message, buttons) => {
                buttons?.find((button) => button.style === (departureChoice.discard ? 'destructive' : 'cancel'))?.onPress?.();
            },
        } }).module;
    },
});

vi.mock('@/utils/files/nativePickImages', () => ({ nativePickImages: pickImages }));
vi.mock('expo-file-system', () => ({
    File: class {
        async bytes(): Promise<Uint8Array> { return new Uint8Array(); }
    },
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
// Load the real screen after its boundaries are installed, outside any case's deadline.
const { TeamCreateScreen } = await import('./TeamCreateScreen');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const GOVERNANCE_PATH = '/v1/home/governance/get';
const TEAM_CREATE_PATH = '/v1/teams/create';
const TEAM_LOGO_SET_PATH = '/v1/teams/logo/set';
const HOME_ACCOUNT_SEARCH_PATH = '/v1/home/accounts/search';

async function renderCreate(administrationServerId?: string) {
    return renderScreen(<TeamCreateScreen administrationServerId={administrationServerId} />);
}

beforeEach(async () => {
    const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots'
    );
    const { resetHomeGovernanceEligibilityEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEligibilityEngine'
    );
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    const { resetHomeGovernanceEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEngine'
    );
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    resetHomeGovernanceEngineForTests();
    resetTeamActionClientForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerReplace.mockReset();
    pickImages.mockReset();
    departureChoice.discard = false;
});

afterEach(() => {
    standardCleanup();
});

describe('TeamCreateScreen', () => {
    it('UX keeps the draft monogram preview the same while the name and description are typed', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'member-a', teamsEnabled: true });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        const screen = await renderCreate();
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-logo-preview')).not.toBeNull());
        const previewIdentity = () => screen.tree.root
            .findAll((node) => node.props.square === true && typeof node.props.id === 'string')
            .map((node) => node.props.id as string)[0];
        const before = previewIdentity();
        expect(before).toEqual(expect.any(String));
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        act(() => screen.changeTextByTestId('teams-create-description', 'Shared dev boxes'));
        expect(previewIdentity()).toBe(before);
    });

    it('UX preserves a dirty creation draft on navigation until discard is chosen', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'member-a', teamsEnabled: true });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        const screen = await renderCreate();
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-name')).not.toBeNull());
        act(() => screen.changeTextByTestId('teams-create-name', 'Unfinished'));
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const leave = vi.fn();
        let departed: boolean | undefined;
        await act(async () => { departed = await runGuardedNavigation(leave); });
        expect(departed).toBe(false);
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('teams-create-name')?.props.value).toBe('Unfinished');
        departureChoice.discard = true;
        await act(async () => { departed = await runGuardedNavigation(leave); });
        expect(departed).toBe(true);
        expect(leave).toHaveBeenCalledOnce();
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(0);
    });

    it('UX explains an invalid description without dropping text and recovers when corrected', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'member-a', teamsEnabled: true });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        const screen = await renderCreate();
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-name')).not.toBeNull());
        const invalid = 'x'.repeat(501);
        act(() => {
            screen.changeTextByTestId('teams-create-name', 'Platform');
            screen.changeTextByTestId('teams-create-description', invalid);
        });
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('teams.errors.invalidDescription');
        expect(screen.findByTestId('teams-create-description')?.props.value).toBe(invalid);
        act(() => screen.changeTextByTestId('teams-create-description', 'Shared work'));
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(false);
        expect(screen.getTextContent()).not.toContain('teams.errors.invalidDescription');
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(0);
    });

    it('UX exposes pending owner search and retries its failure without losing Team fields', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'admin-a', teamsEnabled: true });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        let releaseSearch = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseSearch = resolve; });
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { status: 503, body: { error: 'unavailable' }, respondAfter });
        const screen = await renderCreate(home);
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-search')).not.toBeNull());
        act(() => {
            screen.changeTextByTestId('teams-create-name', 'Platform');
            screen.changeTextByTestId('teams-create-owner-search', 'Grace');
        });
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-loading')).not.toBeNull());
        await act(async () => releaseSearch());
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-retry')).not.toBeNull(), { timeout: 5000 });
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { body: { accounts: [homeAccountPickerRowFixture('owner-grace', 'Grace')] } });
        await screen.pressByTestIdAsync('teams-create-owner-retry');
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner:owner-grace')).not.toBeNull());
        await screen.pressByTestIdAsync('teams-create-owner:owner-grace');
        expect(screen.findByTestId('teams-create-name')?.props.value).toBe('Platform');
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(false);
    });

    it('UX distinguishes no owner matches from an authoritative search refusal', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'admin-a', teamsEnabled: true });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { body: { accounts: [] } });
        const screen = await renderCreate(home);
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-search')).not.toBeNull());
        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Nobody'));
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-empty')).not.toBeNull());
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { status: 403, body: { error: 'forbidden' } });
        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Elsewhere'));
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-unavailable')).not.toBeNull());
        expect(screen.findByTestId('teams-create-owner-empty')).toBeNull();
        expect(screen.findByTestId('teams-create-owner-retry')).toBeNull();
    });

    it('UX keeps the current owner-search answer when an earlier query is refused late', async () => {
        const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'admin-a', teamsEnabled: true });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        let releaseOldQuery = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseOldQuery = resolve; });
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { status: 403, body: { error: 'forbidden' }, respondAfter });
        const screen = await renderCreate(home);
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner-search')).not.toBeNull());
        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Old'));
        await vi.waitFor(() => expect(harness.requestsFor(HOME_ACCOUNT_SEARCH_PATH)).toHaveLength(1));
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, { body: { accounts: [homeAccountPickerRowFixture('owner-grace', 'Grace')] } });
        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Grace'));
        await vi.waitFor(() => expect(screen.findByTestId('teams-create-owner:owner-grace')).not.toBeNull());
        await act(async () => { releaseOldQuery(); await flushHookEffects(); });
        expect(screen.findByTestId('teams-create-owner:owner-grace')).not.toBeNull();
        expect(screen.findByTestId('teams-create-owner-unavailable')).toBeNull();
    });

    it('starts only one Team creation when activated twice before the busy state renders', async () => {
        let releaseCreate = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseCreate = resolve; });
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        harness.answer(home, TEAM_CREATE_PATH, {
            body: teamSummaryFixture({ id: 'server-team-id', name: 'Platform' }),
            respondAfter,
        });

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        act(() => {
            screen.pressByTestId('teams-create-submit');
            screen.pressByTestId('teams-create-submit');
        });

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1));
        await act(async () => releaseCreate());
    });

    it('admits an ordinary member from only the minimum eligibility projection', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit');
        });

        expect(harness.requestsFor(ELIGIBILITY_PATH)).toHaveLength(1);
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-owner-search');
    });

    it('uses the full projection only for an explicit admitted Home Administration entry', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'admin-a',
            teamsEnabled: true,
        });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderCreate(home);
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });

        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(ELIGIBILITY_PATH)).toHaveLength(0);
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);
    });

    it('reaches the Home Administration form when the entry names the Home by its device profile id', async () => {
        // A Home that published its portable identity is scoped by that identity,
        // not by the device-local profile id. The entry must still settle.
        const home = await harness.addHome({
            name: 'Identity Home',
            // Its own address: an earlier case's Home A must not share transport state with it.
            serverUrl: 'https://identity-home.example',
            serverIdentityId: 'srv_identity_home',
            accountId: 'admin-a',
            teamsEnabled: true,
            // Addressed explicitly, not as the focused Home.
            active: false,
        });
        expect(home).not.toBe('srv_identity_home');
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });

        const screen = await renderCreate(home);
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-loading');
    });

    it('explains an ownerless Home instead of calling the administrator unauthorized', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'admin-a',
            teamsEnabled: true,
        });
        harness.answer(home, GOVERNANCE_PATH, {
            status: 409,
            body: { error: 'home_governance_setup_required' },
        });

        const screen = await renderCreate(home);
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-setup-required');
        });
        expect(screen.getTextContent()).toContain('homeGovernance.setupRequiredTitle');
        expect(screen.getTextContent()).not.toContain('homeGovernance.forbiddenTitle');

        // Refresh asks the Home again; an owner assigned meanwhile opens the form.
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        await screen.pressByTestIdAsync('teams-create-setup-required-action');
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });
    });

    it('does not claim creation is administered when the Home never said whether it offers Teams', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
        });
        // A failed capability read leaves Teams unknown; a held request is
        // still loading and has not yet established an unavailable Home.
        harness.answer(home, '/v1/features', { status: 503, body: {} });
        harness.answer(home, '/v1/features/authenticated', { status: 503, body: {} });
        await harness.selectHomes([home]);

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-unavailable');
        });
        expect(screen.getTextContent()).toContain('teams.errors.loadFailed');
        expect(screen.getTextContent()).not.toContain('teams.unavailable.offline');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-managed-only');
    });

    it('says a Home has Teams turned off rather than that creation is administered', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: false, createTeam: false, createTeamForChosenAccount: false } });

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-unavailable');
        });
        expect(screen.getTextContent()).toContain('teams.unavailable.disabled');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-managed-only');
    });

    it('says creation is administered only when the Home answered so', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false } });

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-managed-only');
        });
    });

    it('asks an administrator for the first owner when this Home creates Teams for a chosen Account', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'admin-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: true },
        });
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, {
            body: { accounts: [homeAccountPickerRowFixture('owner-grace', 'Grace')] },
        });
        harness.answer(home, TEAM_CREATE_PATH, { body: teamSummaryFixture({ id: 'server-team-id', name: 'Platform' }) });

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        // Without a chosen owner the Home would refuse the Team, so the form cannot submit.
        expect(screen.findByTestId('teams-create-submit')?.props.disabled).toBe(true);

        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Grace'));
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner:owner-grace');
        });
        await screen.pressByTestIdAsync('teams-create-owner:owner-grace');
        await screen.pressByTestIdAsync('teams-create-submit');

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_CREATE_PATH)[0]?.input).toMatchObject({ initialOwnerAccountId: 'owner-grace' });
        // The minimum eligibility answer decides this; the administrative projection is not read.
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });

    it('explains a creation refused for want of a first owner instead of calling the name invalid', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'admin-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false },
        });
        harness.answer(home, TEAM_CREATE_PATH, { status: 400, body: { error: 'invalid_team_input' } });

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        // The Home's policy changed after it last answered.
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: true },
        });
        await screen.pressByTestIdAsync('teams-create-submit');

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('teams.create.initialOwnerRequired');
        });
        expect(screen.getTextContent()).not.toContain('teams.errors.invalidName');
        // The Home is asked again, and its current answer brings the owner picker.
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });
    });

    it('exposes Home and initial-owner choices as labeled radio groups with checked state', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'admin-a',
            teamsEnabled: true,
        });
        harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
        harness.answer(home, HOME_ACCOUNT_SEARCH_PATH, {
            body: { accounts: [homeAccountPickerRowFixture('owner-grace', 'Grace')] },
        });

        const screen = await renderCreate(home);
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner-search');
        });

        // A single eligible Home is named on the header meta line (craft critique 9.3), not a
        // one-option radio group; several Homes remain a labeled radio group.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-create-home:${home}`);
        expect(screen.tree.root.findAll((node) => node.props.testID === `teams-create-home:${home}`
            && (node.props.accessibilityRole === 'radio' || node.props.role === 'radio'))).toHaveLength(0);

        act(() => screen.changeTextByTestId('teams-create-owner-search', 'Grace'));
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-owner:owner-grace');
        });

        const owner = screen.findByTestId('teams-create-owner:owner-grace');
        expect([owner?.props.accessibilityRole, owner?.props.role]).toContain('radio');
        expect(owner?.props.accessibilityState).toMatchObject({ checked: false });

        let ownerGroup = owner?.parent ?? null;
        while (ownerGroup
            && ownerGroup.props.accessibilityRole !== 'radiogroup'
            && ownerGroup.props.role !== 'radiogroup') {
            ownerGroup = ownerGroup.parent;
        }
        expect(ownerGroup).not.toBeNull();
        expect(ownerGroup?.props.accessibilityLabel ?? ownerGroup?.props['aria-label']).toBe('teams.create.initialOwnerLabel');

        await screen.pressByTestIdAsync('teams-create-owner:owner-grace');
        expect(screen.findByTestId('teams-create-owner:owner-grace')?.props.accessibilityState)
            .toMatchObject({ checked: true });
    });

    it('keeps an eligible Home visible but makes creation read-only after an offline refresh', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });

        const screen = await renderCreate();
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit');
        });

        const { applyHomeGovernanceEligibilityFailure } = await import(
            '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots'
        );
        act(() => applyHomeGovernanceEligibilityFailure({
            scope: { serverId: home, accountId: 'member-a' },
            error: { kind: 'unreachable', retryable: true },
        }));

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-stale');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-submit');
        expect(screen.findByTestId(`teams-create-home:${home}`)).not.toBeNull();
    });

    it('creates once, then uploads a confirmed logo using the returned Team id and captured Home', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        const created = teamSummaryFixture({
            id: 'server-team-id',
            name: 'Platform',
            capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        });
        harness.answer(home, TEAM_CREATE_PATH, { body: created });
        harness.answer(home, TEAM_LOGO_SET_PATH, {
            body: { ...created, logo: { path: 'teams/server-team-id/logo.webp', url: 'https://home-a.example/logo.webp', thumbhash: 'logo' } },
        });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: { type: 'image/png', arrayBuffer: async () => bytes.buffer },
        }]);

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        await screen.pressByTestIdAsync('teams-create-logo-set');
        await screen.pressByTestIdAsync('teams-create-logo-use');
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(0);

        await screen.pressByTestIdAsync('teams-create-submit');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)[0]).toMatchObject({
            serverId: home,
            input: { teamId: 'server-team-id', image: { mimeType: 'image/png' } },
        });
        // Navigation follows the published logo, not the issued request: the
        // Team is opened once the Home's answer has been accepted.
        await vi.waitFor(() => expect(routerReplace)
            .toHaveBeenCalledWith(`/settings/teams/${home}/server-team-id`));
    });

    it('retains a confirmed logo after upload failure and retries without creating another Team', async () => {
        const home = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        const created = teamSummaryFixture({ id: 'server-team-id', name: 'Platform' });
        harness.answer(home, TEAM_CREATE_PATH, { body: created });
        harness.answer(home, TEAM_LOGO_SET_PATH, { status: 503, body: { error: 'unavailable' } });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: { type: 'image/png', arrayBuffer: async () => bytes.buffer },
        }]);

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        await screen.pressByTestIdAsync('teams-create-logo-set');
        await screen.pressByTestIdAsync('teams-create-logo-use');
        await screen.pressByTestIdAsync('teams-create-submit');

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-continue-without-logo');
        });
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(1);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('data:image/png;base64,');

        harness.answer(home, TEAM_LOGO_SET_PATH, {
            body: { ...created, logo: { path: 'teams/server-team-id/logo.webp', url: 'https://home-a.example/logo.webp', thumbhash: 'logo' } },
        });
        await screen.pressByTestIdAsync('teams-create-submit');
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalled());
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toHaveLength(2);
    });

    it('keeps logo retry and navigation bound to the Home whose delayed create committed', async () => {
        const homeA = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://home-a.example',
            accountId: 'member-a',
            teamsEnabled: true,
        });
        const homeB = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'member-b',
            teamsEnabled: true,
        });
        await harness.selectHomes([homeA, homeB]);
        harness.answer(homeA, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });
        harness.answer(homeB, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false } });

        let releaseCreateResponse = (): void => {};
        const createResponseGate = new Promise<void>((resolve) => {
            releaseCreateResponse = resolve;
        });
        const created = teamSummaryFixture({ id: 'same-team-id', name: 'Platform' });
        harness.answer(homeA, TEAM_CREATE_PATH, { body: created, respondAfter: createResponseGate });
        harness.answer(homeA, TEAM_LOGO_SET_PATH, { status: 503, body: { error: 'unavailable' } });
        // The same Team id can exist on another Home. An accidental scope switch
        // would therefore look valid unless the owning Home is asserted too.
        harness.answer(homeB, TEAM_LOGO_SET_PATH, {
            body: { ...created, logo: { path: 'teams/server-team-id/logo.webp', url: 'https://home-b.example/logo.webp', thumbhash: 'wrong-home' } },
        });
        const bytes = new Uint8Array([137, 80, 78, 71]);
        pickImages.mockResolvedValue([{
            kind: 'web',
            file: { type: 'image/png', arrayBuffer: async () => bytes.buffer },
        }]);

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        await screen.pressByTestIdAsync(`teams-create-home:${homeA}`);
        act(() => screen.changeTextByTestId('teams-create-name', 'Platform'));
        await screen.pressByTestIdAsync('teams-create-logo-set');
        await screen.pressByTestIdAsync('teams-create-logo-use');

        // Capture the press before submission to model an already-queued Home
        // choice racing the disabled-state render.
        const staleHomeBPress = screen.findByTestId(`teams-create-home:${homeB}`)?.props.onPress;
        screen.pressByTestId('teams-create-submit');
        await vi.waitFor(() => expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1));
        // The submit's busy render commits on React's schedule, not with the request; wait for it
        // before firing the stale press so the race is the one this test names.
        await vi.waitFor(() => expect(screen.findByTestId(`teams-create-home:${homeB}`)?.props.disabled).toBe(true));
        act(() => staleHomeBPress?.());
        act(() => releaseCreateResponse());

        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-continue-without-logo');
        });
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toEqual([
            expect.objectContaining({ serverId: homeA }),
        ]);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH)).toEqual([
            expect.objectContaining({ serverId: homeA, input: expect.objectContaining({ teamId: 'same-team-id' }) }),
        ]);

        harness.answer(homeA, TEAM_LOGO_SET_PATH, {
            body: { ...created, logo: { path: 'teams/server-team-id/logo.webp', url: 'https://home-a.example/logo.webp', thumbhash: 'right-home' } },
        });
        await screen.pressByTestIdAsync('teams-create-submit');
        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalledWith(
            `/settings/teams/${homeA}/same-team-id`,
        ));
        expect(harness.requestsFor(TEAM_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(TEAM_LOGO_SET_PATH).map((request) => request.serverId)).toEqual([homeA, homeA]);
    });
});
