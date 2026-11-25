import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

/**
 * A Team page names itself with its own large title on a phone; the bar above it is the settings registry's
 * (Back alone). The page publishes nothing into the navigator's title, however the page was entered, so the bar
 * never repeats the page's title (TH-EXPORT-ACCEPT-28 defect 1: "← Team  Members" over the large "Members").
 */

// The navigator is the boundary: the options a page hands it are what its bar draws.
const navigatorOptions = vi.hoisted(() => ({ setOptions: vi.fn() }));
installSettingsViewCommonModuleMocks({
  router: async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      navigation: { setOptions: navigatorOptions.setOptions } as never,
    }).module,
  }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { TeamSection } = await import('./TeamSection');

beforeEach(async () => {
  standardCleanup();
  await harness.reset();
  const { resetTeamsDirectoryEngineForTests } =
    await import('@/sync/engine/teams/teamsDirectoryEngine');
  const { resetTeamsSnapshotsForTests } =
    await import('@/sync/store/teams/teamsSnapshots');
  resetTeamsDirectoryEngineForTests();
  resetTeamsSnapshotsForTests();
  navigatorOptions.setOptions.mockReset();
});
afterEach(() => standardCleanup());

describe('a Team page and the phone bar above it', () => {
  it("leaves the bar's title to the settings registry while the Team is read and once it is shown", async () => {
    const serverId = await harness.addHome({
      name: 'Home One',
      serverUrl: 'https://team-title.example',
      accountId: 'account-a',
      teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/teams/get', {
      body: teamSummaryFixture({
        capabilities: teamCapabilitiesFixture({ manageMembers: true }),
      }),
    });
    const screen = await renderScreen(
      <TeamSection
        serverId={serverId}
        teamId="team-1"
        title="Members"
        description="Who is in this Team."
      >
        {() =>
          React.createElement('TeamPageBody', { testID: 'team-page-body' })
        }
      </TeamSection>,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('team-page-body')).not.toBeNull(),
    );
    const titles = navigatorOptions.setOptions.mock.calls.filter(
      ([options]) => options && 'title' in (options as object),
    );
    expect(titles).toEqual([]);
  });
});
