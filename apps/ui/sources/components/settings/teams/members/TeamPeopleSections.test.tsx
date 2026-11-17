import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  collectRenderedTestIds,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamMembershipFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

// Platform resolution is the boundary here: the People page reads a roster only for a section on screen,
// which the web build decides through `LazyMountOnScreen.web`'s IntersectionObserver.
vi.mock('@/components/ui/performance/LazyMountOnScreen', async () => {
  const implementation = await import('@/components/ui/performance/LazyMountOnScreen.web');
  return { LazyMountOnScreen: implementation.LazyMountOnScreen };
});

type ControlledObserver = Readonly<{ intersect: () => void }>;

/** Runs `run` with the browser's visibility boundary (window, document, IntersectionObserver) controlled. */
async function withControlledVisibility(run: (observers: ControlledObserver[]) => Promise<void>): Promise<void> {
  const runtime = globalThis as Record<string, unknown>;
  const previous = { window: runtime.window, document: runtime.document, IntersectionObserver: runtime.IntersectionObserver };
  const observers: ControlledObserver[] = [];
  class ControlledIntersectionObserver {
    public constructor(callback: (entries: readonly Readonly<{ isIntersecting: boolean }>[]) => void) {
      observers.push({ intersect: () => callback([{ isIntersecting: true }]) });
    }
    public disconnect() {}
    public observe() {}
  }
  try {
    Object.assign(globalThis, {
      window: { getComputedStyle: () => ({ overflowY: 'visible' }) },
      // Spinners register their shared sheet by id; an existing one means nothing to inject.
      document: { getElementById: () => ({}) },
      IntersectionObserver: ControlledIntersectionObserver,
    });
    await run(observers);
  } finally {
    Object.assign(globalThis, previous);
  }
}

const renderedText = (screen: Readonly<{ tree: { toJSON: () => unknown } }>) => JSON.stringify(screen.tree.toJSON());

