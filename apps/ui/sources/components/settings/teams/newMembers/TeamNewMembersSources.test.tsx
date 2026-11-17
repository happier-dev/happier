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
  type ProviderRpcRequest,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const transport = vi.hoisted(() => ({
  call: vi.fn<(request: ProviderRpcRequest) => Promise<unknown>>(),
}));
// test-policy-boundary: Machine RPC is the real process boundary; Source catalog, Action dispatch and sections stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (request: ProviderRpcRequest) =>
      transport.call(request),
  }),
);
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
  transport.call.mockReset();
  transport.call.mockImplementation(async (request) =>
    declarations.machineRpc(request),
  );
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
  return { screen, team };
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
