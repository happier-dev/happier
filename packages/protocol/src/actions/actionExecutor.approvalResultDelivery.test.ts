import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalRequestV2Schema,
  type ApprovalRequest,
} from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { materializeActionRequestAttributionV1 } from './actionRequestAttributionV1.js';
import { createActionExecuteFailureError } from './actionExecutionResult.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { ActionOperationSnapshotV1 } from './operations/v1.js';

type Delivery = NonNullable<ActionExecutorDeps['sessionSendMessage']>;
type DeliveryArgs = Parameters<Delivery>[0];

const cause = materializeActionRequestAttributionV1({
  requestRef: 'original-person-input',
  requester: { serverId: 'home', accountId: 'account' },
  persona: { serverId: 'home', sessionId: 'origin-session' },
  origin: null,
});

/**
 * Artifact persistence, origin currentness, the Session write adapter and the
 * Session sender are boundaries; admission, decision, execution and result
 * delivery settlement stay real.
 */
async function askAndDecide(
  options: Readonly<{
    deliver: (args: DeliveryArgs) => ReturnType<Delivery>;
    decision?: 'approve' | 'reject' | 'cancel';
    effectFails?: boolean;
    checkFailsWith?: 'refuse' | 'ask';
    checkObservationUnavailable?: boolean;
  }>,
) {
  let stored: ApprovalRequest | null = null;
  const effects: string[] = [];
  const deliveries: DeliveryArgs[] = [];
  const updates: ApprovalRequest['status'][] = [];
  const deps = {
    ...(options.checkFailsWith ? { actionAutomations: {
      select: async () => ({ status: 'ready' as const, subjects: [], after: [], before: [{
        automationId: 'review', triggerId: 'before', triggerRevision: 1, workflowId: 'workflow',
        workflowRevision: 1, ownerAccountId: 'account', actionIds: ['session.title.set'],
        phase: 'before' as const, mode: 'wait' as const, onFailure: options.checkFailsWith!,
      }] }),
      start: async () => ({ runs: [{ automationId: 'review', triggerId: 'before', runId: 'failed-check' }], notices: [] }),
      wait: async () => {
        if (options.checkObservationUnavailable) {
          throw createActionExecuteFailureError({ ok: false, errorCode: 'storage_unavailable', error: 'storage_unavailable' });
        }
        return { state: 'failed' as const, errorCode: 'command_failed' };
      },
      settle: async () => {},
    } } : {}),
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(
        JSON.parse(JSON.stringify(request)),
      );
      return { artifactId: 'title-proposal' };
    },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      updates.push(request.status);
      stored = ApprovalRequestV2Schema.parse(JSON.parse(JSON.stringify(request)));
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
    sessionStateFieldSet: async ({ sessionId }) => {
      if (options.effectFails)
        return {
          ok: false,
          errorCode: 'session_not_found',
          error: 'session_not_found',
          effectAttempted: false,
        };
      effects.push(sessionId);
      return { ok: true };
    },
    sessionSendMessage: async (input) => {
      deliveries.push(input);
      return await options.deliver(input);
    },
  } satisfies Partial<ActionExecutorDeps>;
  const executor = createActionExecutor(deps);
  expect(
    await executor.execute(
      'session.title.set',
      { title: 'Review the API' },
      {
        surface: 'agent',
        authority: 'account_automation',
        serverId: 'home',
        serverIdentityId: 'home',
        runtimeAccountId: 'account',
        actionRequestId: 'title-ask',
        actionRequestAttributionV1: cause,
        defaultSessionId: 'origin-session',
        defaultSessionMachineId: 'machine',
        actionsSettings: ActionsSettingsV1Schema.parse({
          v: 1,
          actions: {
            'session.title.set': { approvalRequiredSurfaces: ['agent'] },
          },
        }),
        actionCaller: {
          kind: 'session',
          sessionId: 'origin-session',
          starterDepth: 0,
          turnDepth: 0,
        },
      },
    ),
  ).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  // The deciding person is focused on another Session; delivery still targets the asking one.
  const decide = async (decision = options.decision ?? 'approve') =>
    await executor.execute(
      'approval.request.decide',
      {
        artifactId: 'title-proposal',
        decision,
      },
      {
        surface: 'ui',
        authority: 'present_user',
        serverId: 'home',
        serverIdentityId: 'home',
        runtimeAccountId: 'account',
        defaultSessionId: 'other-focused-session',
      },
    );
  const refresh = () => createActionExecutor(deps).execute(
    'approval.request.get',
    { artifactId: 'title-proposal' },
    { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' },
  );
  return { decide, effects, deliveries, updates, refresh, read: () => stored };
}

