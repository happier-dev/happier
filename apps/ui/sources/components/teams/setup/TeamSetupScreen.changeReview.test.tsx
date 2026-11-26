import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

// Only Home HTTP is scripted; the mounted command owner and the Action front door run as in production.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { renderMountedCurrentUiContext } =
  await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { readCurrentUiContextActionReader } =
  await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');
const { ACTION_ID_FAMILIES_V1 } =
  await import('@happier-dev/protocol/actions/actionIds');
const { t } = await import('@/text');
const { TeamSetupPageView } = await import('./TeamSetupScreen');
const { TeamSetupSourceChangeNotice } = await import('./TeamSetupSourceChange');

beforeEach(async () => {
  await homes.reset();
  const serverId = await homes.addHome({
    name: 'Setup Home',
    serverUrl: 'https://setup-review.example.test',
    serverIdentityId: 'srv_setup_review',
    accountId: 'member',
    currentAccount: true,
    teamsEnabled: true,
  });
  storage
    .getState()
    .activateProfileScope({
      serverId: resolveServerProfileScopeIdForIdentifier(serverId),
      accountId: 'member',
    });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

async function invokeAsAgent(description: string) {
  const reader = readCurrentUiContextActionReader({ surface: 'agent' });
  const command = reader
    ?.readCurrentUiContext()
    ?.commands.find(
      (item) =>
        item.title === t('machinePresets.setup.tab.reviewChanges') &&
        item.description === description,
    );
  expect(
    command,
    JSON.stringify(reader?.readCurrentUiContext()?.commands),
  ).toBeDefined();
  return createDefaultActionExecutor().execute(
    ACTION_ID_FAMILIES_V1.current_ui_context[1],
    { commandId: command!.id },
    { surface: 'agent' },
  );
}

it('lets an agent open the same Machine Setup review the changed-preset control opens', async () => {
  const onReview = vi.fn();
  const screen = await renderMountedCurrentUiContext(
    <TeamSetupPageView
      navigationContextKey="setup-preset-review"
      header={null}
      teamName="Acme"
      selection={createMachineAdministrationTargetSelectionFixture()}
      machineId="devbox"
      machineLabel="Devbox"
      homeDir={null}
      run={{ kind: 'idle' }}
      canRun
      onRun={vi.fn()}
      onOpenOperation={vi.fn()}
      sources={{ loading: false, failure: null, onRetry: vi.fn() }}
      hasPreset
      machinePlan={null}
      repositories={[]}
      repositoryFreeSources={[]}
      excluded={new Set()}
      onToggleRepository={vi.fn()}
      batch={null}
      sharedKeys={[]}
      keyDisplayNames={{}}
      firstTask={null}
      presetChange={{ revision: 4, onReview }}
      clones={{
        onFind: null,
        searching: false,
        folder: null,
        adopted: new Map(),
        failure: null,
        noneFound: false,
      }}
    />,
  );
  await screen.pressByTestIdAsync('team-setup-preset-changed-review');
  expect(onReview).toHaveBeenCalledOnce();
  expect(
    await invokeAsAgent(
      t('teams.join.setupPage.presetChanged', { team: 'Acme' }),
    ),
  ).toMatchObject({ ok: true });
  expect(onReview).toHaveBeenCalledTimes(2);
});

it('lets an agent open the same checkout Scripts review the changed-Source control opens', async () => {
  const onReview = vi.fn();
  const screen = await renderMountedCurrentUiContext(
    <TeamSetupSourceChangeNotice
      sourceId="acme-web"
      teamName="Acme"
      repositoryName="acme/web"
      navigationContextKey="setup-source-review"
      onReview={onReview}
      pending={{
        source: { id: 'acme-web', name: 'Web' },
        setup: { kind: 'none' } as never,
        summary: [{ kind: 'scripts', count: 2 }] as never,
      }}
    />,
  );
  await screen.pressByTestIdAsync('team-setup-source-changed-review:acme-web');
  expect(onReview).toHaveBeenCalledOnce();
  expect(
    await invokeAsAgent(
      `${t('teams.join.setupPage.sourceChanged', { team: 'Acme' })} · acme/web`,
    ),
  ).toMatchObject({ ok: true });
  expect(onReview).toHaveBeenCalledTimes(2);
});
