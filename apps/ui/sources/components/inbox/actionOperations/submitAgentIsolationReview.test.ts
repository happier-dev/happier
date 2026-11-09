import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';

import { projectActionOperationDetail } from './actionOperationDetailPresentation';
import { refreshAgentIsolationReview, submitAgentIsolationReview } from './submitAgentIsolationReview';

const rpc = vi.hoisted(() => ({ invoke: vi.fn<(input: { method: string; payload: unknown; signal?: AbortSignal }) => Promise<unknown>>() }));
// The daemon RPC is the boundary. Action admission, operand parsing and operation publication remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc.invoke }));
afterEach(() => { rpc.invoke.mockReset(); actionOperationStore.reset(); });

const current = {
  kind: 'ready' as const,
  plan: {
    roots: [
      {
        rootId: 'root-1',
        path: '/srv/shop',
        changes: ['group' as const, 'gitShared' as const],
      },
    ],
    ancestorAcls: [{ path: '/srv', add: 'x' as const }],
    sessionsToReplace: 2,
    requiresAdmin: true,
    planDigest: 'digest-fresh',
  },
  policy: { enabled: false },
  metadataVersion: 7,
  status: { kind: 'disabled' as const },
};

function heldReview(
  overrides: Partial<ActionOperationSnapshotV1> = {},
): QualifiedActionOperation {
  return {
    serverId: 'home-a',
    snapshot: {
      version: 1,
      operationId: 'operation-1',
      revision: 4,
      actionId: 'machines.agentIsolation.set',
      state: 'running',
      scope: { accountId: 'account-1', machineId: 'machine-1' },
      title: 'Change Agent isolation',
      requestId: 'request-original',
      createdAt: 1_000,
      startedAt: 1_100,
      cancellation: 'unsupported',
      observation: {
        kind: 'review_required',
        code: 'agent_isolation_effect_changed',
        machineId: 'machine-1',
        enabled: true,
        current,
      },
      ...overrides,
    },
  } as QualifiedActionOperation;
}

function submit(operation: QualifiedActionOperation, outcome: unknown) {
  const execute = vi.fn(
    async () => outcome,
  ) as unknown as FrontDoorActionExecute & ReturnType<typeof vi.fn>;
  const detail = projectActionOperationDetail(
    operation.snapshot,
    'available',
  ).agentIsolationReview!;
  return {
    execute,
    result: submitAgentIsolationReview({ operation, detail, execute }),
  };
}

describe('submitAgentIsolationReview', () => {
  it('re-reviews through the Action owner and publishes fresh effects instead of the retained review', async () => {
    const operation = heldReview();
    const fresh = { ...operation.snapshot, revision: 5, observation: {
      ...operation.snapshot.observation!, current: { ...current, plan: { ...current.plan, planDigest: 'digest-new-effects' } },
    } };
    rpc.invoke.mockImplementation(async ({ payload }) => ({ kind: 'found', operation:
      payload && typeof payload === 'object' && 'refreshSetupReview' in payload && payload.refreshSetupReview === true
        ? fresh : operation.snapshot }));
    actionOperationStore.mergeSnapshots({ serverId: operation.serverId, snapshots: [operation.snapshot] });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: rpc.invoke }),
    }));
    const execute = createFrontDoorActionExecute({ execute: (id, input, context) => executor.execute(id, input,
      { ...context, runtimeAccountId: operation.snapshot.scope.accountId }) });
    const signal = new AbortController().signal;
    expect(await refreshAgentIsolationReview(operation, signal, execute)).toBe(true);
    expect([...actionOperationStore.getSnapshot().operationsByKey.values()].map(row => row.snapshot))
      .toEqual([fresh]);
    expect(rpc.invoke.mock.calls.map(([request]) => ({ method: request.method, payload: request.payload, signal: request.signal })))
      .toEqual([{ method: 'actionOperation.get.v2', payload: { operationId: operation.snapshot.operationId, refreshSetupReview: true }, signal }]);
  });
  it.each([undefined, 'linuxUsersV1'] as const)('resumes the held operation with the exact reviewed member provisioning (%s)', async memberProvisioning => {
    const reviewed = { ...current, plan: { ...current.plan,
      ...(memberProvisioning ? { memberProvisioning } : {}) } };
    const { execute, result } = submit(heldReview({ observation: {
      kind: 'review_required', code: 'agent_isolation_effect_changed',
      machineId: 'machine-1', enabled: true, current: reviewed,
    } }), {
      ok: true,
      result: {
        kind: 'accepted',
        operationId: 'operation-1',
        metadataVersion: 8,
        status: { kind: 'applying', phase: 'account' },
      },
    });
    await expect(result).resolves.toEqual({ kind: 'applying' });
    expect(execute).toHaveBeenCalledTimes(1);
    const [actionId, input, context] = execute.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(actionId).toBe('machines.agentIsolation.set');
    expect(input).toEqual({
      serverId: 'home-a',
      machineId: 'machine-1',
      enabled: true,
      ...(memberProvisioning ? { memberProvisioning } : {}),
      expectedPolicy: { enabled: false },
      expectedMetadataVersion: 7,
      expectedPlanDigest: 'digest-fresh',
    });
    // Never a fresh identity: that would start a second operation instead of resuming this one.
    expect(context).toMatchObject({
      surface: 'ui',
      actionRequestId: 'request-original',
      expectedAccountId: 'account-1',
      authority: 'present_user',
      presentUserConfirmation: { actionId: 'machines.agentIsolation.set' },
    });
  });

  it.each([
    [
      'a typed plan change',
      { ok: true, result: { kind: 'plan_changed', current } },
    ],
    [
      'a stale policy',
      {
        ok: true,
        result: {
          kind: 'conflict',
          policy: { enabled: true },
          metadataVersion: 9,
        },
      },
    ],
    [
      'the owner refusing a stale digest as an input conflict',
      {
        ok: false,
        errorCode: 'action_request_input_conflict',
        error: 'action_request_input_conflict',
      },
    ],
    [
      'an operation no longer open for review',
      {
        ok: false,
        errorCode: 'action_operation_unavailable',
        error: 'action_operation_unavailable',
      },
    ],
  ])(
    'reports %s as a changed review the person must review again',
    async (_name, outcome) => {
      await expect(submit(heldReview(), outcome).result).resolves.toEqual({
        kind: 'review_changed',
      });
    },
  );

  it('keeps an unconfirmed elevated outcome distinct, and an Ask-first setting as pending approval', async () => {
    await expect(
      submit(heldReview(), {
        ok: true,
        result: {
          kind: 'failed',
          operationId: 'operation-1',
          code: 'outcome_unknown',
        },
      }).result,
    ).resolves.toEqual({ kind: 'outcome_unknown' });
    await expect(
      submit(heldReview(), {
        ok: true,
        result: { kind: 'failed', operationId: 'operation-1', code: 'denied' },
      }).result,
    ).resolves.toEqual({ kind: 'refused', code: 'denied' });
    await expect(
      submit(heldReview(), {
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'artifact-1', actionId: 'machines.agentIsolation.set' },
      }).result,
    ).resolves.toEqual({ kind: 'approval_requested', artifactId: 'artifact-1' });
  });

  it('submits nothing without the original request identity', async () => {
    const { execute, result } = submit(heldReview({ requestId: undefined }), {
      ok: true,
      result: {},
    });
    await expect(result).resolves.toEqual({
      kind: 'failed',
      errorCode: 'action_operation_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
