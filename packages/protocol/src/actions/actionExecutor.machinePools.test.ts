import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
const plainLabel = (value: string) => ({ content: { t: 'plain' as const, v: value }, recipients: [] });
const poolView = {
  pool: {
    id: poolId,
    name: 'Fast',
    description: null,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    members: [],
  },
  availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
} as const;

describe('createActionExecutor (Machine Pools family)', () => {
  it('dispatches all six intents through one family dependency', async () => {
    const machinePoolAction = vi.fn(async ({ actionId }: Readonly<{ actionId: string }>) => {
      if (actionId === 'machines.pools.list') return { pools: [poolView] };
      if (actionId === 'machines.pools.delete') return { poolId, deleted: true };
      if (actionId === 'machines.pools.resolve') return { kind: 'unavailable', poolId, reason: 'empty' };
      return poolView;
    });
    const executor = createActionExecutor({
      machinePoolAction,
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.pools.delete': ['ui'] } }),
    } as unknown as ActionExecutorDeps);
    const inputs = {
      'machines.pools.list': {},
      'machines.pools.get': { poolId },
      'machines.pools.create': { poolId, name: plainLabel('Fast'), members: [] },
      'machines.pools.update': { poolId, expectedRevision: 0, name: plainLabel('Fast'), members: [] },
      'machines.pools.delete': { poolId, expectedRevision: 0 },
      'machines.pools.resolve': { poolId, requestKey: 'request-1' },
    } as const;

    for (const actionId of MACHINE_POOL_ACTION_IDS_V1) {
      await expect(executor.execute(actionId, inputs[actionId], { surface: 'ui' }), actionId).resolves.toMatchObject({ ok: true });
    }
    expect(machinePoolAction.mock.calls.map(([call]) => call.actionId)).toEqual(MACHINE_POOL_ACTION_IDS_V1);
  });

  it('keeps an automated Pool create deferred until the canonical approval replay', async () => {
    let stored: ApprovalRequest | null = null;
    const effects: unknown[] = [];
    const input = { poolId, name: plainLabel('Fast'), members: [] };
    const executor = createActionExecutor({
      machinePoolAction: async (request) => {
        effects.push(request);
        return poolView;
      },
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['machines.pools.create']: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'pool-create-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
      serverId: 'home',
      runtimeAccountId: 'alice',
      actionRequestId: 'pool-create-attempt',
    };

    await expect(executor.execute('machines.pools.create', input, context)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'pool-create-approval' },
    });
    expect(effects).toEqual([]);
    expect(stored).toMatchObject({
      actionId: 'machines.pools.create',
      actionArgs: input,
      approval: { flow: 'deferred', result: 'optional' },
      executionOriginV1: { surface: 'agent', authority: 'account_automation', accountId: 'alice' },
    });
    if (!stored) throw new Error('Missing Pool create approval');
    stored = ApprovalRequestV2Schema.parse({
      ...stored,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    await expect(executor.replayApprovedApprovalRequest({ artifactId: 'pool-create-approval' }))
      .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects).toEqual([expect.objectContaining({
      actionId: 'machines.pools.create',
      input,
      context: expect.objectContaining({
        surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice',
      }),
    })]);
    expect(stored).toMatchObject({ status: 'executed', execution: { result: poolView } });
  });

  it('fails closed when the Account server adapter is absent', async () => {
    const executor = createActionExecutor({  } as unknown as ActionExecutorDeps);
    await expect(executor.execute('machines.pools.list', {}, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:machines.pools.list',
    });
  });

  it('admits a workspace at the captured portable Home without admitting another Home', async () => {
    const executor = createActionExecutor({ machinePoolAction: async () => poolView } as unknown as ActionExecutorDeps);
    const context = { surface: 'cli', serverId: 'local-profile', serverIdentityId: 'srv_same_home' } as const;
    const input = { poolId, requestKey: 'home-alias', purpose: 'finite',
      workspace: { serverId: 'srv_same_home', refId: 'checkout' } } as const;
    expect(await executor.execute('machines.pools.resolve', input, context))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'empty' } });
    expect(await executor.execute('machines.pools.resolve', { ...input, workspace: { ...input.workspace, serverId: 'foreign' } }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });

  it('resolves finite and service starts from exact status reads before applying the shared pool ranking', async () => {
    // These dependencies are the authenticated Home and Machine network boundaries.
    const requests: unknown[] = [];
    const machinePoolAction: NonNullable<ActionExecutorDeps['machinePoolAction']> = async ({ actionId }) => {
      expect(actionId).toBe('machines.pools.get');
      return { ...poolView, pool: { ...poolView.pool, members: [
        { machineId: 'busy', enabled: true, priorityTier: 0, state: 'connected' },
        { machineId: 'unknown', enabled: true, priorityTier: 0, state: 'connected' },
        { machineId: 'idle', enabled: true, priorityTier: 1, state: 'connected' },
        { machineId: 'unsupported', enabled: true, priorityTier: 0, state: 'connected' },
        { machineId: 'offline', enabled: true, priorityTier: 0, state: 'offline' },
      ] } };
    };
    const projectWorkerAction: NonNullable<ActionExecutorDeps['projectWorkerAction']> = async ({ input }) => {
      requests.push(input);
      const request = input as { destination: { machineId: string } };
      if (request.destination.machineId === 'unsupported') return {
        eligible: false, load: { kind: 'unknown' }, candidate: null, explanation: 'capability_unknown',
      };
      return {
        eligible: true, candidate: { serverId: 'home', machineId: request.destination.machineId },
        load: request.destination.machineId === 'unknown' ? { kind: 'unknown' }
          : { kind: 'known', running: request.destination.machineId === 'busy' ? 4 : 0,
            queued: 9, accepting: true, runAtMost: 4 },
        explanation: request.destination.machineId === 'unknown' ? 'load_unknown' : 'eligible',
      };
    };
    const executor = createActionExecutor({ machinePoolAction, projectWorkerAction } as unknown as ActionExecutorDeps);
    for (const purpose of ['finite', 'service-start'] as const) {
      const input = { poolId, requestKey: 'one', purpose, workspace: { serverId: 'home', refId: 'checkout' } };
      await expect(executor.execute('machines.pools.resolve', input, { surface: 'ui', serverId: 'home' }))
        .resolves.toEqual({ ok: true, result: { kind: 'resolved', poolId, machineId: 'busy', priorityTier: 0 } });
    }
    expect(requests).toHaveLength(8);
    expect(requests).toContainEqual({ workspace: { serverId: 'home', refId: 'checkout' },
      destination: { kind: 'machine', machineId: 'busy' }, purpose: 'finite' });
    expect(requests).toContainEqual({ workspace: { serverId: 'home', refId: 'checkout' },
      destination: { kind: 'machine', machineId: 'busy' }, purpose: 'service-start' });
  });

  it('keeps all-unknown affinity and refuses a mismatched target result without changing Home', async () => {
    let swapped = false;
    const machinePoolAction: NonNullable<ActionExecutorDeps['machinePoolAction']> = async ({ context }) => {
      expect(context.serverId).toBe('home');
      return { ...poolView, pool: { ...poolView.pool, members: ['fallback-a', 'fallback-b'].map(machineId => ({
        machineId, enabled: true, priorityTier: 3, state: 'connected',
      })) } };
    };
    const projectWorkerAction: NonNullable<ActionExecutorDeps['projectWorkerAction']> = async ({ input, context }) => {
      expect(context.serverId).toBe('home');
      const request = input as { destination: { machineId: string } };
      return { eligible: true, load: { kind: 'unknown' }, explanation: 'load_unknown',
        candidate: { serverId: swapped ? 'other-home' : 'home', machineId: request.destination.machineId } };
    };
    const executor = createActionExecutor({ machinePoolAction, projectWorkerAction } as unknown as ActionExecutorDeps);
    const input = { poolId, requestKey: 'one', purpose: 'finite', workspace: { serverId: 'home', refId: 'checkout' } };
    await expect(executor.execute('machines.pools.resolve', input, { surface: 'cli' })).resolves.toEqual({
      ok: true, result: { kind: 'resolved', poolId, machineId: 'fallback-b', priorityTier: 3 },
    });
    swapped = true;
    await expect(executor.execute('machines.pools.resolve', input, { surface: 'cli' })).resolves.toEqual({
      ok: true, result: { kind: 'unavailable', poolId, reason: 'worker_status_unavailable' },
    });
    await expect(executor.execute('machines.pools.resolve', input, { surface: 'ui', serverId: 'other-home' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });
});
