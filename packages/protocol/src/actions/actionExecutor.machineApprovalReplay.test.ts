import { prepareHostReviewedChildPolicyV1 } from './executor/deploymentRoleApproval.js';
import { SessionSpawnNewInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from './externalActionExecutionAuthorization.js';
import tweetnacl from 'tweetnacl';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';
import { buildApprovalExecutionOriginV1, createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';

import { createActionAutomationPortV1 } from './executor/actionAutomationAdmission.js';

describe('Machine approval replay composition', () => {
  // Each recorded way back that needs approval opens its own Ask; Undo's approval grants it nothing.
  it.each([
    ['machines.terminal.open', false], ['machines.terminal.open', true],
    ['machines.processes.startAgain', false], ['machines.processes.startAgain', true],
  ] as const)('replays approved signed CLI Guard Undo whose %s way back has policy Ask=%s', async (childActionId, childAsks) => {
    const actionId = 'machines.guard.activity.undo';
    const input = { serverId: 'home', machineId: 'controller', entryId: 'closed-terminal' };
    const target = { kind: 'machine', machineId: input.machineId } as const;
    const envelope = { v: 1 as const, requestId: 'guard-undo', target, input };
    const keys = tweetnacl.sign.keyPair();
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-admission', binding: {
      serverIdentityId: 'srv_home', accountId: 'owner', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId: input.machineId, installationId: 'installation', actionId, requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
    } });
    const signedActions: string[] = [];
    const sign: NonNullable<ActionExecutorContext['signExternalActionApprovalInput']> = request => {
      signedActions.push(request.actionId);
      return signExternalActionApprovalInputV1({ ...request, authorizationToken: authorization.token, privateKey: keys.secretKey });
    };
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home', actionRequestId: envelope.requestId,
      externalActionExecutionAuthorization: authorization, externalActionTarget: target, originalActionEnvelope: envelope,
      signExternalActionApprovalInput: sign,
    };
    let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Undo closed terminal',
      actionId, actionArgs: input, decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: buildApprovalExecutionOriginV1({ actionId, input, context, targetSessionId: null }),
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, ...(childAsks
      ? { actions: { [childActionId]: { approvalRequiredSurfaces: ['cli'] } } }
      : { approvalWaivedSurfaces: { [childActionId]: ['cli'] } }) });
    const childRequests: string[] = [];
    let terminalEffects = 0;
    const executor = createActionExecutor({
      actionAutomations: createActionAutomationPortV1({ accountId: 'owner',
        seed: async () => ({ v: 1, rows: [] }), settle: async () => {} }),
      // Artifact storage, the Home authorization check and Machine effect ports are boundaries.
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      approvalsCreate: async ({ request }) => {
        childRequests.push(ApprovalRequestV2Schema.parse(request).actionId);
        return { artifactId: 'terminal-open-approval' };
      },
      isApprovalExecutionOriginCurrent: async ({ origin, request }) => verifyExternalActionApprovalInputV1({
        authorizationToken: authorization.token, actionId: request.actionId, input: request.actionArgs,
        target, publicKey: keys.publicKey, signature: origin.externalActionInputSignature ?? '',
      }),
      prepareApprovalExecutionAuthorization: async () => ({ authorization, actionsSettings: settings,
        signExternalActionApprovalInput: sign }),
      machineGuardAction: async ({ executeCanonicalAction }) => {
        const childResult = await executeCanonicalAction!(childActionId, childActionId === 'machines.terminal.open'
          ? { serverId: input.serverId, machineId: input.machineId, terminalKey: 'closed-terminal' }
          : { serverId: input.serverId, machineId: input.machineId, ref: 'left-behind-process' });
        return childResult.ok ? childResult.result : childResult;
      },
      machineTerminalAction: async () => {
        terminalEffects++;
        return { ok: true, terminalId: 'reopened', reused: false };
      },
      machineProcessesAction: async () => {
        terminalEffects++;
        return { status: 'started' };
      },
    });
    const replay = await executor.replayApprovedApprovalRequest({ artifactId: 'guard-undo-approval',
      callerAuthority: 'present_user', currentAccount: {
        accountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home', actionsSettings: settings,
      } });
    const outcome = replay.ok
      ? { status: stored.status, code: stored.execution?.errorCode, childRequests, terminalEffects }
      : { code: replay.errorCode, childRequests, terminalEffects };
    expect(signedActions).toEqual(childAsks ? [actionId, childActionId] : [actionId]);
    expect(outcome).toMatchObject({ status: 'executed', code: undefined,
      childRequests: childAsks ? [childActionId] : [], terminalEffects: childAsks ? 0 : 1 });
  });

  it.each([false, true])('restores the signed Session requester policy for native children (required=%s)', async required => {
    const keys = tweetnacl.sign.keyPair();
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'signed-spawn', executionTarget: { serverId: 'home', machineId: 'controller' },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, memoryEnabled: false,
      configuration: { mode: { value: null, updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } });
    const envelope = { v: 1 as const, requestId: 'signed-spawn', input, target: { kind: 'machine' as const, machineId: 'controller' } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admission', binding: {
      serverIdentityId: 'srv_home', accountId: 'owner', custodianAccountId: 'owner',
      authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId: 'controller', installationId: 'installation', actionId: 'session.spawn_new',
      requestId: 'signed-spawn', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: { kind: 'machine', machineId: 'controller' },
    } });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: required
      ? { 'action.invoke': { approvalRequiredSurfaces: ['cli'] } } : {} });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home', actionRequestId: 'signed-spawn',
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      originalActionEnvelope: envelope,
      signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ ...request,
        authorizationToken: authorization.token, privateKey: keys.secretKey }),
    };
    let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Start Session',
      actionId: 'session.spawn_new', actionArgs: input, decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'session.spawn_new', input, context, targetSessionId: null }),
    });
    let nativeEffects = 0;
    const policies: (ReturnType<typeof prepareHostReviewedChildPolicyV1>)[] = [];
    const executor = createActionExecutor({
      // Artifact storage, Home admission restoration and the native Session host
      // are process boundaries; the signed origin, replay and child policy stay real.
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async ({ origin, request }) => verifyExternalActionApprovalInputV1({
        authorizationToken: authorization.token, actionId: request.actionId, input: request.actionArgs,
        target: authorization.binding.target, publicKey: keys.publicKey, signature: origin.externalActionInputSignature ?? '',
      }),
      prepareApprovalExecutionAuthorization: async () => ({ authorization, actionsSettings: settings }),
      sessionSpawnNew: async args => {
        const policy = prepareHostReviewedChildPolicyV1({ action: { pluginId: 'acme.compute', localId: 'acquire' }, role: 'acquire' }, args.context!);
        policies.push(policy);
        if (!policy || policy.requiredActionIds.length > 0) return SessionSpawnNewResultV1Schema.parse({
          type: 'error', code: 'spawn_failed', retryable: false });
        nativeEffects++;
        return SessionSpawnNewResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'created',
          executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
          initialInput: { status: 'notRequested' } });
      },
    });
    const result = await executor.replayApprovedApprovalRequest({ artifactId: 'signed-spawn-approval', callerAuthority: 'present_user',
      // A deciding caller's permissive policy must not replace the original requester's.
      currentAccount: { accountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) } });
    expect(policies).toEqual([expect.objectContaining({ requiredActionIds: required ? ['action.invoke'] : [] })]);
    expect(nativeEffects).toBe(required ? 0 : 1);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: required ? 'failed' : 'executed', execution: { ok: !required } } });
  });

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
