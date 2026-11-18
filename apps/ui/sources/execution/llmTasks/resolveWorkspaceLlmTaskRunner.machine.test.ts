import '@/dev/testkit/harness/syncSingletonLoader';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getActionSpec } from '@happier-dev/protocol/actions';

// Home HTTP and Machine RPC are the boundaries; the front door, the UI Action executor and the
// account Machine-action path stay real. AUTO-LIVE U1: Describe your app's runner read failed
// live with `unknown_agent` because the UI host answered this Action itself instead of asking the Machine.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    const invoke = async (
      request: Readonly<{ method: string }>,
    ): Promise<unknown> => {
      if (
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      )
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse(
          {
            protocolVersion: 1,
            projection: { v: 2, generation: 1, familiesById: {} },
          },
        );
      return {};
    };
    return createServerScopedMachineRpcBoundaryMock(
      invoke as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope,
    );
  },
);

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } =
  await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } =
  await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const { createExternalActionAccountHttpBoundary } =
  await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createMachineFixture } =
  await import('@/dev/testkit/fixtures/machineFixtures');
const { standardCleanup } =
  await import('@/dev/testkit/cleanup/standardCleanup');
const { resolveWorkspaceLlmTaskRunner } =
  await import('./runLlmTaskInWorkspace');

const runner = {
  v: 1,
  modelSelection: {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerConnectionId: null,
    modelId: 'gpt-6-luna',
  },
  permissionMode: 'no_tools',
} as const;

async function setup() {
  const serverUrl = 'https://workspace-runner.example.test';
  const serverIdentityId = 'srv_workspace_runner';
  const accountId = 'workspace-runner-account';
  const token = `test.${Buffer.from(
    JSON.stringify({
      sub: accountId,
      tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' },
    }),
  ).toString('base64url')}.test`;
  const homeId = await homes.addHome({
    name: 'Workspace runner',
    serverUrl,
    serverIdentityId,
    accountId,
    credentials: { token },
    accountEncryptionMode: 'plain',
    currentAccount: true,
  });
  homes.answer(homeId, '/v1/account/encryption/currentness', {
    body: {
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    },
  });
  const machine = createMachineFixture({
    id: 'workspace-runner-machine',
    activeAt: Date.now(),
  });
  const inputs: Record<string, unknown>[] = [];
  // The Machine's runner owner answers what Auto picks there.
  const boundary = await createExternalActionAccountHttpBoundary({
    serverUrl,
    serverIdentityId,
    accountId,
    machineId: machine.id,
    actionId: 'agents.models.list',
    tokenEpoch: 1,
    execute(input) {
      inputs.push(input as Record<string, unknown>);
      return {
        items: [],
        llmTaskRunner: {
          ok: true,
          source: 'auto',
          title: 'GPT-6-Luna',
          runner,
        },
      };
    },
  });
  for (const path of [
    '/v1/machines',
    '/v1/machines/read-batch',
    '/v1/actions/agents.models.list/execution-authorization',
    '/v1/actions/agents.models.list',
  ]) {
    homes.answer(homeId, path, {
      select: async (input) => {
        const response = await boundary.handle(
          new URL(path, serverUrl),
          input === undefined
            ? undefined
            : { method: 'POST', body: JSON.stringify(input) },
        );
        if (!response) throw new Error(`Unexpected boundary path: ${path}`);
        return { body: await response.json() };
      },
    });
  }
  const scope = { serverId: homeId, accountId };
  getStorage().setState({
    settingsScope: scope,
    profileScope: scope,
    machines: { [machine.id]: machine },
    machineListByServerId: { [homeId]: [machine] },
  });
  return { homeId, machine, inputs };
}

const initialStorage = getStorage().getState();
beforeEach(async () => {
  await homes.reset();
});
afterEach(async () => {
  standardCleanup();
  getStorage().setState(initialStorage, true);
  await homes.reset();
});

it('a workspace task reads its Auto runner from the Machine it runs on, never the UI host', async () => {
  const env = await setup();
  const host = {
    kind: 'workspace',
    workspace: {
      serverId: env.homeId,
      machineId: env.machine.id,
      rootPath: '/home/dev/projects',
    },
  } as const;
  const resolved = await resolveWorkspaceLlmTaskRunner(
    host,
    null,
    'deploy_suggestion',
  );
  expect(resolved).toMatchObject({ ok: true, runner, title: 'GPT-6-Luna' });
  expect(env.inputs).toHaveLength(1);
  expect(env.inputs[0]).toMatchObject({
    purpose: 'llm_task_runner',
    task: 'deploy_suggestion',
    machineId: env.machine.id,
  });
  // The Machine admits only the Action's own input contract.
  expect(getActionSpec('agents.models.list').inputSchema.safeParse(env.inputs[0]).error?.issues).toBeUndefined();
});
