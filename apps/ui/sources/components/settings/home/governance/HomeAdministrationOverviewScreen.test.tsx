import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported from their own testkit modules rather than the `@/dev/testkit` barrel: see
// `HomeAdministrationPeopleScreen.test.tsx` for why the barrel would bind the real transports first.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeAccountRowFixture,
    homeGovernanceProjectionFixture,
    homeMailDeliveryReadinessFixture,
    homeReachabilityFixture,
    homeSettingEntryFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ pathname: '/settings/home' }));
const windowState = vi.hoisted(() => ({ width: 1440, height: 1000 }));
const routerPush = vi.hoisted(() => vi.fn());
const modal = vi.hoisted(() => ({
    show: null as null | ((config: unknown) => string),
    prompt: null as null | { mockResolvedValueOnce: (value: string | null) => void },
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, any>) => React.createElement(
        'VirtualizedList',
        props,
        props.ListHeaderComponent,
        ...(props.data ?? []).map((item: unknown, index: number) => props.renderItem({ item, index })),
    ),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = () => ({ width: windowState.width, height: windowState.height, scale: 1, fontScale: 1 });
        return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => route.pathname,
            params: () => ({ serverId: route.pathname.split('/')[3] ?? '' }),
            navigation: { setOptions: vi.fn() },
            router: { push: routerPush, replace: vi.fn(), dismissTo: vi.fn() },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const mock = createModalModuleMock();
        modal.show = mock.spies.show as unknown as (config: unknown) => string;
        modal.prompt = mock.spies.prompt as unknown as { mockResolvedValueOnce: (value: string | null) => void };
        return mock.module;
    },
});

// Only the network and the device credential store are replaced; the Home binding, engine, stores,
// the Team section and the invitation form below them are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const ACCOUNTS_PATH = '/v1/home/accounts/list';
const SETTINGS_PATH = '/v1/home/settings/get';
const MAIL_PATH = '/v1/home/mail-delivery/get';
const REACH_PATH = '/v1/home/reachability/get';
const SETTINGS_SET_PATH = '/v1/home/settings/set';
const TEAMS_LIST_PATH = '/v1/teams/list';
const TEAM_GET_PATH = '/v1/teams/get';
const INVITATION_LIST_PATH = '/v1/teams/invitations/list';
const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';

const ids = (screen: RenderScreenResult) => collectRenderedTestIds(screen.tree.toJSON());
const inOrder = (screen: RenderScreenResult, prefix: string) => ids(screen)
    .filter((id) => id.startsWith(prefix) && !id.slice(prefix.length).includes('.'))
    .map((id) => id.slice(prefix.length))
    .filter((id, index, all) => all.indexOf(id) === index);

/** A Home whose owners answered everything; a case replaces what it is about. */
async function addHome(): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true });
    await harness.selectHomes([home]);
    harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
    harness.answer(home, ACCOUNTS_PATH, {
        body: {
            items: [
                homeAccountRowFixture('account-ada', { homeRole: 'owner' }),
                homeAccountRowFixture('account-bo', { homeRole: 'owner' }),
                homeAccountRowFixture('account-cy', { homeRole: 'admin' }),
                homeAccountRowFixture('account-di'),
            ],
            nextCursor: null,
        },
    });
    harness.answer(home, SETTINGS_PATH, { body: homeSettingsProjectionFixture({ entries: [] }) });
    harness.answer(home, MAIL_PATH, { body: homeMailDeliveryReadinessFixture() });
    harness.answer(home, REACH_PATH, { body: homeReachabilityFixture() });
    return home;
}

async function resetEngines() {
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
}

async function renderOverview(home: string): Promise<RenderScreenResult> {
    route.pathname = `/settings/home/${home}`;
    const { HomeConsoleShell } = await import('./HomeConsoleNavigation');
    const { HomeAdministrationOverviewScreen } = await import('./HomeAdministrationOverviewScreen');
    await resetEngines();
    return renderScreen(
        <HomeConsoleShell serverId={home} rail="console"><HomeAdministrationOverviewScreen serverId={home} /></HomeConsoleShell>,
    );
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    resetHomeGovernanceSnapshotsForTests();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    windowState.width = 1440;
    windowState.height = 1000;
    routerPush.mockReset();
    (modal.show as unknown as { mockClear?: () => void } | null)?.mockClear?.();
});

afterEach(() => {
    standardCleanup();
});

