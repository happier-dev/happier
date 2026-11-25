import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import type { RequesterAccountActionCustody } from '../sessionEncryption/requesterAccountActionProjection';
import type { PrepareAgentIsolationMember } from '../spawn/prepareDaemonConnectedServices';
import { readAgentIsolationNativeIdentity } from './agentIsolationNativeIdentity';
import { selectHostRequesterExecutionIdentity, assertHostRequesterExecutionAdmissionForHost, resolveHostRequesterAgentPlacementForHost, type HostAgentIsolationLaunchContext,
  type HostRequesterExecutionIdentity, type HostRequesterExecutionIdentityInput, isHostAgentIsolationPolicyUnread,
  refuseIsolationNotReady } from './agentIsolationLaunchPolicy';

/** No timer: the request's own cancellation bounds a wait on a readiness that may never come. */
function untilSettledOrAborted(readable: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { signal?.removeEventListener('abort', done); resolve(); };
    signal?.addEventListener('abort', done, { once: true });
    void readable.then(done, done);
  });
}

/** Both Machine work-kind and native Agent isolation read the same daemon binding. */
export async function readSettledMachineIsolationPolicy<T>(input: Readonly<{
  read(): T;
  isUnread(snapshot: T): boolean;
  awaitReadable?: HostAgentIsolationLaunchContext['awaitReadable'];
  signal?: AbortSignal;
}>): Promise<T> {
  const snapshot = input.read();
  if (!input.awaitReadable || !input.isUnread(snapshot) || input.signal?.aborted) return snapshot;
  await untilSettledOrAborted(input.awaitReadable(), input.signal);
  return input.signal?.aborted ? snapshot : input.read();
}

/** Private admitted sources remain distinct: current Account custody never
 * replaces an unavailable historical Session requester. */
export type SessionAgentIsolationAccountSource = Readonly<{
  origin: CurrentMachineExecutionOriginContext;
} & ({ kind: 'freshAccount'; hostAccountAgent: NonNullable<HostRequesterExecutionIdentityInput['hostAccountAgent']> }
  | { kind: 'ordinarySession'; custody: RequesterAccountActionCustody })>;

/** Session birth/recovery selects once; native preparation consumes that exact
 * requester through the existing Machine setup owner. */
