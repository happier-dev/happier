import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ApprovalRequestV2Schema, createActionExecutor } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineProcessesCleanUpInputV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { createGuardLeftBehindActionExecutor } from '../../../../apps/cli/src/daemon/guard/actions';
import { createUnavailableActionTransportDeps } from '../../../../apps/cli/src/testkit/actionTransportDeps';
import type { RpcActionExecutorContext } from '../../../../apps/cli/src/rpc/handlers/_actionDispatchAdapter';
import { serveActionHomes } from '../../../../apps/ui/sources/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '../../../../apps/ui/sources/dev/testkit/fixtures/machineFixtures';
import { renderHook, standardCleanup } from '../../../../apps/ui/sources/dev/testkit';
import { createServerScopedMachineRpcBoundaryMock } from '../../../../apps/ui/sources/dev/testkit/mocks/serverScopedRpc';
import { createMachineGuardViewFixture } from '../../../../apps/ui/sources/sync/domains/machines/guard/guardViewFixtures';

const rpc = vi.hoisted(() => vi.fn<Parameters<typeof createServerScopedMachineRpcBoundaryMock>[0]>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => createServerScopedMachineRpcBoundaryMock(rpc));
// This source journey has no Expo/package asset publication. Reuse the UI's
// asset boundary rather than loading the generated app's host-specific paths.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () =>
  (await import('../../../../apps/ui/sources/dev/testkit/mocks/bundledPluginUiAssets')).emptyBundledPluginUiAssetsModule);

// Home HTTP/Artifact persistence and daemon RPC are the system boundaries.
// Guard, approval creation, portable-Home resolution, the browser controller and
// its Action front door all run through their production implementations.
const LOCAL_HOME = 'stack_agent-qa-machine-resources__id_default';
const PORTABLE_HOME = 'srv_guard-portable-home';
let homes: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => { await standardCleanup(); await homes?.dispose(); homes = undefined; });

describe('Guard Ask → approval → browser resource check', () => {
  it.each(['current-producer', 'stored-local-id', 'unknown-home'] as const)('checks the exact set on a different client (%s)', async basis => {
    homes = await serveActionHomes({
      homes: [{ key: 'browser', serverUrl: 'https://guard-approval.test', serverIdentityId: PORTABLE_HOME,
        accountId: 'owner', currentAccount: true }],
      route: request => request.path === '/v1/machines/read-batch' && request.method === 'POST'
        ? Response.json(createMachineReadBatchResponseFixture(request.body,
          id => id === 'machine' ? createPlainMachineRowFixture({ id, accountId: 'owner' }) : null)) : undefined,
    });
    const browserHome = homes.homes.browser!.id;
    const context: RpcActionExecutorContext = {
      authority: 'account_automation', surface: 'rpc', actionCaller: { kind: 'host' },
      serverId: LOCAL_HOME, serverIdentityId: PORTABLE_HOME, runtimeAccountId: 'owner', actionRequestId: 'guard-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine' }, defaultSessionMachineId: 'machine',
      machineAdmission: { machineId: 'machine', installationId: 'installation', custodianAccountId: 'owner',
        actorAccountId: 'owner', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
    };
    const stored: unknown[] = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      approvalsCreate: async ({ request }) => { stored.push(JSON.parse(JSON.stringify(request))); return { artifactId: 'approval' }; },
    });
    const produce = createGuardLeftBehindActionExecutor({ readContext: async () => context,
      getExecutor: () => executor, observeExecution: async () => { throw new Error('Ask must not execute cleanup'); },
    });
    expect(await produce({ mode: 'ask', refs: ['exact-ref'], sessionId: 'ended-session' }))
      .toMatchObject({ ok: true, result: { artifactId: 'approval' } });
    const produced = ApprovalRequestV2Schema.parse(stored[0]);
    if (basis === 'current-producer') expect(produced.actionArgs).toMatchObject({ serverId: PORTABLE_HOME });
    // Provenance: qa-r2 Restart #83 naturally persisted this creator-local id
    // while executionOriginV1 retained the correct portable Home identity.
    if (basis !== 'current-producer') {
      // Build a complete record through the real approval creator, including
      // its input digest. Never repair or rewrite an already stored approval.
      expect(await executor.execute('approval.request.create', { actionId: produced.actionId,
        actionArgs: basis === 'stored-local-id'
          ? { ...MachineProcessesCleanUpInputV1Schema.parse(produced.actionArgs), serverId: LOCAL_HOME } : produced.actionArgs,
        summary: produced.summary, createdBy: produced.createdBy,
      }, { ...context, actionRequestId: `guard-${basis}`,
        ...(basis === 'unknown-home' ? { serverIdentityId: 'srv_unknown-home' } : {}),
      })).toMatchObject({ ok: true, result: { artifactId: 'approval' } });
    }
    const approval = ApprovalRequestV2Schema.parse(stored.at(-1));
    const original = JSON.stringify(approval);
    rpc.mockReset();
    rpc.mockImplementation(async request => {
      if (request.serverId !== browserHome || request.accountId !== 'owner') throw new Error('Wrong Home/Account');
      if (request.method === RPC_METHODS.MACHINES_PROCESSES_CHECK) return {
        checks: [{ ref: 'exact-ref', present: true, identityEqual: true, level: 'left_behind', memoryBytes: 100 }],
      };
      if (request.method === RPC_METHODS.MACHINES_GUARD_GET) return createMachineGuardViewFixture();
      throw new Error(`Unexpected RPC ${request.method}`);
    });
    const { useResourceProposalCheck } = await import('../../../../apps/ui/sources/components/approvals/resourceProposal/useResourceProposalCheck');
    const hook = await renderHook(() => useResourceProposalCheck(approval, browserHome, 'approval'));
    if (basis === 'unknown-home') {
      await vi.waitFor(() => expect(hook.getCurrent()?.check.kind).toBe('unavailable'));
      expect(hook.getCurrent()?.approveWithheld).toBe(true);
      expect(rpc).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(hook.getCurrent()?.check.kind).toBe('ready'));
    expect(hook.getCurrent()).toMatchObject({ approveWithheld: false, selectedCount: 1 });
    expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.MACHINES_PROCESSES_CHECK))
      .toMatchObject([[{ serverId: browserHome, machineId: 'machine', payload: { refs: ['exact-ref'] } }]]);
    await act(async () => hook.getCurrent()?.checkAgain());
    await vi.waitFor(() => expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.MACHINES_PROCESSES_CHECK)).toHaveLength(2));
    await vi.waitFor(() => expect(hook.getCurrent()?.approveWithheld).toBe(false));
    expect(JSON.stringify(approval)).toBe(original);
  });
});
