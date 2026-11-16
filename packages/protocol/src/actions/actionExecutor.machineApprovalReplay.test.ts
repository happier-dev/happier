import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';

describe('Machine approval replay composition', () => {
  it.each(['standalone-cli', 'controller-without-externalActionClient'] as const)(
    'forwards an agent Goal approval without checking the origin in the %s decider', async placement => {
      let stored = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'manager-1' }, requestedSurface: 'agent',
        actionId: 'session.goal.set', actionArgs: { sessionId: 'manager-1', objective: 'Ship goal controls', resumeInactiveWithInitialGoal: false },
        summary: 'Set goal', executionOriginV1: {
          v: 1, authority: 'account_automation', surface: 'agent',
          caller: { kind: 'session', sessionId: 'manager-1', starterDepth: 0, turnDepth: 0 },
          accountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home',
          machineId: 'origin-machine', sessionId: 'manager-1', target: { kind: 'machine', machineId: 'origin-machine' },
          actionId: 'session.goal.set', requestId: 'agent-goal-request', callerPermissionMode: 'yolo',
        },
      });
      const writes: string[] = [];
      const effects: unknown[] = [];
      const persistence = {
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }: Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0]) => {
          const transition = decideApprovalRequestTransition(stored, request);
          if (!transition.ok) return transition;
          stored = ApprovalRequestV2Schema.parse(request);
          writes.push(stored.status);
          return { ok: true as const };
        },
      };
      // Mutate the running caller's Goal. Cross-Session selection and starting
      // an inactive Session have separate ordinary admission prerequisites.
      const origin = createActionExecutor({ ...persistence,
        isApprovalExecutionOriginCurrent: async ({ origin }) => origin.machineId === 'origin-machine',
        resolveSessionReference: async ({ sessionId, context }) => ({ kind: 'unique', address: { serverId: context.serverId!, sessionId: sessionId! } }),
        sessionGoalSet: async input => { effects.push(input); return { ok: true }; },
      });
      let deciderReads = 0;
      const decider = createActionExecutor({ ...persistence,
        // A remote decider has no authority to evaluate the origin's local state.
        isApprovalExecutionOriginCurrent: async ({ reportStale }) => {
          deciderReads += 1;
          if (placement === 'controller-without-externalActionClient') reportStale?.('credential_changed');
          return false;
        },
        // Substitute the process transport only; the origin's replay, claim,
        // Session Action and shared transition owner remain real.
        approvalRequestApprovedReplay: async ({ artifactId, onReplayDispatched }) => {
          onReplayDispatched?.();
          return origin.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
        },
      });
      const decide = () => decider.execute('approval.request.decide', { artifactId: 'goal-approval', decision: 'approve' }, {
        surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'owner',
        ...(placement === 'controller-without-externalActionClient' ? { defaultSessionMachineId: 'controller-machine' } : {}),
      });
      const first = await decide();
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      expect(await decide()).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(effects).toEqual([expect.objectContaining({ sessionId: 'manager-1', objective: 'Ship goal controls' })]);
      expect(writes).toEqual(['approved', 'executing', 'executed']);
      expect(deciderReads).toBe(0);
    });

  it('leaves a pre-claim origin refusal approved and executes once after admission recovers', async () => {
    let stored = ApprovalRequestV2Schema.parse({
      v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', summary: 'Set goal',
      actionId: 'session.goal.set', actionArgs: { sessionId: 'manager-1', objective: 'Ship', resumeInactiveWithInitialGoal: false },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'home', sessionId: 'manager-1', machineId: 'origin-machine', actionId: 'session.goal.set', requestId: 'request' },
    });
    let current = false;
    let effects = 0;
    const executor = createActionExecutor({
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request); return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async ({ reportStale }) => {
        if (!current) reportStale?.('credential_changed'); return current;
      },
      resolveSessionReference: async ({ sessionId, context }) => ({ kind: 'unique', address: { serverId: context.serverId!, sessionId: sessionId! } }),
      sessionGoalSet: async () => { effects += 1; return { ok: true }; },
    });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'goal-approval' }))
      .toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false, details: { reason: 'credential_changed' } });
    expect(stored).toMatchObject({ status: 'approved' });
    expect(stored.execution).toBeUndefined();
    expect(effects).toBe(0);
    current = true;
    const recovered = await executor.replayApprovedApprovalRequest({ artifactId: 'goal-approval' });
    expect(recovered, JSON.stringify(recovered))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'goal-approval' }))
      .toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects).toBe(1);
  });

  it('reconstructs the approved Machine target before the filesystem owner executes', async () => {
    let stored: ApprovalRequest | null = null;
    const receivedContexts: ActionExecutorContext[] = [];
    const executor = createActionExecutor({
      readActionsSettings: context => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['daemon.filesystem.writeFile']: { approvalRequiredSurfaces: [context.surface ?? 'ui'] } } }),
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'machine-write-approval' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('missing_approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true as const };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      // The filesystem port is the genuine process boundary. Keep its production
      // target admission here so a missing or miswired replay target fails RED.
      filesystemActionExecute: async ({ context }) => {
        receivedContexts.push(context);
        return context.externalActionTarget?.kind === 'machine'
          && context.externalActionTarget.machineId === 'machine-1'
          ? { success: true, hash: 'written-hash' }
          : { ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable' };
      },
      sessionSendMessage: async ({ localId }) => ({ status: 'accepted', localId }),
    } satisfies ActionExecutorDeps);

    const pending = await executor.execute('daemon.filesystem.writeFile', {
      rootPath: '/workspace', path: 'approved.txt', content: 'b2s=',
    }, {
      surface: 'agent', authority: 'account_automation', serverId: 'server-1', runtimeAccountId: 'owner',
      actionRequestId: 'agent-write-1', defaultSessionId: 'session-1',
      defaultSessionMachineId: 'machine-1',
      actionCaller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
    });
    expect(pending).toMatchObject({ ok: true, result: { artifactId: 'machine-write-approval' } });
    expect(stored).toMatchObject({ executionOriginV1: { machineId: 'machine-1' } });
    expect(stored).toMatchObject({ executionOriginV1: { target: { kind: 'machine', machineId: 'machine-1' } } });

    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'machine-write-approval', decision: 'approve',
    }, { surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'owner' });

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0]?.externalActionTarget).toEqual({ kind: 'machine', machineId: 'machine-1' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  });
});