describe('approval result delivery is a receipt beside the run record', () => {
  it('continues the admitted Agent acquire to the asking Session when it needs confirmation and starts the child', async () => {
    const seed = await askAndDecide({ deliver: async input => ({ status: 'accepted', localId: input.localId }) });
    await seed.decide();
    const prior = ApprovalRequestV2Schema.parse(seed.read());
    const controller = { machineId: 'preset-controller', installationId: 'controller-installation' };
    const provider = { pluginId: 'custom.compute', localId: 'native' };
    const resource = { contributionRef: provider, schemaVersion: 1, value: { id: 'native-guest' } };
    const machine = { id: 'our-guest', homeId: 'home', custodianAccountId: 'team-owner',
      enrollmentAccountId: 'account', controller, resource, allocation: 'bound', creationState: 'active',
      desired: 'start', desiredWhen: 'now', intentRevision: 0,
      launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const actionId = 'machines.managed.acquire';
    const accepted = { managedId: machine.id, operation: { operationId: 'our-acquire-operation' } };
    const { delivery: _delivery, ...originated } = prior;
    let request = ApprovalRequestV2Schema.parse({ ...originated, actionId,
      actionArgs: { selection: { kind: 'preset', homeId: 'home', id: 'team-preset', revision: 1 },
        agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent',
          identity: { pluginId: 'custom.compute', localId: 'agent' } } } },
      executionOriginV1: { ...prior.executionOriginV1, actionId },
      execution: { ...prior.execution, ok: true, result: accepted },
    });
    const waiting = Promise.withResolvers<ActionOperationSnapshotV1>();
    const terminal = Promise.withResolvers<ActionOperationSnapshotV1>();
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: accepted.operation.operationId,
      revision: 2, actionId, state: 'running', scope: { accountId: 'account', machineId: controller.machineId },
      title: 'Acquire', createdAt: 1, startedAt: 1, cancellation: 'supported',
      domainRef: { kind: 'managedMachine', id: machine.id, controller, resource, bootstrapTask: {
        id: 'our-sign-in-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
        prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign in this Machine' },
      } },
    };
    const deliveries: Array<{ sessionId: string; message: unknown }> = [];
    const reads: unknown[] = [];
    const executor = createActionExecutor({
      approvalsGet: async () => request,
      approvalsUpdate: async ({ request: next }) => { request = ApprovalRequestV2Schema.parse(next); return { ok: true }; },
      managedMachineAction: async ({ actionId: id, input }) => {
        expect(id).toBe('machines.managed.get');
        expect(input).toEqual({ homeId: 'home', managedId: machine.id });
        return machine;
      },
      actionOperationAction: async ({ input }) => {
        reads.push(input);
        return { kind: 'found', operation: await (reads.length === 1 ? waiting.promise : terminal.promise) };
      },
      sessionSendMessage: async input => {
        deliveries.push({ sessionId: input.sessionId, message: JSON.parse(input.message) });
        return { status: 'accepted', localId: input.localId };
      },
    });
    const replay = () => executor.replayApprovedApprovalRequest({ artifactId: 'acquire-ask', callerAuthority: 'present_user',
      currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'home' } });
    expect(await replay()).toMatchObject({ ok: true, result: { execution: { ok: true, result: accepted } } });
    expect(deliveries).toHaveLength(1);
    waiting.resolve(operation);
    await vi.waitFor(() => expect(deliveries[1]).toMatchObject({ sessionId: 'origin-session', message: {
      actionId, artifactId: 'acquire-ask', managedId: machine.id, operationId: operation.operationId,
      kind: 'waiting_for_machine_sign_in',
    } }));
    terminal.resolve({ ...operation, state: 'succeeded', revision: 3, settledAt: 3, result: accepted,
      domainRef: { kind: 'managedMachine', id: machine.id, controller, resource, childSessionId: 'child-session' },
    });
    await vi.waitFor(() => expect(deliveries[2]).toMatchObject({ sessionId: 'origin-session', message: {
      actionId, artifactId: 'acquire-ask', managedId: machine.id, operationId: operation.operationId,
      kind: 'machine_agent_session_started', sessionId: 'child-session',
    } }));
    expect(await replay()).toMatchObject({ ok: true, result: { delivery: { status: 'accepted' } } });
    expect(deliveries).toHaveLength(3);
    expect(JSON.stringify(deliveries)).not.toContain('our-sign-in-task');
    expect(reads).toEqual([
      { serverId: 'home', machineId: controller.machineId, operationId: operation.operationId,
        waitForTerminal: true, includeManagedPrompt: true },
      { serverId: 'home', machineId: controller.machineId, operationId: operation.operationId, waitForTerminal: true },
    ]);
  });

  it('answers a run whose result the Session could not take with the run record and the refused receipt', async () => {
    const refusal = {
      phase: 'session.message.input_schema',
      errorClass: 'Error',
      errorCode: null,
      httpStatus: null,
    };
    let attempts = 0;
    const flow = await askAndDecide({
      deliver: async () => {
        if (++attempts > 1) throw new Error('socket closed on replay');
        return {
          ok: false,
          errorCode: 'session_input_target_unavailable',
          error: 'session_input_target_unavailable',
          failureCause: refusal,
        };
      },
    });
    const settled = await flow.decide();
    expect(settled).toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        execution: { ok: true },
        delivery: {
          status: 'rejected',
          code: 'session_input_target_unavailable',
          failureCause: { phase: 'session.message.input_schema' },
        },
      },
    });
    expect(flow.effects).toEqual(['origin-session']);
    expect(flow.read()).toMatchObject({
      status: 'executed',
      execution: { ok: true },
    });
    expect(await flow.decide()).toEqual(settled);
    expect(await flow.refresh()).toMatchObject({ ok: true, result: { request: {
      status: 'executed',
      delivery: {
        status: 'rejected',
        code: 'session_input_target_unavailable',
        failureCause: { phase: 'session.message.input_schema' },
      },
    } } });
    expect(flow.effects).toEqual(['origin-session']);
    expect(flow.deliveries.map(({ sessionId, localId }) => [sessionId, localId]))
      .toEqual([['origin-session', 'approval-result:title-proposal']]);
    expect(flow.updates).toEqual(['approved', 'executing', 'executed', 'executed']);
  });

  it('keeps an unknown Session-sender code as a refused receipt with its cause, and a lost acknowledgement as unknown', async () => {
    const unreachable = await askAndDecide({
      deliver: async () => ({
        ok: false,
        errorCode: 'machine_unreachable',
        error: 'machine_unreachable',
      }),
    });
    expect(await unreachable.decide()).toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        delivery: {
          status: 'rejected',
          code: 'session_input_target_unavailable',
          failureCause: { phase: 'approval.result.delivery' },
        },
      },
    });
    const lost = await askAndDecide({
      deliver: async () => {
        throw new Error('socket closed');
      },
    });
    expect(await lost.decide()).toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        delivery: {
          status: 'outcomeUnknown',
          localId: 'approval-result:title-proposal',
          code: 'session_input_settlement_outcome_unknown',
        },
      },
    });
    expect(await lost.refresh()).toMatchObject({ ok: true, result: { request: {
      status: 'executed',
      delivery: {
        status: 'outcomeUnknown',
        localId: 'approval-result:title-proposal',
        code: 'session_input_settlement_outcome_unknown',
      },
    } } });
    expect(lost.updates).toEqual(['approved', 'executing', 'executed', 'executed']);
    expect(lost.effects).toEqual(['origin-session']);
    // A sender that throws its typed refusal keeps it as the refused receipt.
    const thrownRefusal = await askAndDecide({ deliver: async () => {
      throw { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
    } });
    expect(await thrownRefusal.decide()).toMatchObject({ ok: true, result: { status: 'executed',
      delivery: { status: 'rejected', code: 'session_input_target_update_required' } } });
  });

  it.each([
    [
      'accepted',
      { status: 'accepted', localId: 'approval-result:title-proposal' },
    ],
    [
      'held on the Machine path',
      {
        status: 'held',
        localId: 'approval-result:title-proposal',
        code: 'session_input_target_unavailable',
      },
    ],
  ] as const)(
    'answers and retains a %s delivery with one receipt update',
    async (_label, receipt) => {
      const flow = await askAndDecide({ deliver: async () => receipt });
      expect(await flow.decide()).toMatchObject({
        ok: true,
        result: {
          status: 'executed',
          execution: { ok: true },
          delivery: receipt,
        },
      });
      expect(await flow.refresh()).toMatchObject({ ok: true, result: { request: { status: 'executed', delivery: receipt } } });
      expect(flow.updates).toEqual(['approved', 'executing', 'executed', 'executed']);
    },
  );

  it('retains the initial person-Stop delivery receipt alongside the executed approval', async () => {
    const receipt = { status: 'held', localId: 'approval-result:title-proposal',
      code: 'session_input_target_unavailable', failureCause: { phase: 'session.message.send',
        errorClass: 'Error', errorCode: 'held_by_person', httpStatus: null } } as const;
    const flow = await askAndDecide({ deliver: async () => receipt });
    expect(await flow.decide()).toMatchObject({ ok: true, result: { status: 'executed', delivery: receipt } });
    expect(flow.read()).toMatchObject({ status: 'executed', execution: { ok: true }, delivery: receipt });
  });

  it('delivers a failed execution to the requesting Session', async () => {
    const failed = await askAndDecide({
      effectFails: true,
      deliver: async (input) => ({
        status: 'accepted',
        localId: input.localId,
      }),
    });
    expect(await failed.decide()).toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false }, delivery: { status: 'accepted' } },
    });
    expect(failed.effects).toEqual([]);
  });

  it.each([['reject', 'rejected'], ['cancel', 'canceled']] as const)(
    'delivers a %s decision to the requesting Session without executing the action',
    async (decision, status) => {
      const flow = await askAndDecide({
        decision,
        deliver: async (input) => ({ status: 'accepted', localId: input.localId }),
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await flow.decide()).toMatchObject({ ok: true, result: { status, delivery: { status: 'accepted' } } });
      }
      expect(flow.effects).toEqual([]);
      expect(flow.deliveries.map(({ sessionId, localId, message }) => ({ sessionId, localId, payload: JSON.parse(message) })))
        .toEqual([{ sessionId: 'origin-session', localId: 'approval-result:title-proposal',
          payload: { artifactId: 'title-proposal', actionId: 'session.title.set', ok: true, status } }]);
    });

  it.each([['refuse', 'failed'], ['ask', 'rejected']] as const)(
    'delivers terminal %s check settlement to the requesting Session', async (onFailure, status) => {
      const flow = await askAndDecide({ checkFailsWith: onFailure,
        deliver: async input => ({ status: 'accepted', localId: input.localId }) });
      if (onFailure === 'ask') {
        expect(await flow.decide()).toMatchObject({ ok: true, result: { status: 'open' } });
        expect(flow.deliveries).toEqual([]);
      }
      expect(await flow.decide(onFailure === 'ask' ? 'reject' : 'approve')).toMatchObject({
        ok: true, result: { status, delivery: { status: 'accepted' } },
      });
      expect(flow.effects).toEqual([]);
      expect(flow.deliveries).toEqual([expect.objectContaining({ sessionId: 'origin-session',
        localId: 'approval-result:title-proposal' })]);
      expect(JSON.parse(flow.deliveries[0]!.message)).toMatchObject({
        artifactId: 'title-proposal',
        actionId: 'session.title.set',
        status,
        execution: {
          ok: false,
          effectAttempted: false,
          errorCode: 'action_interception_rejected',
          details: { message: 'command_failed' },
        },
      });
  });

  it('retains the Run observation refusal in the approval and requester result', async () => {
    const flow = await askAndDecide({ checkFailsWith: 'ask', checkObservationUnavailable: true,
      deliver: async input => ({ status: 'accepted', localId: input.localId }) });
    expect(await flow.decide()).toMatchObject({ ok: true, result: { status: 'failed', delivery: { status: 'accepted' } } });
    expect(flow.effects).toEqual([]);
    expect(flow.read()).toMatchObject({ automaticChecks: { phase: 'refused', results: [
      { runId: 'failed-check', outcome: 'unavailable', reason: 'storage_unavailable' },
    ] } });
    expect(JSON.parse(flow.deliveries[0]!.message)).toMatchObject({ execution: {
      errorCode: 'action_interception_rejected', effectAttempted: false, details: { message: 'storage_unavailable' },
    } });
  });
});
