import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import sodium from 'libsodium-wrappers';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineRebootResultV1 } from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import {
  createAccountTokenForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createActionExecutorBoundaryFixture, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineSecurityReboot } = await import('./useMachineSecurityReboot');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { createFrontDoorActionExecute } =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { reconcileActionOperationsOnce } =
  await import('@/sync/domains/actionOperations/actionOperationRuntime');

let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const machineId = 'reboot-machine';
const accountId = 'reboot-owner';
const installationId = 'installation-a';

beforeEach(async () => {
  await homes.reset();
  actionOperationStore.reset();
  serverId = await homes.addHome({
    name: 'Reboot',
    serverUrl: 'https://reboot.test',
    serverIdentityId: 'srv_reboot',
    accountId: 'reboot-owner',
    currentAccount: true,
  });
  homes.answer(serverId, 'GET /v1/deployments/machine-references', {
    select: () => ({
      body: {
        homeId: 'srv_reboot',
        machineId,
        coverage: 'complete',
        references: [],
        nextCursor: null,
      },
    }),
  });
  connection = await restoreServerAccountForTest({
    serverUrl: 'https://reboot.test',
    serverIdentityId: 'srv_reboot',
    accountId: 'reboot-owner',
    credentials: { token: createAccountTokenForTests('reboot-owner', { currentAccount: true }) },
    request: homes.request,
  });
  serverId = connection.serverId;
  await publishMachineInventoryForTest({ serverId, accountId: 'reboot-owner' }, [createMachineFixture({
    id: machineId,
    active: true,
    activeAt: Date.now(),
    storageMode: 'plain',
    isShared: false,
    access: {
      role: 'manage',
      custodian: { accountId: 'reboot-owner', displayName: 'Owner' },
      resourceMode: 'plain',
      accessState: 'ready',
    },
  })]);
});
afterEach(async () => {
  standardCleanup();
  actionOperationStore.reset();
  await connection?.dispose();
  connection = null;
  await homes.reset();
});

/** Original Machine Action HTTP boundary, including the caller's persistent installation pin. */
async function serveReboot(reply: () => MachineRebootResultV1 | Promise<MachineRebootResultV1>) {
  await sodium.ready;
  const actionPath = '/v1/actions/machines.reboot';
  const requests: Array<{ requestId: string; input: unknown }> = [];
  const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(31));
  const row = {
    ...createPlainMachineRowFixture({ id: machineId, accountId }),
    installationId,
    installationPublicKey: encodeBase64(installationKey.publicKey, 'base64'),
  };
  homes.answer(serverId, 'POST /v1/machines/read-batch', {
    select: async body => ({ body: await createMachineReadBatchResponseFixture(body, () => row).json() }),
  });
  homes.answer(serverId, `${actionPath}/execution-authorization`, {
    select: body => {
      const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, token: 'reboot-execution-proof', binding: {
        serverIdentityId: 'srv_reboot', accountId, authentication: { kind: 'account', tokenEpoch: 0 },
        actionId: 'machines.reboot', requestId: envelope.requestId, target: { kind: 'machine', machineId },
        machineId, installationId, custodianAccountId: accountId, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    },
  });
  homes.answer(serverId, actionPath, {
    select: async body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
      requests.push({ requestId: envelope.requestId, input: envelope.input });
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1, requestId: envelope.requestId, actionId: 'machines.reboot', execution: { ok: true, result: await reply() },
      }) };
    },
  });
  return requests;
}

function operation(
  state: ActionOperationSnapshotV1['state'],
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'reboot-op',
    revision: state === 'running' ? 1 : 2,
    actionId: 'machines.reboot',
    state,
    scope: { accountId: 'reboot-owner', machineId },
    title: 'Reboot',
    createdAt: 1,
    cancellation: 'unsupported',
    startedAt: 1,
    ...(state === 'running' ? {} : { settledAt: 2 }),
    domainRef: {
      kind: 'machineReboot',
      serverId,
      machineId,
      installationId: 'installation-a',
      task: { id: 'reboot-task', taskKind: 'machine.reboot.v1' },
      basis: {
        dispatchStarted: true,
        bootedAt: 1,
        expectedRunningServiceIds: [],
        expectedRunningServicesKnown: true,
      },
    },
  };
}

async function reobserveRestart() {
  await act(async () => reconcileActionOperationsOnce({
    scope: { serverId, accountId: 'reboot-owner', machineId },
    list: async () => ({ items: [], nextCursor: null }),
    readRebootFacts: async () => ({ installationId: 'installation-a', bootedAt: 2, services: [] }),
  }));
}

