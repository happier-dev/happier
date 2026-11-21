import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectSourceListItemV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamCredentialDisplayNameFixture,
  teamCredentialResourceFixture,
  teamCredentialViewerFixture,
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
const router = vi.hoisted(() => ({ push: null as null | ((...args: unknown[]) => unknown) }));
installSettingsViewCommonModuleMocks({
  storage: 'real',
  router: async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    router.push = mock.spies.push;
    return mock.module;
  },
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
  credentials?: readonly unknown[],
  answerHome?: (serverId: string) => void,
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
      features: { teams: credentials
        ? { enabled: true, credentialResources: { enabled: true, externalApi: { enabled: false } } }
        : { enabled: true } },
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
  if (credentials) {
    account.home.answer(serverId, '/v1/teams/credential-resources/list', {
      body: { resources: credentials, viewer: teamCredentialViewerFixture({}) },
    });
  }
  answerHome?.(serverId);
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

it('commits the Team header and observed repository on the first return to New members', async () => {
  const { screen, serverId, team } = await renderNewMembers([web], true);
  const repository = 'team-new-members-repository:source-web';
  await waitForHomeGovernance(() => expect(screen.findByTestId(repository)).not.toBeNull());
  await screen.update(<ModalProvider />);

  const committed: { text: string; repository: boolean }[] = [];
  await screen.update(<ModalProvider>
    <React.Profiler id="new-members-return" onRender={() => committed.push({
      text: screen.getTextContent(),
      repository: screen.findHostByTestId(repository) !== null,
    })}>
      <TeamNewMembersScreen serverId={serverId} teamId="team-1" />
    </React.Profiler>
  </ModalProvider>);
  expect(committed[0]).toMatchObject({ text: expect.stringContaining(team.name), repository: true });
  await screen.unmount();
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

it('opens each repository in its Source editor, where its sharing is changed', async () => {
  const { screen } = await renderNewMembers([web], false);
  const row = 'team-new-members-repository:source-web';
  await waitForHomeGovernance(() => expect(screen.findByTestId(row)).not.toBeNull());
  await screen.pressByTestIdAsync(row);
  expect(router.push).toHaveBeenCalledWith('/projects/sources?source=source-web');
});

it('offers sharing another Source with the Team to people who manage it only', async () => {
  const managed = await renderNewMembers([web], true);
  const share = 'team-new-members-repositories-share';
  await waitForHomeGovernance(() => expect(managed.screen.findByTestId(share)).not.toBeNull());
  await managed.screen.pressByTestIdAsync(share);
  expect(router.push).toHaveBeenCalledWith('/projects/sources');
  await managed.screen.unmount();
  const member = await renderNewMembers([web], false);
  await waitForHomeGovernance(() =>
    expect(member.screen.findByTestId('team-new-members-repository:source-web')).not.toBeNull());
  expect(member.screen.findByTestId(share)).toBeNull();
});

it('previews the page a member reads, on the Team\'s own Home', async () => {
  const { screen, serverId } = await renderNewMembers([web], true);
  await waitForHomeGovernance(() => expect(screen.findByTestId('team-new-members-preview')).not.toBeNull());
  await screen.pressByTestIdAsync('team-new-members-preview');
  expect(router.push).toHaveBeenCalledWith(
    `/teams/team-1/setup?serverId=${encodeURIComponent(serverId)}&preview=1`);
});

it('removes the suggested first task through the Source owner', async () => {
  const { screen, serverId } = await renderNewMembers([web], true);
  const patches: unknown[] = [];
  account.home.answer(serverId, 'PATCH /v1/projects/sources/source-web', { select: (input) => {
    patches.push(input);
    return { body: { ok: true, source: { ...web, revision: 3, attachments: [] }, canManage: true } };
  } });
  const remove = 'team-new-members-first-task:source-web.remove';
  await waitForHomeGovernance(() => expect(screen.findByTestId(remove)).not.toBeNull());
  await screen.pressByTestIdAsync(remove);
  await waitForHomeGovernance(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ sourceId: 'source-web', patch: { attachment: {
    kind: 'detach', purpose: 'onboarding_task', ref: { kind: 'doc', artifactId: 'first-task' },
  } } });
});

it('lets managers choose a first task for a repository without one, and never offers it to members', async () => {
  const managed = await renderNewMembers([web, infra], true);
  const choose = 'team-new-members-first-task-choose';
  await waitForHomeGovernance(() => expect(managed.screen.findByTestId(choose)).not.toBeNull());
  await managed.screen.unmount();
  const member = await renderNewMembers([web, infra], false);
  await waitForHomeGovernance(() =>
    expect(member.screen.findByTestId('team-new-members-first-task:source-web')).not.toBeNull());
  expect(member.screen.findByTestId(choose)).toBeNull();
  expect(member.screen.findByTestId('team-new-members-first-task:source-web.remove')).toBeNull();
});

it('lists the keys the Team shares, each opening its own page', async () => {
  const key = teamCredentialResourceFixture({
    id: 'key-1', teamId: 'team-1', displayName: teamCredentialDisplayNameFixture('Acme OpenAI key'),
  });
  const { screen, serverId } = await renderNewMembers([web], true, [key]);
  const row = 'team-new-members-keys';
  await waitForHomeGovernance(() => expect(screen.findByTestId(row), screen.getTextContent()).not.toBeNull());
  await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Acme OpenAI key'));
  const keyRow = screen.findByTestId('team-credentials-row:key-1');
  const pressable = keyRow?.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel)[0];
  expect(pressable).toBeDefined();
  await act(async () => { pressable!.props.onPress(); });
  expect(router.push).toHaveBeenCalledWith(
    `/settings/teams/${encodeURIComponent(serverId)}/team-1/credentials/key-1`);
});

it('names the keys each listed repository\'s published setup needs, reading each Source once and no value', async () => {
  const { createPlainArtifactHttpFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
  const setup = (artifactId: string) => ({
    purpose: 'setup' as const, ref: { kind: 'doc' as const, artifactId }, contentRevision: { headerVersion: 1, bodyVersion: 1 },
  });
  const published = ProjectSourceListItemV1Schema.parse({ ...web, attachments: [...(web.attachments ?? []), setup('setup-web')] });
  const publishedInfra = ProjectSourceListItemV1Schema.parse({ ...infra, attachments: [setup('setup-infra')] });
  const unpublished = ProjectSourceListItemV1Schema.parse({ ...infra, id: 'source-docs', name: 'Docs' });
  const sourceReads: string[] = [];
  const { screen } = await renderNewMembers([published, publishedInfra, unpublished], true, undefined, (serverId) => {
  for (const source of [published, publishedInfra, unpublished]) {
    account.home.answer(serverId, `GET /v1/projects/sources/${source.id}`, { select: () => {
      sourceReads.push(source.id);
      return { body: { ok: true, source, canManage: true } };
    } });
  }
  const manifest = (names: readonly string[]) => JSON.stringify({ kind: 'project_setup.v1', manifest: {
    version: 1, environmentVariables: names.map((name) => ({ name, kind: 'secret', required: true })),
  } });
  for (const [id, names] of [['setup-web', ['STRIPE_TEST_KEY', 'SENTRY_DSN']], ['setup-infra', ['STRIPE_TEST_KEY']]] as const) {
    const header = { kind: 'project_setup.v1', title: 'Setup' };
    account.home.answer(serverId, `GET /v1/artifacts/${id}`, { body: createPlainArtifactHttpFixture({
      id, isDecrypted: true, title: 'Setup', header, rawHeader: header, body: manifest(names),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }, 'admin') });
  }
  });
  const stripe = 'team-new-members-key-requirement:STRIPE_TEST_KEY';
  await waitForHomeGovernance(() => expect(screen.findByTestId(stripe), screen.getTextContent()).not.toBeNull());
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId('team-new-members-key-requirement:SENTRY_DSN')).not.toBeNull());
  const rowText = (id: string) => JSON.stringify(screen.findByTestId(id)
    ?.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children));
  // One row per name, naming every listed repository that needs it.
  expect(rowText(stripe)).toContain('Storefront, Infra');
  expect(rowText('team-new-members-key-requirement:SENTRY_DSN')).not.toContain('Infra');
  expect(screen.findByTestId('team-new-members-keys-empty')).toBeNull();
  expect([...sourceReads].sort()).toEqual(['source-docs', 'source-infra', 'source-web']);
});
