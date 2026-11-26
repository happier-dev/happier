import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  applyProjectAccountRowsFixture,
  createMachineFixture,
  renderScreen,
  standardCleanup,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';

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
// The Machine's daemon is the boundary: its contribution projection and the GitHub CLI's reported sign-in.
const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => createServerScopedMachineRpcBoundaryMock(daemon.rpc),
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { invalidateTeamsSnapshotsForServer } =
  await import('@/sync/store/teams/teamsSnapshots');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { TeamSetupScreen } = await import('./TeamSetupScreen');
const { TeamSetupPlanProvider } = await import('./TeamSetupPlanProvider');
const { createFrontDoorActionExecute } =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
beforeEach(async () => {
  await homes.reset();
  daemon.rpc.mockReset();
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

/**
 * A cold Team Setup for one GitHub Source on the person's remembered Machine, whose daemon reports the GitHub CLI
 * signed in (one Machine id per test: the sign-in owner keeps reports per Machine for the app's lifetime) with a connected account available. `statusAnswered` holds that report back to order it after the plan.
 */
async function openColdSetup(machineId: string, statusAnswered: Promise<void> = Promise.resolve(), options: Readonly<{ offline?: boolean }> = {}) {
  let statusRequested: () => void = () => {};
  const requested = new Promise<void>((resolve) => { statusRequested = resolve; });
  const serverId = await homes.addHome({
    name: 'Setup Home',
    serverUrl: 'https://setup-sign-ins.example.test',
    serverIdentityId: 'srv_setup_sign_ins',
    accountId: 'member',
    currentAccount: true,
    teamsEnabled: true,
  });
  const scope = {
    serverId: resolveServerProfileScopeIdForIdentifier(serverId),
    accountId: 'member',
  };
  storage.getState().activateProfileScope(scope);
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const team = teamSummaryFixture({
    id: 'acme',
    name: 'Acme',
    policy: teamPolicyFixture({ managedDefaults: null }),
  });
  homes.answer(serverId, '/v1/teams/get', { body: team });
  const summary = bindHomeDomainActionHttpRequestV1(
    TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
    { v: 1, teamId: team.id },
  );
  homes.answer(serverId, summary.path, {
    body: { teamId: team.id, kinds: [] },
  });
  homes.answer(serverId, '/v1/projects/sources', {
    body: {
      ok: true,
      sources: [
        teamProjectSourceFixture({
          id: 'acme-web',
          name: 'Web',
          nameWithOwner: 'acme/web',
          teamId: team.id,
        }),
      ],
      coverage: { complete: true, nextCursor: null },
    },
  });
  // Offline: last seen long ago, and its daemon never answers.
  const machine = createMachineFixture(options.offline ? { id: machineId, active: false, activeAt: 1 } : { id: machineId, activeAt: Date.now() });
  const row = createPlainMachineRowFixture({
    id: machineId,
    accountId: 'member',
    machine,
  });
  homes.answer(serverId, '/v1/machines', { body: [row] });
  homes.answer(serverId, `GET /v1/machines/${machineId}`, {
    body: { machine: row },
  });
  await publishMachineInventoryForTest({ serverId, accountId: 'member' }, [machine]);
  // The checkout census has answered: this person has no checkout of the Source yet.
  applyProjectAccountRowsFixture(storage);
  // The Machine this person last chose for Team Setup, as their device remembers it.
  await storage.getState().activateSettingsScope(scope);
  storage.getState().applySettingsForScope(scope, { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {
    [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines]: { serverIdentityId: 'srv_setup_sign_ins', machineId } } }, 1);
  const { PLUGIN_MANIFEST: github } =
    await import('../../../../../../packages/plugins/scm-github/src/manifest');
  const definition = github.contributes!.systemTools!.find(
    (tool) => tool.id === 'gh',
  )!;
  const toolId = `${github.id}/${definition.id}`;
  daemon.rpc.mockImplementation(async ({ method }: { method: string }) => {
    if (options.offline) return await new Promise(() => {});
    if (
      method ===
      RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    )
      return {
        protocolVersion: 1,
        projection: {
          v: 2,
          generation: 1,
          installedPackagesById: {
            [github.id]: {
              id: github.id,
              displayName: github.displayName,
              version: github.version,
              enabled: true,
              source: { kind: 'path', locator: '/fixture/github' },
              occurrenceId: github.id,
            },
          },
          familiesById: {
            systemTools: {
              family: 'systemTools',
              entriesById: {
                [toolId]: {
                  id: toolId,
                  pluginId: github.id,
                  pluginVersion: github.version,
                  definition,
                },
              },
            },
          },
        },
      };
    if (method === 'daemon.agents.signIn.status') {
      statusRequested();
      await statusAnswered;
      return {
        installed: true,
        status: 'signedIn',
        credentialSource: 'machineLogin',
        accountLabel: null,
        checkedAt: Date.now(),
        nativeLogin: 'login_terminal',
        connectedServices: [
          {
            serviceId: 'happier.scm.forge.github/github-account',
            title: 'GitHub',
          },
        ],
      };
    }
    throw new Error(`Unexpected fixture RPC ${method}`);
  });
  const screen = await renderScreen(
    <TeamSetupPlanProvider
      execute={createFrontDoorActionExecute()}
      context={{ surface: 'ui', serverId, expectedAccountId: 'member' }}
    >
      <TeamSetupScreen serverId={serverId} teamId={team.id} />
    </TeamSetupPlanProvider>,
  );
  const connected = `machine-setup-sign-in-connected:${toolId}`;
  return { screen, serverId, scope, team, connected, requested };
}

it('keeps the Sign-ins actions in place while the Team revalidates', async () => {
  // Cut 50 at 390: a routine Team revalidation closed Team writes for a moment, and the GitHub CLI's
  // "Use connected account" left and came back, moving the repositories 38 px. A sign-in is the person's
  // own Machine and Account, so the Team's write availability never decides it.
  const { screen, serverId, scope, team, connected } = await openColdSetup('devbox');
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId(connected),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    // A Team wake marks the projection stale until its refetch answers; the row keeps its action meanwhile.
    homes.answer(serverId, '/v1/teams/get', {
      body: team,
      respondAfter: new Promise<void>(() => {}),
    });
    await act(async () => {
      invalidateTeamsSnapshotsForServer(scope.serverId);
    });
    expect(screen.findByTestId(connected)).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('reveals the plan once, with the Sign-ins row settled, when the sign-in report lands after the plan reads', async () => {
  // Cut 50 / 6b16c88d6aa at 390: the plan showed with Sign-ins still holding one loading row, then the GitHub CLI row
  // landed with its stacked action and pushed the repositories down 38 px. The sign-in report is one of the plan's
  // first reads, so the plan shows once with the row in its final shape.
  let answerStatus: () => void = () => {};
  const statusAnswered = new Promise<void>((resolve) => { answerStatus = resolve; });
  const { screen, connected, requested } = await openColdSetup('laptop', statusAnswered);
  try {
    await requested;
    // Every other plan read answers while the Machine's sign-in report is still out.
    await act(async () => { for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.findByTestId('team-setup-run'), screen.getTextContent()).toBeNull();
    expect(screen.findByTestId('team-setup-repositories-frame')?.props.style).toMatchObject({ visibility: 'hidden' });
    answerStatus();
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-run'), screen.getTextContent()).not.toBeNull());
    expect(screen.findByTestId('team-setup-repositories-frame')?.props.style).toBeUndefined();
    expect(screen.findByTestId('machine-setup-sign-ins-loading')).toBeNull();
    expect(screen.findByTestId(connected)).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});

it('keeps the Sign-ins section in place and lands the plan when the chosen Machine is offline', async () => {
  // 77e80c389b8 at 390 with the daemon stopped: the plan landed, but the Sign-ins section vanished. Offline, no report
  // can come, so the section settles on the Machine's offline presence and says when its sign-ins show.
  const { screen } = await openColdSetup('asleep-box', undefined, { offline: true });
  try {
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-run'), screen.getTextContent()).not.toBeNull());
    expect(screen.findByTestId('machine-setup-sign-ins')).not.toBeNull();
    expect(screen.findByTestId('machine-setup-sign-ins-offline')).not.toBeNull();
    expect(screen.findByTestId('machine-setup-sign-ins-loading')).toBeNull();
    expect(daemon.rpc.mock.calls.filter(([request]) => request.method === 'daemon.agents.signIn.status')).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
