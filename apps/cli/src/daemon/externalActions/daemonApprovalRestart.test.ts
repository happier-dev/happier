import { expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, SessionAgentSpawnPolicyV1Schema, SessionInputAdmissionResultV1Schema, type ApprovalRequestV2 } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';

const sessionId = 'session-restart';
const machineId = 'machine-restart';
const accountId = 'account-restart';
const serverId = 'restart-profile';
const serverIdentityId = 'srv_restart_home';

it.each([
  { actionId: 'session.status.get', actionArgs: { sessionId, live: true }, resumedBeforeDecision: false },
  { actionId: 'session.model.set', actionArgs: { sessionId, modelId: 'contributor-1.3' }, resumedBeforeDecision: false },
  { actionId: 'session.status.get', actionArgs: { sessionId, live: true }, resumedBeforeDecision: true },
  { actionId: 'session.model.set', actionArgs: { sessionId, modelId: 'contributor-1.3' }, resumedBeforeDecision: true },
] as const)('settles a deferred $actionId Ask on the replacement daemon (already resumed: $resumedBeforeDecision)', async ({
  actionId, actionArgs, resumedBeforeDecision,
}) => {
  const artifactId = 'session-restart-approval';
  const artifacts = new Map<string, ApprovalRequestV2>();
  const artifactPorts = {
    approvalsCreate: async ({ request }: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]) => {
      artifacts.set(artifactId, ApprovalRequestV2Schema.parse(request));
      return { artifactId };
    },
    approvalsGet: async () => artifacts.get(artifactId) ?? null,
    approvalsUpdate: async ({ request, expectedStatus }: Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0]) => {
      const current = ApprovalRequestV2Schema.parse(artifacts.get(artifactId));
      const transition = decideApprovalRequestTransition(current, request, { expectedStatus });
      if (!transition.ok) return transition;
      artifacts.set(artifactId, ApprovalRequestV2Schema.parse(request));
      return { ok: true as const };
    },
  };
  const statusRead = vi.fn(async () => ({
    session: { id: sessionId, active: true, createdAt: 1, updatedAt: 2, activeAt: 2, encryption: null },
  }));
  const modelWrite = vi.fn(async () => ({
    ok: true, status: 'intent_updated', sessionId, modelId: 'contributor-1.3', updatedAt: 2,
    selection: { v: 2, updatedAt: 2, ref: { source: 'native', agentTargetKey: 'museNative', modelId: 'contributor-1.3' } },
  }));
  const retained = { serverId, serverIdentityId, runtimeAccountId: accountId };
  const createDaemon = (isSessionRunning: () => boolean) => createActionExecutor({
    ...createUnavailableActionTransportDeps(), ...artifactPorts,
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
      accountId, machineId, serverId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }),
      isAccountCurrent: async () => true,
      resolveTarget: async () => ({ kind: 'machine', machineId }),
      isSessionCallerCurrent: async ({ caller }) => caller.sessionId === sessionId && isSessionRunning(),
      resolveCurrentPermissionMode: async () => 'yolo',
      resolveCurrentSessionAgentSpawnPolicyV1: async () => SessionAgentSpawnPolicyV1Schema.parse({}),
      listAccountApiTokens: async () => ({ tokens: [] }),
    }),
    sessionStatusGet: statusRead,
    sessionModelSet: modelWrite,
    sessionSendMessage: async ({ localId }) => isSessionRunning()
      ? SessionInputAdmissionResultV1Schema.parse({ status: 'accepted', localId })
      : { status: 'rejected', code: 'session_input_target_unavailable' },
  });
  const requestLife = new AbortController();
  const requested = await createDaemon(() => true).execute('approval.request.create',
    { actionId, actionArgs, summary: 'Session approval', createdBy: { surface: 'agent' } }, {
      ...retained, surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      defaultSessionId: sessionId, defaultSessionMachineId: machineId, actionRequestId: 'original-ask',
      callerPermissionMode: 'yolo',
      signal: requestLife.signal,
    });
  expect(requested).toMatchObject({ ok: true, result: { artifactId } });
  expect(artifacts.get(artifactId)).toMatchObject({ status: 'open', actionId, actionArgs,
    approval: { flow: 'deferred' }, executionOriginV1: { surface: 'agent', machineId, caller: { kind: 'session', sessionId } } });

  requestLife.abort();
  let resumed = resumedBeforeDecision;
  const replacement = createDaemon(() => resumed);
  const reviewer: ActionExecutorContext = { ...retained, surface: 'ui', authority: 'present_user' };
  const decide = () => replacement.execute('approval.request.decide', { artifactId, decision: 'approve' }, reviewer);
  const result = await decide();
  const receipt = resumedBeforeDecision
    ? { status: 'executed', execution: { ok: true } }
    : { status: 'failed', execution: { ok: false, effectAttempted: false, errorCode: 'approval_stale',
      details: { reason: 'session_changed' } } };
  expect(artifacts.get(artifactId)).toMatchObject(receipt);
  expect(result).toMatchObject({ ok: true, result: receipt });

  resumed = true;
  expect(await decide()).toMatchObject({ ok: true, result: receipt });
  expect(artifacts.get(artifactId)).toMatchObject(receipt);
  expect(statusRead).toHaveBeenCalledTimes(resumedBeforeDecision && actionId === 'session.status.get' ? 1 : 0);
  expect(modelWrite).toHaveBeenCalledTimes(resumedBeforeDecision && actionId === 'session.model.set' ? 1 : 0);
});
