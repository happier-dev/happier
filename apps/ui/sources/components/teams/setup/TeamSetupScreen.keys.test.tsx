import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1,
  TeamCredentialResourceCatalogEntryV1Schema,
  TeamCredentialResourceDiscoveryPageV1Schema,
} from '@happier-dev/protocol/teams/credentials/resourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { ProjectSourceListItemV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import {
  renderScreen,
  standardCleanup,
  teamCredentialDisplayNameFixture,
  teamCredentialResourceFixture,
  teamCredentialViewerFixture,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
  mock.spies.push.mockImplementation(navigation.push);
  return mock.module;
});
// Only Home HTTP is scripted; the Team, Source, summary and credential catalog owners run as in production.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Load the page and its owners once at collection, outside the test's time budget, as the sibling setup tests do.
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { t } = await import('@/text');
const { TeamSetupPageView, TeamSetupScreen } = await import('./TeamSetupScreen');
const { TeamSetupPlanProvider } = await import('./TeamSetupPlanProvider');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
beforeEach(async () => {
  await homes.reset();
});
afterEach(async () => {
  navigation.push.mockClear();
  standardCleanup();
  await homes.reset();
});

it('offers exact Setup recovery and lets an agent open the same retained operation', async () => {
  const serverId = await homes.addHome({ name: 'Setup Home', serverUrl: 'https://setup-actions.example.test',
    serverIdentityId: 'srv_setup_actions', accountId: 'member', currentAccount: true, teamsEnabled: true });
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'member' };
  storage.getState().activateProfileScope(scope);
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
  const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
  const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
  const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
  const onRun = vi.fn();
  const onOpenOperation = vi.fn();
  const onRetryFailedSetup = vi.fn();
  const recovery = { onRetryFailedSetup };
  const screen = await renderMountedCurrentUiContext(<TeamSetupPageView
    {...recovery}
    navigationContextKey="setup-actions"
    header={null} teamName="Acme" selection={createMachineAdministrationTargetSelectionFixture()}
    machineId="machine-a" machineLabel="Mac" homeDir={null}
    run={{ kind: 'stopped', operationId: 'setup-operation', failure: {
      ok: false, errorCode: 'native_effect_failed', error: 'Registry rate limited',
    } }}
    canRun onRun={onRun} onOpenOperation={onOpenOperation}
    sources={{ loading: false, failure: null, onRetry: vi.fn() }}
    hasPreset={false} machinePlan={null} repositories={[]} repositoryFreeSources={[]}
    excluded={new Set()} onToggleRepository={vi.fn()} batch={null} sharedKeys={[]} keyDisplayNames={{}}
    firstTask={null} presetChange={null}
    clones={{ onFind: null, searching: false, folder: null, adopted: new Map(), failure: null, noneFound: false }}
  />);
  await screen.pressByTestIdAsync('team-setup-retry-failed');
  await screen.pressByTestIdAsync('team-setup-stopped-secondary-action');
  expect(onRetryFailedSetup).toHaveBeenCalledOnce();
  expect(onOpenOperation).toHaveBeenCalledExactlyOnceWith('setup-operation');
  expect(onRun).not.toHaveBeenCalled();
  const reader = readCurrentUiContextActionReader({ surface: 'agent' });
  const command = reader?.readCurrentUiContext()?.commands.find(item => item.title === t('teams.join.setupPage.seeWhatRan'));
  expect(command).toBeDefined();
  expect(await createDefaultActionExecutor().execute(
    ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command!.id }, { surface: 'agent' },
  )).toMatchObject({ ok: true });
  expect(onOpenOperation.mock.calls).toEqual([['setup-operation'], ['setup-operation']]);
});

it.each([false, true])('lists shared keys and mirrors any Source link to the agent (Source: %s)', async (includeSource) => {
  onTestFinished(await installRealActionExecutorModuleLoader());
  const serverId = await homes.addHome({
    name: 'Setup Home',
    serverUrl: 'https://setup-keys.example.test',
    serverIdentityId: 'srv_setup_keys',
    accountId: 'member',
    currentAccount: true,
    teamsEnabled: true,
    credentialResourcesEnabled: true,
  });
  storage
    .getState()
    .activateProfileScope({
      serverId: resolveServerProfileScopeIdForIdentifier(serverId),
      accountId: 'member',
    });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const team = teamSummaryFixture({
    id: 'keys-team',
    name: 'Acme',
    policy: teamPolicyFixture({ managedDefaults: null }),
  });
  homes.answer(serverId, '/v1/teams/get', { body: team });
  const summary = bindHomeDomainActionHttpRequestV1(
    TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
    { v: 1, teamId: team.id },
  );
  homes.answer(serverId, summary.path, {
    body: {
      teamId: team.id,
      kinds: [{ kind: 'credentials', status: 'available', count: 1 }],
    },
  });
  homes.answer(serverId, '/v1/projects/sources', {
    body: {
      ok: true,
      sources: includeSource ? [ProjectSourceListItemV1Schema.parse({ id: 'team-notes', revision: 1, name: 'Team notes',
        createdByAccountId: 'member', audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] })] : [],
      coverage: { complete: true, nextCursor: null },
    },
  });
  homes.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
    // The recipient catalog: what this member may use, read through discovery.
    body: TeamCredentialResourceDiscoveryPageV1Schema.parse({
      resources: [TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'key-1', teamId: team.id, displayName: teamCredentialDisplayNameFixture('Acme OpenAI key'),
        resourceRevision: 1, sourcePresentation: teamCredentialResourceFixture().sourcePresentation,
        readiness: teamCredentialResourceFixture().readiness, recoveryAction: null, allowedRoutes: ['brokered'],
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
      })],
      nextCursor: null,
      failures: [],
    }),
  });
  homes.answer(serverId, '/v1/teams/credential-resources/list', {
    body: {
      resources: [
        teamCredentialResourceFixture({
          id: 'key-1',
          teamId: team.id,
          displayName: teamCredentialDisplayNameFixture('Acme OpenAI key'),
        }),
      ],
      viewer: teamCredentialViewerFixture({}),
    },
  });
  const render = includeSource ? (await import('@/dev/testkit/harness/mountedCurrentUiContext')).renderMountedCurrentUiContext : renderScreen;
  const screen = await render(
    <TeamSetupPlanProvider execute={createFrontDoorActionExecute()} context={{ surface: 'ui', serverId, expectedAccountId: 'member' }}>
      <TeamSetupScreen serverId={serverId} teamId={team.id} />
    </TeamSetupPlanProvider>,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('team-setup-keys'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Acme OpenAI key');
    expect(screen.getTextContent()).toContain(
      t('teams.join.setupPage.keyShared'),
    );
    expect(screen.findByTestId('team-setup-empty')).toBeNull();
    if (!includeSource) return;
    await screen.pressByTestIdAsync('team-setup-source:team-notes');
    expect(navigation.push).toHaveBeenLastCalledWith('/projects/sources?source=team-notes');
    navigation.push.mockClear();
    const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
    const source = readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands.find(item => item.title === 'Team notes');
    expect(source).toBeDefined();
    expect(await createDefaultActionExecutor().execute(
      ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: source!.id }, { surface: 'agent' },
    )).toMatchObject({ ok: true });
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/projects/sources?source=team-notes');
  } finally {
    await screen.unmount();
  }
});