describe('Home console Overview (A)', () => {
    it('says what needs the owner, who owns the Home and what it is, and does not list the pages its sidebar already shows', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_PATH, {
            body: homeSettingsProjectionFixture({
                entries: [
                    homeSettingEntryFixture('METRICS_PORT', {
                        source: 'home', value: 70000, apply: 'restart',
                        applied: { value: 9090, pending: false, ignoredReason: 'out_of_bounds' },
                    }),
                    homeSettingEntryFixture('HAPPIER_SERVER_UI_DIR', {
                        source: 'home', value: '/srv/ui', apply: 'restart',
                        applied: { value: null, pending: true },
                    }),
                    homeSettingEntryFixture('HAPPIER_API_TRUST_PROXY', { source: 'deployment', value: true, fixed: true }),
                    homeSettingEntryFixture('HAPPIER_API_CORS_MAX_AGE_SECONDS', { source: 'deployment', value: 60, fixed: true }),
                    // WorkOS with only its API key: a sign-in platform half set up is trouble.
                    homeSettingEntryFixture('WORKOS_API_KEY', {
                        source: 'home', secretSet: true, apply: 'restart',
                        declaration: { type: 'string', section: 'policies', group: 'workos' },
                    }),
                    homeSettingEntryFixture('WORKOS_CLIENT_ID', {
                        apply: 'restart', declaration: { type: 'string', section: 'policies', group: 'workos' },
                    }),
                ],
            }),
        });
        harness.answer(home, MAIL_PATH, {
            body: homeMailDeliveryReadinessFixture({ transportConfigured: false, ready: false }),
        });
        harness.answer(home, REACH_PATH, {
            body: homeReachabilityFixture({ publicAddress: { url: null, source: 'none' } }),
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-attention:pending'));

        // What needs the owner, most urgent first, each from its owner's answer (lab `hcOverview-R`):
        // a value the last start refused, then the restart that applies saved changes, then sign-in
        // set-up, then the rest. Values the deployment fixes are healthy facts, never attention (DR-14).
        expect(inOrder(screen, 'home-overview-attention:')).toEqual(['ignored', 'pending', 'platform:workos', 'email', 'address']);
        expect(screen.getTextContent()).not.toContain('homeGovernance.overviewPage.fixedTitle');
        expect(screen.getTextContent()).toContain('homeGovernance.runtime.pendingRestart(count=1)');
        // The pending row names what waits, through the restart banner's own summary.
        expect(screen.getTextContent()).toContain('homeSettings.banner.pendingNames(');
        expect(screen.getTextContent()).not.toContain('homeGovernance.overviewPage.pendingBody');
        // A half-set platform says what it needs and what that blocks.
        expect(screen.getTextContent()).toContain('homeGovernance.overviewPage.workosNeedsClientIdBody');
        // This device cannot restart this Home's runtime, so the row leads to Runtime, which says where.
        await act(async () => screen.pressByTestId('home-overview-attention:pending.action'));
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${home}/runtime`);
        // A half-set platform leads to its own row, opened.
        await act(async () => screen.pressByTestId('home-overview-attention:platform:workos.action'));
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${home}/sign-in-providers?setting=${encodeURIComponent(
            'homeAdministration.signInProviders.workos',
        )}`);
        // Who owns it: the two active owners, then the People summary.
        expect(inOrder(screen, 'home-overview-owner:')).toEqual(['account-ada', 'account-bo']);
        expect(screen.getTextContent())
            .toContain('homeGovernance.overviewPage.peopleSummary(people=4,more=false,owners=2,admins=1)');
        expect(ids(screen)).toEqual(expect.arrayContaining(['home-overview-version', 'home-overview-address', 'home-overview-sign-in']));
        // The console's sidebar lists the pages; Overview does not repeat them.
        expect(ids(screen).filter((id) => /^home-admin-[a-z-]+-link$/.test(id))).toEqual([]);

        await act(async () => screen.pressByTestId('home-overview-attention:email.action'));
        expect(routerPush).toHaveBeenCalledWith(`/settings/home/${home}/email`);
    });

    it('drops healthy rows, and states a failed read in its own section while the rest still render', async () => {
        const home = await addHome();
        harness.answer(home, MAIL_PATH, { status: 500, body: { error: 'internal' } });
        harness.answer(home, ACCOUNTS_PATH, { status: 500, body: { error: 'internal' } });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-attention-failed:email'));
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-ownership-failed'));

        // Reach answered: its address is a fact, not a problem; nothing healthy asks for attention.
        expect(inOrder(screen, 'home-overview-attention:')).toEqual([]);
        expect(ids(screen)).toContain('home-overview-address');
        expect(ids(screen)).not.toContain('home-overview-attention-failed:reach');
        expect(ids(screen)).not.toContain('home-overview-attention-loading');
    });

    it('names the viewer "Your account" when they have no name, never "Unnamed account"', async () => {
        const home = await addHome();
        const unnamed = { firstName: null, lastName: null, username: null, avatarUrl: null };
        harness.answer(home, ACCOUNTS_PATH, {
            body: {
                items: [
                    homeAccountRowFixture('account-ada', { homeRole: 'owner', profile: unnamed }),
                    homeAccountRowFixture('account-bo', { homeRole: 'owner', profile: unnamed }),
                ],
                nextCursor: null,
            },
        });
        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-owner:account-ada'));
        const row = (id: string) => screen.root.findAll((node) => node.props.testID === `home-overview-owner:${id}` && node.props.title !== undefined)[0];
        // The viewer (account-ada) is "Your account", and the name already says it is them.
        expect(row('account-ada')?.props.title).toBe('accountDisplay.yours');
        expect(row('account-ada')?.props.subtitle).toBe('homeGovernance.roleOwner');
        // Anyone else unnamed stays "Unnamed account".
        expect(row('account-bo')?.props.title).toBe('accountDisplay.unnamed');
    });

    it('reads on through the roster until every active owner is listed', async () => {
        const home = await addHome();
        harness.answer(home, ACCOUNTS_PATH, {
            body: { items: [homeAccountRowFixture('account-di'), homeAccountRowFixture('account-bo', { homeRole: 'owner' })], nextCursor: 'page-2' },
            select: (input) => ((input as { cursor?: string } | null)?.cursor === 'page-2'
                ? { body: { items: [homeAccountRowFixture('account-ada', { homeRole: 'owner' })], nextCursor: 'page-3' } }
                : undefined),
        });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(inOrder(screen, 'home-overview-owner:')).toEqual(['account-bo', 'account-ada']));
        // Both owners found: the third page is never asked for.
        expect(harness.requestsFor(ACCOUNTS_PATH).map((request) => (request.input as { cursor?: string } | null)?.cursor ?? null))
            .toEqual([null, 'page-2']);
        expect(screen.getTextContent())
            .toContain('homeGovernance.overviewPage.peopleSummary(people=3,more=true,owners=2,admins=null)');
    });

    it('renames the Home where its name is shown, through the one settings writer (DR-08)', async () => {
        const home = await addHome();
        const name = (value: string) => homeSettingEntryFixture('HAPPIER_HOME_DISPLAY_NAME', {
            value, source: 'home', declaration: { type: 'string', section: 'reach', group: 'identity' },
        });
        harness.answer(home, SETTINGS_PATH, { body: homeSettingsProjectionFixture({ revision: 3, entries: [name('Acme')] }) });
        harness.answer(home, SETTINGS_SET_PATH, { body: homeSettingsProjectionFixture({ revision: 4, entries: [name('Studio')] }) });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-name.rename'));
        modal.prompt!.mockResolvedValueOnce('Studio');
        await act(async () => screen.pressByTestId('home-overview-name.rename'));

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET_PATH).map((request) => request.input)).toEqual([
                { expectedRevision: 3, values: { HAPPIER_HOME_DISPLAY_NAME: 'Studio' } },
            ]);
        });
    });

    it('lists the pages under what needs attention on a phone, where there is no sidebar', async () => {
        windowState.width = 390;
        windowState.height = 844;
        const home = await addHome();
        harness.answer(home, MAIL_PATH, { body: homeMailDeliveryReadinessFixture({ transportConfigured: false, ready: false }) });

        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-admin-people-link'));
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-attention:email'));
        const all = ids(screen);
        expect(all.indexOf('home-overview-attention:email')).toBeLessThan(all.indexOf('home-admin-people-link'));
    });
});