installSettingsViewCommonModuleMocks({
    storage: 'real',
  router: async () => ({
    useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
    useNavigation: () => ({ setOptions: vi.fn() }),
    useLocalSearchParams: () => ({}),
  }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Import the real component at collection, after the boundaries: a cold import inside a test body can outlast it.
const { TeamPeopleSections } = await import('./TeamPeopleSections');

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';
const TEAMS_LIST_PATH = '/v1/teams/list';
const MEMBERS_LIST_PATH = '/v1/teams/members/list';

async function memberHome(team: ReturnType<typeof teamSummaryFixture>) {
  const home = await harness.addHome({
    name: 'Studio',
    serverUrl: 'https://studio.example',
    accountId: 'member-a',
    teamsEnabled: true,
  });
  await harness.selectHomes([home]);
  harness.answer(home, ELIGIBILITY_PATH, {
    body: {
      teamsEnabled: true,
      createTeam: false,
      createTeamForChosenAccount: false,
      teamCreationPolicy: 'managed_only',
      administratorNames: [],
      showTeams: true,
    },
  });
  harness.answer(home, TEAMS_LIST_PATH, {
    body: { items: [team], nextCursor: null },
  });
  return home;
}

beforeEach(async () => {
  const { resetTeamsSnapshotsForTests } =
    await import('@/sync/store/teams/teamsSnapshots');
  const { resetTeamsDirectoryEngineForTests } =
    await import('@/sync/engine/teams/teamsDirectoryEngine');
  const { resetHomeGovernanceEligibilitySnapshotsForTests } =
    await import('@/sync/store/home/governance/homeGovernanceEligibilitySnapshots');
  const { resetHomeGovernanceEligibilityEngineForTests } =
    await import('@/sync/engine/home/governance/homeGovernanceEligibilityEngine');
  resetTeamsSnapshotsForTests();
  resetTeamsDirectoryEngineForTests();
  resetHomeGovernanceEligibilitySnapshotsForTests();
  resetHomeGovernanceEligibilityEngineForTests();
  await harness.reset();
  await harness.selectHomes([]);
  routerPush.mockReset();
});

afterEach(() => {
  standardCleanup();
});

describe('People page teammates (owner ruling Q6)', () => {
  it('lists each Team’s members from the roster owner and opens each person and the full roster', async () => {
    const home = await memberHome(
      teamSummaryFixture({
        id: 'team-1',
        name: 'Studio',
        capabilities: teamCapabilitiesFixture({ viewRoster: true }),
      }),
    );
    harness.answer(home, MEMBERS_LIST_PATH, {
      body: {
        items: [
          teamMembershipFixture({ accountId: 'member-a' }),
          teamMembershipFixture({
            id: 'membership-3',
            accountId: 'account-third',
          }),
          teamMembershipFixture({
            id: 'membership-2',
            accountId: 'account-other',
          }),
        ],
        nextCursor: null,
      },
    });
    // The People page is a page-presented list; section actions draw only there.
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>);

    await vi.waitFor(() => {
      const ids = collectRenderedTestIds(screen.tree.toJSON());
      expect(ids).toContain('team-members-row:membership-2');
      expect(ids).toContain('team-members-row:membership-3');
    });
    // The viewer's own membership is the section's role line, not a row of People.
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-members-row:membership-1');
    // Only the Members page offers leave and role changes; People only opens them.
    expect(
      collectRenderedTestIds(screen.tree.toJSON()).some((id) =>
        id.startsWith('team-members-leave:'),
      ),
    ).toBe(false);

    await screen.pressByTestIdAsync('team-members-row:membership-2');
    expect(routerPush).toHaveBeenLastCalledWith(
      `/settings/teams/${encodeURIComponent(home)}/team-1/members/membership-2`,
    );
    await screen.pressByTestIdAsync(`people-team-members:${home}:team-1`);
    expect(routerPush).toHaveBeenLastCalledWith(
      `/settings/teams/${encodeURIComponent(home)}/team-1/members`,
    );
  });

  it('says a roster it may not read is denied instead of showing an empty Team', async () => {
    const home = await memberHome(
      teamSummaryFixture({
        id: 'team-1',
        name: 'Studio',
        capabilities: teamCapabilitiesFixture({ viewRoster: false }),
      }),
    );
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>);
    await vi.waitFor(() =>
      expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(
        `people-team-denied:${home}:team-1`,
      ),
    );
    expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(0);
  });

  it('reads a Team’s roster only once its section reaches the screen, and nothing after it settles', async () => {
    await withControlledVisibility(async (observers) => {
      const counts = { members: 3, suspendedMembers: 0, groups: 0, waitingInvitations: null };
      const home = await harness.addHome({ name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true });
      await harness.selectHomes([home]);
      harness.answer(home, ELIGIBILITY_PATH, { body: { teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false, teamCreationPolicy: 'managed_only', administratorNames: [], showTeams: true } });
      harness.answer(home, TEAMS_LIST_PATH, { body: { items: [
        teamSummaryFixture({ id: 'team-1', name: 'Studio', counts, capabilities: teamCapabilitiesFixture({ viewRoster: true }) }),
        teamSummaryFixture({ id: 'team-2', name: 'Design', counts, capabilities: teamCapabilitiesFixture({ viewRoster: true }) }),
      ], nextCursor: null } });
      harness.answer(home, MEMBERS_LIST_PATH, { body: { items: [
        teamMembershipFixture({ accountId: 'member-a' }),
        teamMembershipFixture({ id: 'membership-2', accountId: 'account-other' }),
      ], nextCursor: null } });
      const { ItemList } = await import('@/components/ui/lists/ItemList');
      const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>, {
        createNodeMock: (element) => ((element as Readonly<{ type?: unknown }>).type === 'div' ? {} : null),
      });

      // Both sections draw their line and reserve their rows; neither has asked its Home yet.
      await vi.waitFor(() => expect(observers).toHaveLength(2));
      const ids = collectRenderedTestIds(screen.tree.toJSON());
      expect(ids).toContain(`people-team-loading:${home}:team-1-skeleton:0`);
      expect(ids).toContain(`people-team-loading:${home}:team-2-skeleton:0`);
      expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(0);

      await act(async () => { observers[0]?.intersect(); await Promise.resolve(); });
      await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-members-row:membership-2'));
      expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(1);

      await act(async () => { observers[1]?.intersect(); await Promise.resolve(); });
      await vi.waitFor(() => expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(2));
      // Settled: the page asks nothing more on its own.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(2);
      await screen.unmount();
    });
  });

  it('holds a loading roster’s rows with placeholders, not a “Loading Teams…” line', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const home = await memberHome(teamSummaryFixture({
      id: 'team-1', name: 'Studio',
      counts: { members: 3, suspendedMembers: 0, groups: 0, waitingInvitations: null },
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }));
    harness.answer(home, MEMBERS_LIST_PATH, { respondAfter: held, body: { items: [
      teamMembershipFixture({ accountId: 'member-a' }),
      teamMembershipFixture({ id: 'membership-2', accountId: 'account-other' }),
      teamMembershipFixture({ id: 'membership-3', accountId: 'account-third' }),
    ], nextCursor: null } });
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>);

    await vi.waitFor(() => expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(1));
    const ids = collectRenderedTestIds(screen.tree.toJSON());
    // Two teammates are known from the Team's count: two rows are reserved for them.
    expect(ids).toContain(`people-team-loading:${home}:team-1-skeleton:1`);
    expect(ids).not.toContain(`people-team-loading:${home}:team-1-skeleton:2`);
    expect(renderedText(screen)).not.toContain(t('teams.directory.loading'));

    release();
    await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-members-row:membership-3'));
    expect(collectRenderedTestIds(screen.tree.toJSON()).some((id) => id.includes('-skeleton:'))).toBe(false);
  });

  it('says “Only you” for a Team with no one else, reading and drawing no rows', async () => {
    const home = await memberHome(teamSummaryFixture({
      id: 'team-1', name: 'Studio',
      counts: { members: 1, suspendedMembers: 0, groups: 0, waitingInvitations: null },
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }));
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>);

    await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`people-team:${home}:team-1`));
    expect(renderedText(screen)).toContain(t('friends.peopleTeamOnlyYou'));
    expect(renderedText(screen)).not.toContain(t('teams.groups.memberCount', { count: 1 }));
    expect(collectRenderedTestIds(screen.tree.toJSON()).some((id) => id.includes('-skeleton:') || id.startsWith('team-members-row:'))).toBe(false);
    expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(0);
  });

  it('a roster that fails says so in its section with Retry', async () => {
    const home = await memberHome(teamSummaryFixture({
      id: 'team-1', name: 'Studio',
      counts: { members: 3, suspendedMembers: 0, groups: 0, waitingInvitations: null },
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }));
    harness.answer(home, MEMBERS_LIST_PATH, { status: 500, body: { error: 'internal' } });
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const screen = await renderScreen(<ItemList><TeamPeopleSections /></ItemList>);

    await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`people-team-error:${home}:team-1-retry`));
    expect(collectRenderedTestIds(screen.tree.toJSON()).some((id) => id.includes('-skeleton:'))).toBe(false);
  });
});
