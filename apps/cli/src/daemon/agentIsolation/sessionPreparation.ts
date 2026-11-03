import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import type { RequesterAccountActionCustody } from '../sessionEncryption/requesterAccountActionProjection';
import type { PrepareAgentIsolationMember } from '../spawn/prepareDaemonConnectedServices';
import { selectHostRequesterExecutionIdentity, resolveHostRequesterAgentPlacementForHost, type HostAgentIsolationLaunchContext,
  type HostRequesterExecutionIdentity, type HostRequesterExecutionIdentityInput } from './agentIsolationLaunchPolicy';

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
    requester: Pick<RequesterSessionRuntimeContext, 'bootstrap'> | null | undefined,
    lifetimeSignal: AbortSignal,
    accountSource?: SessionAgentIsolationAccountSource,
  ): PrepareAgentIsolationMember => async input => {
    const signal = input.signal ? AbortSignal.any([lifetimeSignal, input.signal]) : lifetimeSignal;
    signal.throwIfAborted();
    const birth = requester?.bootstrap;
    const policy = options.agentIsolation?.read();
    const reviewedMembers = policy?.enabled && policy.memberProvisioning === 'linuxUsersV1';
    let identity: HostRequesterExecutionIdentity;
    let homeServerIdentityId: string;
    if (!birth) {
      if (input.requesterWorkAttributionV1
        && input.requesterWorkAttributionV1.accountId !== options.custodianAccountId) {
        throw new PluginError({ code: 'agent_isolation_unavailable',
          message: 'Retained Session requester is unavailable', retryable: false });
      }
      // Preserve the named legacy owner transition. Reviewed member creation
      // instead requires an admitted fresh source or exact ordinary custody;
      // a null historical recovery is never current-Account authority.
      if (!reviewedMembers) return undefined;
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
    if (resolveHostRequesterAgentPlacementForHost({ identity, snapshot: policy }) !== 'member') return undefined;
    if (!options.agentIsolation?.prepareMember) throw new PluginError({ code: 'agent_isolation_unavailable',
      message: 'Requester native setup is unavailable', retryable: false });
    return (await options.agentIsolation.prepareMember({
      requesterIdentity: { ...identity, homeServerIdentityId }, signal,
    })).identity;
  };
}