export function createSessionAgentIsolationMemberPreparation(options: Readonly<{
  machineId: string;
  custodianAccountId?: string | null;
  agentIsolation?: HostAgentIsolationLaunchContext;
  resolveCurrentMachineExecutionOriginContext?(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
}>) {
  return (
    requester: Readonly<{ bootstrap: Pick<RequesterSessionRuntimeContext['bootstrap'], 'attribution' | 'homeServerIdentityId'> & Readonly<{
      savedSecretOperationContext: Pick<RequesterSessionRuntimeContext['bootstrap']['savedSecretOperationContext'], 'machineAdmission'>;
    }> }> | null | undefined,
    lifetimeSignal: AbortSignal,
    accountSourceInput?: SessionAgentIsolationAccountSource | ((signal: AbortSignal) => Promise<SessionAgentIsolationAccountSource | undefined>),
  ): PrepareAgentIsolationMember => async input => {
    const signal = input.signal ? AbortSignal.any([lifetimeSignal, input.signal]) : lifetimeSignal;
    signal.throwIfAborted();
    const birth = requester?.bootstrap;
    const awaitReadable = options.agentIsolation?.awaitReadable;
    const policy = await readSettledMachineIsolationPolicy({
      read: () => options.agentIsolation?.read(), isUnread: isHostAgentIsolationPolicyUnread, awaitReadable, signal,
    });
    if (awaitReadable && policy && isHostAgentIsolationPolicyUnread(policy))
      refuseIsolationNotReady(policy.status, 'agent_isolation_unavailable', 'exec');
    const isolationEnabled = policy?.enabled === true;
    let identity: HostRequesterExecutionIdentity;
    let homeServerIdentityId: string;
    if (!birth) {
      if (input.requesterWorkAttributionV1
        && input.requesterWorkAttributionV1.accountId !== options.custodianAccountId) {
        throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Retained Session requester is unavailable', retryable: false });
      }
      // Both native placements retain the admitted Account source. A missing
      // historical Session requester never becomes focused-Account authority.
      if (!isolationEnabled) return undefined;
      const accountSource = typeof accountSourceInput !== 'function' ? accountSourceInput
        : policy?.memberProvisioning === 'linuxUsersV1' ? await accountSourceInput(signal) : undefined;
      if (!accountSource || accountSource.origin.machineId !== options.machineId
        || !accountSource.origin.serverIdentityId) throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Ordinary Session requester custody is unavailable', retryable: false });
      homeServerIdentityId = accountSource.origin.serverIdentityId;
      if (accountSource.kind === 'freshAccount') {
        identity = selectHostRequesterExecutionIdentity({ hostAccountAgent: accountSource.hostAccountAgent,
          hostHomeServerIdentityId: homeServerIdentityId });
        if (accountSource.hostAccountAgent.custodianAccountId !== options.custodianAccountId)
          identity = { kind: 'unknown', reason: 'requester_authority_unavailable' } as const;
      } else {
        const custody = accountSource.custody;
        if (!custody.getBoundSessionId?.() || input.requesterWorkAttributionV1
          && !isDeepStrictEqual(input.requesterWorkAttributionV1, custody.attribution)) {
          throw new PluginError({ code: 'agent_isolation_unavailable',
            message: 'Ordinary Session requester custody changed', retryable: false });
        }
        identity = selectHostRequesterExecutionIdentity({ sessionRequester: custody.attribution,
          sessionRequesterHomeServerIdentityId: homeServerIdentityId,
          hostHomeServerIdentityId: homeServerIdentityId, sessionCustodianAccountId: options.custodianAccountId });
      }
      if (identity.kind !== 'isolated' || identity.separationRequired
        || identity.requester.accountId !== options.custodianAccountId
        || identity.requester.machineId !== options.machineId
        || accountSource.kind === 'freshAccount' && input.requesterWorkAttributionV1
          && !isDeepStrictEqual(input.requesterWorkAttributionV1, identity.requester)) {
        throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Ordinary Session requester custody is unavailable', retryable: false });
      }
    } else {
      if (input.requesterWorkAttributionV1
        && !isDeepStrictEqual(input.requesterWorkAttributionV1, birth.attribution)) {
        throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Retained Session requester changed', retryable: false });
      }
      if (!birth.homeServerIdentityId) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Retained Session Home is unavailable', retryable: false });
      homeServerIdentityId = birth.homeServerIdentityId;
      const origin = await options.resolveCurrentMachineExecutionOriginContext?.(signal);
      identity = selectHostRequesterExecutionIdentity({ sessionRequester: birth.attribution,
        sessionRequesterHomeServerIdentityId: homeServerIdentityId,
        hostHomeServerIdentityId: origin?.machineId === options.machineId ? origin.serverIdentityId : null,
        sessionCustodianAccountId: options.custodianAccountId });
    }
    if (identity.kind !== 'isolated') throw new PluginError({ code: 'agent_isolation_unavailable',
      message: 'Retained Session requester is unavailable', retryable: false });
    const placement = resolveHostRequesterAgentPlacementForHost({ identity, snapshot: policy });
    if (placement === 'daemon') return undefined;
    const requesterIdentity = { ...identity, homeServerIdentityId };
    if (placement === 'sharedAgent') {
      await options.agentIsolation?.qualifyNativeReadiness?.({ requesterIdentity: identity, signal });
      const snapshot = options.agentIsolation?.read();
      assertHostRequesterExecutionAdmissionForHost({ identity, snapshot, agentLaunchKind: 'exec' });
      return { kind: 'sharedAgent', requesterIdentity, snapshot,
        identity: await readAgentIsolationNativeIdentity(signal) };
    }
    if (!options.agentIsolation?.prepareMember) throw new PluginError({ code: 'agent_isolation_unavailable',
      message: 'Requester native setup is unavailable', retryable: false });
    const native = await options.agentIsolation.prepareMember({
      requesterIdentity, signal, requesterMachineRole: birth?.savedSecretOperationContext.machineAdmission?.role,
    });
    return { kind: 'member', requesterIdentity, snapshot: policy, identity: native.identity, daemonObservation: native.daemonObservation };
  };
}
