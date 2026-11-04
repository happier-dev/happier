import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { HostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';

type RetirementTarget = Readonly<{
  homeServerIdentityId: string; machineId: string; installationId: string; custodianAccountId: string;
}>;

/** Use this same input builder at observeExecution and at regrant supersession.
 * The Action store already owns its canonical input identity and controller.
 */
export function memberIdentityRetirementInput(target: RetirementTarget, accountId: string) {
  return { kind: 'memberIdentityRetirement', homeServerIdentityId: target.homeServerIdentityId,
    machineId: target.machineId, installationId: target.installationId, accountId };
}

/** Called by a new already admitted member use before observing/reusing native
 * readiness. It retires only earlier cleanup operations, never member work.
 */
export async function supersedeMemberIdentityRetirement(input: Readonly<{
  target: RetirementTarget; accountId: string; signal?: AbortSignal;
  /** Original host-admitted ingress invocation, never a later setup child. */
  admittedOperationId?: string;
  /** Saved Home profile held by that same operation runtime. */
  requesterServerId?: string;
  operations: Pick<HostActionOperationRuntime, 'store' | 'runner'>;
}>): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>> {
  if (input.signal?.aborted) return { kind: 'incomplete' };
  // A delayed phase of old admitted work must continue without pretending its
  // arrival at native preparation proves restored access. Missing proof skips
  // supersession; Home was already checked by the original ingress.
  if (!input.admittedOperationId || !input.requesterServerId) return { kind: 'settled' };
  const admitted = input.operations.store.get({ accountId: input.accountId, machineId: input.target.machineId }, input.admittedOperationId);
  const requester = input.operations.store.readRequesterWorkAttribution(input.admittedOperationId);
  if (!admitted || admitted.state !== 'accepted' && admitted.state !== 'running' || !requester
    || requester.serverId !== input.requesterServerId || requester.accountId !== input.accountId
    || requester.machineId !== input.target.machineId || requester.installationId !== input.target.installationId) return { kind: 'settled' };
  const scope = { accountId: input.target.custodianAccountId, machineId: input.target.machineId };
  const identity = createCanonicalJsonSigningInput(memberIdentityRetirementInput(input.target, input.accountId));
  // The existing store is host-local and its list is unpaged. Account scope is
  // the custodian who owns server-origin cleanup, not the newly admitted member.
  const matching = input.operations.store.list({ ...scope, states: ['accepted', 'running'] }).items.filter(operation =>
    operation.actionId === 'machines.agentIsolation.set'
      && input.operations.store.hasMatchingInputIdentity(operation.operationId, identity)
      && input.operations.store.wasInvocationAcceptedAfter(admitted.operationId, operation.operationId));
  for (const operation of matching) {
    if (input.signal?.aborted) return { kind: 'incomplete' };
    const cancelled = input.operations.runner.cancel(scope, operation.operationId);
    if (cancelled.kind !== 'requested' && cancelled.kind !== 'already_settled') return { kind: 'incomplete' };
  }
  for (const operation of matching) {
    try {
      const settled = await input.operations.runner.waitForTerminal(scope, operation.operationId, input.signal);
      // An uncertain retained native outcome is not physical settlement. Let
      // existing setup recovery decide it before any renewed native launch.
      if (!settled || !['succeeded', 'failed', 'cancelled'].includes(settled.state)) return { kind: 'incomplete' };
    } catch { return { kind: 'incomplete' }; }
  }
  return { kind: 'settled' };
}
