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
      ok: false, effectAttempted: false, errorCode: 'approval_stale', details: { reason: 'live_invocation_unavailable' } } });
    expect(decided).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(await adapter(intent)).toMatchObject({ status: 'unavailable', code: 'approval_stale' });
  } else {
    const admitted = await pending;
    expect(admitted).toMatchObject({ status: 'approved' });
    expect(stored).toMatchObject({ status: 'executing' });
    if (admitted?.status !== 'approved' || !admitted.settleExecution) throw new Error('Missing live execution receipt port');
    await admitted.settleExecution({ artifactId, execution: { ok: true, effectAttempted: true } });
    expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
  }
});