it('asks the page to read again once when the Machine refuses the restart', async () => {
  const onSettled = vi.fn();
  const requests = await serveReboot(() => ({
    kind: 'blocked',
    reasons: ['session', 'terminal'],
  }));
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: 'installation-a',
      onSettled,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(requests.map(request => request.input)).toEqual([
    { serverId, machineId, expectedInstallationId: 'installation-a' },
  ]);
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'blocked',
    reasons: ['session', 'terminal'],
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('asks the page to read again once when the accepted restart settles, never before', async () => {
  const onSettled = vi.fn();
  await serveReboot(() => ({
    kind: 'accepted',
    operation: { operationId: 'reboot-op' },
    bootedAt: 1,
  }));
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: 'installation-a',
      onSettled,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'restarting',
    operationId: 'reboot-op',
  });
  await act(async () =>
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [operation('running')],
    }),
  );
  expect(onSettled).not.toHaveBeenCalled();
  await reobserveRestart();
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'settled',
    operationId: 'reboot-op',
    state: 'succeeded',
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
  await act(async () =>
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [{ ...operation('succeeded'), revision: 3 }],
    }),
  );
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it.each([
  { ordering: 'after', loseReplyFirst: true },
  { ordering: 'before', loseReplyFirst: false },
])('settles the mounted restart from recovered Machine facts $ordering losing its original reply', async ({ loseReplyFirst }) => {
  const releaseReply = createDeferred<void>();
  const requests = await serveReboot(async () => {
    await releaseReply.promise;
    throw new TypeError('Reboot response lost');
  });

  const { consumeActionOperationSnapshotPush } = await import('@/sync/domains/actionOperations/consumeActionOperationSnapshotPush');
  const onSettled = vi.fn();
  const hook = await renderHook(() => useMachineSecurityReboot({ serverId, machineId, installationId, onSettled }));
  const invocation = createDeferred<void>();
  try {
    await act(async () => { void hook.getCurrent().start().then(invocation.resolve, invocation.reject); });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const { requestId } = requests[0];
    const dispatch = ActionOperationSnapshotV1Schema.parse({
      ...operation('running'), requestId,
    });
    await act(async () => consumeActionOperationSnapshotPush({
      update: { type: 'action-operation-updated', machineId, content: { t: 'plain', v: dispatch } },
      accountId, accountEncryptionMode: 'plain', sourceServerId: serverId,
      readSnapshot: async () => ({ kind: 'not_found' }),
    }));
    const loseReply = () => act(async () => {
      releaseReply.resolve();
      await invocation.promise;
    });
    if (loseReplyFirst) await loseReply();
    await reobserveRestart();
    expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toMatchObject([
      { snapshot: { operationId: 'reboot-op', requestId, state: 'succeeded' } },
    ]);
    expect(hook.getCurrent().reboot).toEqual({ kind: 'settled', operationId: 'reboot-op', state: 'succeeded' });
    expect(onSettled).toHaveBeenCalledTimes(1);
    if (!loseReplyFirst) {
      await loseReply();
      expect(hook.getCurrent().reboot).toEqual({ kind: 'settled', operationId: 'reboot-op', state: 'succeeded' });
      expect(onSettled).toHaveBeenCalledTimes(1);
    }
    expect(requests).toHaveLength(1);
  } finally {
    releaseReply.resolve();
    await hook.unmount();
  }
});

it('follows the approval receipt when the original invocation has not issued Machine transport', async () => {
  const artifactId = 'reboot-approval';
  let storedApproval: ApprovalRequest | null = null;
  const admittedReboot = vi.fn(async (): Promise<MachineRebootResultV1> => ({
    kind: 'accepted', operation: { operationId: 'reboot-op' }, bootedAt: 1,
  }));
  const executor = createActionExecutor(createActionExecutorBoundaryFixture({
    approvalsCreate: async ({ request }) => { storedApproval = request; return { artifactId }; },
    approvalsGet: async () => storedApproval,
    approvalsUpdate: async ({ request }) => { storedApproval = request; return { ok: true }; },
    isApprovalExecutionOriginCurrent: async ({ origin }) => origin.serverId === serverId && origin.accountId === accountId,
    machineReboot: admittedReboot,
  }));
  const context = { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId } as const;
  const created = await executor.execute('approval.request.create', {
    actionId: 'machines.reboot', actionArgs: { serverId, machineId, expectedInstallationId: installationId },
    summary: 'Restart the Machine', createdBy: { surface: 'system' },
  }, { ...context, actionRequestId: 'reboot-deferred-request' });
  expect(created).toMatchObject({ ok: true, result: { artifactId } });
  // This host admits through a deferred approval before issuing Machine transport.
  const execute = createFrontDoorActionExecute({ execute: async actionId => ({
    ok: true, result: { kind: 'approval_request_created', actionId, artifactId },
  }) });
  const onSettled = vi.fn();
  const hook = await renderHook(() => useMachineSecurityReboot({ serverId, machineId, installationId, execute, onSettled }));
  const invocation = createDeferred<void>();
  try {
    await act(async () => { void hook.getCurrent().start().then(invocation.resolve, invocation.reject); });
    const pending = hook.getCurrent().reboot;
    expect(pending).toMatchObject({ kind: 'starting', approval: { artifactId } });
    if (pending.kind !== 'starting' || pending.approval?.artifactId !== artifactId) throw new Error('Expected the deferred Reboot approval');
    const approval = pending.approval;
    expect(admittedReboot).toHaveBeenCalledTimes(0);
    expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context))
      .toMatchObject({ ok: true });
    const request = StoredApprovalRequestSchema.parse(storedApproval);
    await act(async () => {
      await approval.onExecuted({
        id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
        isDecrypted: true,
      });
      await invocation.promise;
    });
    expect(hook.getCurrent().reboot).toEqual({ kind: 'restarting', operationId: 'reboot-op' });
    expect(onSettled).toHaveBeenCalledTimes(0);
    await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation('running')] }));
    await reobserveRestart();
    expect(hook.getCurrent().reboot).toEqual({ kind: 'settled', operationId: 'reboot-op', state: 'succeeded' });
    expect(admittedReboot).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  } finally {
    await hook.unmount();
  }
});

it('does not dispatch a restart without the exact installation', async () => {
  const onSettled = vi.fn();
  const requests = await serveReboot(() => ({
    kind: 'blocked',
    reasons: ['session'],
  }));
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: null,
      onSettled,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(requests).toHaveLength(0);
  expect(hook.getCurrent().reboot).toEqual({ kind: 'idle' });
});