describe('Invite people', () => {
    async function pressInvite(render: () => Promise<RenderScreenResult>, testID: string) {
        const screen = await render();
        await waitForHomeGovernance(() => expect(ids(screen)).toContain(testID));
        await act(async () => screen.pressByTestId(testID));
        return screen;
    }

    it('opens the one dialog from Overview, People and Teams', async () => {
        const home = await addHome();
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        const { HomeInvitePeopleDialog } = await import('./HomeInvitePeopleDialog');
        const { HomeAdministrationPeopleScreen } = await import('./HomeAdministrationPeopleScreen');
        const { HomeAdministrationTeamsScreen } = await import('./HomeAdministrationTeamsScreen');

        await pressInvite(() => renderOverview(home), 'home-overview-invite');
        await pressInvite(async () => { await resetEngines(); return renderScreen(<HomeAdministrationPeopleScreen serverId={home} />); }, 'home-people-invite');
        await pressInvite(async () => { await resetEngines(); return renderScreen(<HomeAdministrationTeamsScreen serverId={home} />); }, 'home-teams-invite');

        const shown = vi.mocked(modal.show!).mock.calls.map(([config]) => config as { component: unknown; props: unknown });
        expect(shown).toHaveLength(3);
        for (const config of shown) {
            expect(config.component).toBe(HomeInvitePeopleDialog);
            expect(config.props).toEqual({ serverId: home });
        }
    });

    it('offers no invitation to a viewer who does not govern the Home\'s Teams', async () => {
        const home = await addHome();
        const projection = homeGovernanceProjectionFixture();
        harness.answer(home, GOVERNANCE_PATH, {
            body: { ...projection, capabilities: { ...projection.capabilities, manageAllTeams: false } },
        });
        const screen = await renderOverview(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-overview-version'));
        expect(ids(screen)).not.toContain('home-overview-invite');
    });

    async function renderDialog(home: string) {
        const { HomeInvitePeopleDialog } = await import('./HomeInvitePeopleDialog');
        return renderScreen(<HomeInvitePeopleDialog serverId={home} onClose={vi.fn()} />);
    }

    function answerTeam(home: string, teamId: string, name: string) {
        return teamSummaryFixture({
            id: teamId,
            name,
            capabilities: teamCapabilitiesFixture({ manageInvitations: true }),
        });
    }

    it('goes straight to the invitation form when the viewer can invite to one Team (a Personal Home)', async () => {
        const home = await addHome();
        const team = answerTeam(home, 'team-1', 'Personal');
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [team, teamSummaryFixture({ id: 'team-ro', name: 'Read only' })], nextCursor: null },
        });
        harness.answer(home, TEAM_GET_PATH, { body: team });
        harness.answer(home, INVITATION_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });

        const screen = await renderDialog(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('team-invite-submit'));
        expect(ids(screen).filter((id) => id.startsWith('home-invite-people-team:'))).toEqual([]);
        expect(screen.getTextContent()).toContain('teams.invitations.inviteTitle(team=Personal)');
    });

    it('asks which Team first when there are several, then shows that Team\'s form', async () => {
        const home = await addHome();
        const platform = answerTeam(home, 'team-1', 'Platform');
        const design = answerTeam(home, 'team-2', 'Design');
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [platform, design], nextCursor: null } });
        harness.answer(home, TEAM_GET_PATH, { body: design, select: (input) => (
            (input as { teamId?: string } | undefined)?.teamId === 'team-1' ? { body: platform } : undefined
        ) });
        harness.answer(home, INVITATION_LIST_PATH, {
            body: { items: [], nextCursor: null, emailDelivery: 'available', linkDelivery: 'available' },
        });

        const screen = await renderDialog(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-invite-people-team:team-2'));
        expect(ids(screen)).not.toContain('team-invite-submit');

        await act(async () => screen.pressByTestId('home-invite-people-team:team-2'));
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('team-invite-submit'));
        expect(screen.getTextContent()).toContain('teams.invitations.inviteTitle(team=Design)');
    });

    it('says who invites when the Home has Teams but the viewer administers none of them', async () => {
        const home = await addHome();
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-ro', name: 'Platform', viewerRole: null })], nextCursor: null },
        });
        const screen = await renderDialog(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-invite-people-not-administered'));
        expect(ids(screen)).not.toContain('home-invite-people-no-teams');
        expect(ids(screen)).not.toContain('team-invite-submit');
    });

    it('offers Create a Team, the Team creation page, when the viewer administers no Team but may create one', async () => {
        const home = await addHome();
        harness.answer(home, TEAMS_LIST_PATH, {
            body: { items: [teamSummaryFixture({ id: 'team-ro', name: 'Platform', viewerRole: null })], nextCursor: null },
        });
        harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: true, teamCreationPolicy: 'managed_only' } });
        const onClose = vi.fn();
        const { HomeInvitePeopleDialog } = await import('./HomeInvitePeopleDialog');
        const screen = await renderScreen(<HomeInvitePeopleDialog serverId={home} onClose={onClose} />);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-invite-people-create-team'));
        expect(ids(screen)).toContain('home-invite-people-not-administered');

        await act(async () => screen.pressByTestId('home-invite-people-create-team'));
        expect(onClose).toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/new?administrationServerId=${encodeURIComponent(home)}`);
    });

    it('says who creates Teams instead of offering an action that cannot succeed', async () => {
        const home = await addHome();
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false, teamCreationPolicy: 'managed_only', administratorNames: ['Ada'] },
        });
        const screen = await renderDialog(home);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.directory.createAdministered(names=Ada)'));
        expect(ids(screen)).not.toContain('home-invite-people-create-team');
    });

    it('says there is no Team to invite to rather than offering a form', async () => {
        const home = await addHome();
        harness.answer(home, TEAMS_LIST_PATH, { body: { items: [], nextCursor: null } });
        const screen = await renderDialog(home);
        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-invite-people-no-teams'));
        expect(ids(screen)).not.toContain('team-invite-submit');
    });
});
