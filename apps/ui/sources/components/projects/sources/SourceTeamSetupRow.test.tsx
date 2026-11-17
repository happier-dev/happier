import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderScreen,
  standardCleanup,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));

// Platform boundaries only: the router records where a press leads; Teams directory and the
// Source hint run their real owners behind the Home HTTP boundary.
installSettingsViewCommonModuleMocks({
  storage: 'real',
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock();
    router.spies.push.mockImplementation((href: unknown) => {
      nav.pushed.push(href);
    });
    return router.module;
  },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { SourceTeamSetupRow } =
  await import('@/components/projects/sources/SourceTeamSetupRow');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } =
  await import('@/sync/engine/teams/teamsDirectoryEngine');

const TEAMS_LIST_PATH = '/v1/teams/list';
const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';

async function memberHome(
  teams: readonly Readonly<{ id: string; name: string }>[],
) {
  const home = await harness.addHome({
    name: 'Studio',
    serverUrl: 'https://studio.example',
    accountId: 'member-a',
    teamsEnabled: true,
    active: true,
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
    body: {
      items: teams.map((team) => teamSummaryFixture(team)),
      nextCursor: null,
    },
  });
  return home;
}

function setupPath(home: string, teamId: string) {
  return `/teams/${encodeURIComponent(teamId)}/setup?serverId=${encodeURIComponent(home)}`;
}

function source(audienceTeamId: string | null): ProjectSourceV1 {
  return {
    id: 'source-1',
    name: 'web',
    revision: 1,
    createdByAccountId: 'member-a',
    audience: audienceTeamId
      ? [{ principal: { kind: 'team', teamId: audienceTeamId }, level: 'view' }]
      : [],
  } as unknown as ProjectSourceV1;
}

beforeEach(async () => {
  nav.pushed = [];
  resetTeamsSnapshotsForTests();
  resetTeamsDirectoryEngineForTests();
  await harness.reset();
  await harness.selectHomes([]);
});
afterEach(() => standardCleanup());

describe('Source detail Team setup row', () => {
  it("links a Source shared with a Team the person belongs to to that Team's setup", async () => {
    const home = await memberHome([{ id: 'team-1', name: 'Acme' }]);
    const screen = await renderScreen(
      <SourceTeamSetupRow serverId={home} source={source('team-1')} />,
    );
    const button = () =>
      screen.tree
        .findAllByType(RoundButton)
        .find(
          (node) =>
            node.props.testID === 'projects.sources.detail.teamSetup.action',
        );
    await waitForHomeGovernance(() => expect(button()).toBeDefined());

    await act(async () => {
      button()!.props.onPress();
    });
    expect(nav.pushed).toEqual([setupPath(home, 'team-1')]);
  });

  it('shows nothing for a Source that names no Team', async () => {
    const home = await memberHome([{ id: 'team-1', name: 'Acme' }]);
    const screen = await renderScreen(
      <SourceTeamSetupRow serverId={home} source={source(null)} />,
    );
    expect(screen.tree.toJSON()).toBeNull();
    expect(harness.requestsFor(TEAMS_LIST_PATH)).toHaveLength(0);
  });
});
