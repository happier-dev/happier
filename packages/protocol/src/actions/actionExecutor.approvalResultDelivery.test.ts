import { describe, expect, it } from 'vitest';

import {
  ApprovalRequestV2Schema,
  type ApprovalRequest,
} from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { materializeActionRequestAttributionV1 } from './actionRequestAttributionV1.js';
import type { ActionExecutorDeps } from './executor/types.js';

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
    decision?: 'approve' | 'reject';
    effectFails?: boolean;
  }>,
) {
  let stored: ApprovalRequest | null = null;
  const effects: string[] = [];
  const deliveries: DeliveryArgs[] = [];
  const executor = createActionExecutor({
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(
        JSON.parse(JSON.stringify(request)),
      );
      return { artifactId: 'title-proposal' };
    },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(request);
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
  });
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
  const decide = async () =>
    await executor.execute(
      'approval.request.decide',
      {
        artifactId: 'title-proposal',
        decision: options.decision ?? 'approve',
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
  return { decide, effects, deliveries, read: () => stored };
}

describe('approval result delivery is a receipt beside the run record', () => {
  it('answers a run whose result the Session could not take with the run record and the refused receipt', async () => {
    const refusal = {
      phase: 'session.message.input_schema',
      errorClass: 'Error',
      errorCode: null,
      httpStatus: null,
    };
    const flow = await askAndDecide({
      deliver: async () => ({
        ok: false,
        errorCode: 'session_input_target_unavailable',
        error: 'session_input_target_unavailable',
        failureCause: refusal,
      }),
    });
    expect(await flow.decide()).toMatchObject({
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
    // A later approve only re-offers the same result under its retry identity; the effect never runs again.
    expect(await flow.decide()).toMatchObject({
      ok: true,
      result: { status: 'executed', delivery: { status: 'rejected' } },
    });
    expect(flow.effects).toEqual(['origin-session']);
    expect(
      flow.deliveries.map((delivery) => [delivery.sessionId, delivery.localId]),
    ).toEqual([
      ['origin-session', 'approval-result:title-proposal'],
      ['origin-session', 'approval-result:title-proposal'],
    ]);
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
    'answers a %s delivery with its receipt',
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
    },
  );

  it('reports a run that failed as failed and a rejection as rejected, unchanged', async () => {
    const failed = await askAndDecide({
      effectFails: true,
      deliver: async (input) => ({
        status: 'accepted',
        localId: input.localId,
      }),
    });
    expect(await failed.decide()).toMatchObject({
      ok: true,
      result: { status: 'failed', execution: { ok: false } },
    });
    expect(failed.effects).toEqual([]);
    const rejected = await askAndDecide({
      decision: 'reject',
      deliver: async (input) => ({
        status: 'accepted',
        localId: input.localId,
      }),
    });
    const answer = await rejected.decide();
    expect(answer).toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(rejected.effects).toEqual([]);
    expect(rejected.deliveries).toEqual([]);
  });
});
