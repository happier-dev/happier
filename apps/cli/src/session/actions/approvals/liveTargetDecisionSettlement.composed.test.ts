import { settleTargetActionExecution } from './targetActionSettlement';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { buildActionExecuteResultFromRecordedApprovalExecution } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestPublicReadSchema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { afterEach, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTargetActionCurrentIntentAdapter } from './targetActionCurrentIntent';

afterEach(() => getSharedBlockingApprovalCoordinator().dispose());

it.each([
  { custody: 'absent', status: 'open' }, { custody: 'absent', status: 'approved' }, { custody: 'present', status: 'open' },
] as const)('a $status live-only CLI approval with $custody local custody advances or settles a named refusal', async ({ custody, status }) => {
  const artifactId = `live-target-${custody}`;
  const intent = {
    action: { qualifiedId: 'acme.tunnel/actions/configure', pluginId: 'acme.tunnel', localId: 'configure', occurrenceId: 'tunnel',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'tunnel-root' }, dangerLevel: 'writesRemote' as const,
      scopes: ['global' as const], surfaces: ['cli' as const], hostAccess: [], input: { tunnelName: 'qa' },
      policyFingerprint: 'a'.repeat(64), confirmation: { title: 'Configure Tunnel' } },
    fingerprint: 'b'.repeat(64), surface: 'cli' as const, approvalInputCustody: 'live_only' as const,
  };
  let stored: TargetActionApprovalRequestV1 | null = null;
  const read = async () => stored && structuredClone(stored);
  const update = async ({ request }: { request: TargetActionApprovalRequestV1 }) => {
    if (!stored) throw new Error('Missing Artifact');
    const admitted = admitTargetActionApprovalTransition(stored, request);
    if (admitted.ok) stored = TargetActionApprovalRequestV1Schema.parse(request);
    return admitted;
  };
  let ready!: () => void;
  const created = new Promise<void>(resolve => { ready = resolve; });
  // Only the durable Artifact boundary is substituted. The CLI waiter, private
  // decision witness, public Action ingress and transition owner remain real.
  const adapter = createTargetActionCurrentIntentAdapter({ read, update,
    subscribeChanges: () => { ready(); return { dispose() {} }; },
    create: async request => {
      stored ??= request;
      return { artifactId, request: stored };
    } });
  const seed = createTargetActionCurrentIntentAdapter({ read,
    create: async request => { stored = request; return { artifactId }; } });
  // The remote decider has no process-local waiter when the original CLI is on
  // another process and the record has no replay placement, as in the incident.
  if (custody === 'absent') {
    const { approvalInputCustody: _liveOnly, ...durableIntent } = intent;
    await seed(durableIntent);
    stored = TargetActionApprovalRequestV1Schema.parse({ ...stored, approvalInputCustody: 'live_only', status,
      ...(status === 'approved' ? { decision: { kind: 'approve', decidedAtMs: Date.now() } } : {}) });
  }
  const pending = custody === 'present' ? adapter(intent) : null;
  if (pending) await created;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    targetActionApprovalReplay: createTargetActionApprovalDecision({ read, update }) });
  const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
    { surface: 'cli', authority: 'present_user', runtimeAccountId: 'owner' });
  if (custody === 'absent') {
    expect(stored, JSON.stringify(decided)).toMatchObject({ status: 'failed', execution: {
      ok: false, effectAttempted: false, errorCode: 'approval_origin_unavailable', details: { reason: 'live_invocation_unavailable' } } });
    expect(decided).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(await adapter(intent)).toMatchObject({ status: 'unavailable', code: 'approval_origin_unavailable' });
  } else {
    const admitted = await pending;
    expect(admitted).toMatchObject({ status: 'approved' });
    expect(stored).toMatchObject({ status: 'executing' });
    if (admitted?.status !== 'approved' || !admitted.settleExecution) throw new Error('Missing live execution receipt port');
    await admitted.settleExecution({ artifactId, execution: { ok: true, effectAttempted: true } });
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
  }
});


it('retains a contributed refusal cause and effect evidence through settlement and public receipt reads', async () => {
  const request = TargetActionApprovalRequestV1Schema.parse({
    v: 1, kind: 'plugin_target_action', status: 'executing', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.tunnel/actions/configure',
    input: {}, sourceCustody: { kind: 'development', registeredRootId: 'tunnel-root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Configure',
    decision: { kind: 'approve', decidedAtMs: 2 },
  });
  const failure = { ok: false as const, errorCode: 'credential_scope_denied', error: 'credential_scope_denied',
    effectAttempted: false, failureCause: { phase: 'execution_authorization', errorClass: 'RpcError',
      errorCode: 'credential_scope_denied', httpStatus: 403 } } as const;
  let stored = request;
  // Artifact persistence alone is substituted; settlement, strict receipt schemas,
  // public projection and the retained-result reader are the production owners.
  expect(await settleTargetActionExecution({ request, result: failure, operationCredentialUses: [], executedAtMs: 3,
    persist: async next => { stored = TargetActionApprovalRequestV1Schema.parse(next); return null; } }))
    .toMatchObject(failure);
  expect(stored).toMatchObject({ status: 'failed', execution: failure });
  expect(buildActionExecuteResultFromRecordedApprovalExecution(stored)).toMatchObject(failure);
  const publicRead = ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored));
  expect(publicRead.execution).toMatchObject(failure);
  expect(buildActionExecuteResultFromRecordedApprovalExecution(publicRead)).toMatchObject(failure);
});
