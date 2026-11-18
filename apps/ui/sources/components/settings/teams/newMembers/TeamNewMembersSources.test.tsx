import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSourceListItemV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installBundledProviderDeclarationsRpcBoundary,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

// Generated packaged artwork is an external build artifact, unrelated to these sections.
vi.mock(
  '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts',
  () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]),
    BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
  }),
);
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
installSettingsViewCommonModuleMocks({
  storage: 'real',
  text: () => vi.importActual('@/text'),
  modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
});
const account = createProviderSettingsAccountHarness();
const declarations = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(declarations);
const { TeamNewMembersScreen } = await import('./TeamNewMembersScreen');
const { ModalProvider, Modal } = await import('@/modal');
const { resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } =
  await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } =
  await import('@/sync/ops/teams/teamActionClient');

const teamAudience = [
  {
    principal: { kind: 'team' as const, teamId: 'team-1' },
    level: 'view' as const,
  },
];
const web = ProjectSourceListItemV1Schema.parse({
  id: 'source-web',
  revision: 2,
  name: 'Storefront',
  audience: teamAudience,
  createdByAccountId: 'admin',
  repository: {
    provider: {
      id: 'happier.scm.forge.github/github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'https://github.com',
    },
    repository: { nameWithOwner: 'acme/web' },
    protocol: 'https',
  },
  attachments: [
    {
      purpose: 'onboarding_task',
      ref: { kind: 'doc', artifactId: 'first-task' },
    },
  ],
});
const infra = ProjectSourceListItemV1Schema.parse({
  id: 'source-infra',
  revision: 1,
  name: 'Infra',
  audience: teamAudience,
  createdByAccountId: 'admin',
});

beforeEach(() => {
  resetTeamsSnapshotsForTests();
  resetTeamsDirectoryEngineForTests();
  resetTeamActionClientForTests();
  declarations.reset();
  installBundledProviderDeclarationsRpcBoundary(declarations);

});
afterEach(async () => {
  await act(async () => {
    Modal.hideAll();
  });
  await standardCleanup();
  await account.reset();
});

async function renderNewMembers(
  sources: readonly unknown[],
  manageSettings: boolean,
) {
  const { serverId } = await account.restore({
    accountId: 'admin',
    currentAccount: true,
    waivedActions: ['providers.models.refresh'],
    machines: [
      createMachineFixture({
        id: 'machine-1',
        activeAt: Date.now(),
        storageMode: 'plain',
      }),
    ],
    features: createRootLayoutFeaturesResponse({
      features: { teams: { enabled: true } },
    }),
  });
  const team = teamSummaryFixture({
    capabilities: teamCapabilitiesFixture({ manageSettings }),
    policy: teamPolicyFixture({
      managedDefaultsStatus: 'available',
      managedDefaults: { team: {}, groups: {} },
    }),
  });
  account.home.answer(serverId, '/v1/teams/get', { body: team });
  account.home.answer(serverId, '/v1/teams/list', {
    body: { items: [team], nextCursor: null },
  });
  account.home.answer(serverId, '/v1/projects/sources', {
    body: { ok: true, sources, coverage: { complete: true, nextCursor: null } },
  });
  const screen = await renderScreen(
    <ModalProvider>
      <TeamNewMembersScreen serverId={serverId} teamId="team-1" />
    </ModalProvider>,
  );
  return { screen, team, serverId };
}

it.each([true, false])(
  "lists the Team's Sources and the attached first task by reference (manage settings: %s)",
  async (manageSettings) => {
    const { screen, team } = await renderNewMembers(
      [web, infra],
      manageSettings,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('team-new-members-repository:source-infra'),
      ).not.toBeNull(),
    );
    const repositories = screen.findByTestId('team-new-members-repositories');
    const text = JSON.stringify(repositories?.findAll(node => typeof node.props.children === 'string').map(node => node.props.children));
    expect(text).toContain('Storefront');
    expect(text).toContain('acme/web');
    expect(text).toContain(team.name);
    // The task is advertised from Source metadata; only the Source carrying one appears under it.
    expect(
      screen.findByTestId('team-new-members-first-task:source-web'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('team-new-members-first-task:source-infra'),
    ).toBeNull();
    // No inclusion producer exists yet: rows are records, never switches, for every role.
    expect(
      repositories?.findAll(
        (node) => typeof node.props.onValueChange === 'function',
      ),
    ).toHaveLength(0);
  },
);

it('tells two same-named Sources without a repository apart by their row line', async () => {
  const personal = ProjectSourceListItemV1Schema.parse({
    id: 'source-personal', revision: 1, name: 'Sandbox', audience: teamAudience, createdByAccountId: 'admin',
    owner: { kind: 'account', accountId: 'admin' },
  });
  const teamOwned = ProjectSourceListItemV1Schema.parse({
    id: 'source-team', revision: 1, name: 'Sandbox', audience: [], createdByAccountId: 'admin',
    owner: { kind: 'team', teamId: 'team-1' },
  });
  const { screen } = await renderNewMembers([personal, teamOwned], true);
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('team-new-members-repository:source-team')).not.toBeNull(),
  );
  const rowText = (id: string) => JSON.stringify(screen.findByTestId(`team-new-members-repository:${id}`)
    ?.findAll(node => typeof node.props.children === 'string').map(node => node.props.children));
  expect(rowText('source-personal')).toContain('No address');
  expect(rowText('source-team')).toContain('Owned by the Team');
  expect(rowText('source-personal')).not.toEqual(rowText('source-team'));
});

it('says nothing is shared yet and that no first task is suggested', async () => {
  const { screen } = await renderNewMembers([], true);
  await waitForHomeGovernance(() =>
    expect(
      screen.findByTestId('team-new-members-repositories-empty'),
    ).not.toBeNull(),
  );
  expect(
    screen.findByTestId('team-new-members-first-task-empty'),
  ).not.toBeNull();
});

it('keeps hydrated empty sections visible while the Sources refetch after a Team change', async () => {
  const { screen, serverId } = await renderNewMembers([], true);
  await waitForHomeGovernance(() => expect(screen.findByTestId('team-new-members-repositories-empty')).not.toBeNull());
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  account.home.answer(serverId, '/v1/projects/sources', {
    select: () => { requested = true; return { respondAfter: pending,
      body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } }; },
  });
  const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
  const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol/changes');
  try {
    await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
    await waitForHomeGovernance(() => expect(requested).toBe(true));
    expect(screen.findByTestId('team-new-members-repositories-empty')).not.toBeNull();
    expect(screen.findByTestId('team-new-members-first-task-empty')).not.toBeNull();
    expect(screen.findByTestId('team-new-members-repositories-loading')).toBeNull();
  } finally { await act(async () => { release(); await pending; }); }
});
