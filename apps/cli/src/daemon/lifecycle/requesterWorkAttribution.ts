import type { RpcHandlerContext, RpcLocalActionContext } from '@/api/rpc/types';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { rethrowRequesterHomeReadFailure } from '../sessionEncryption/requesterCurrentness';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
export { RequesterWorkAttributionV1Schema, RequesterWorkAttributionStoredReadV1Schema,
  type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';

/** Carry already-admitted requester facts into host-owned work, never public RPC input. */
export function projectRpcRequesterWorkAttribution(context: Readonly<Partial<Pick<RpcHandlerContext,
  'signal' | 'machineAdmission' | 'callerInputAuthorization' | 'localActionContext' | 'requesterSessionBootstrap'>> & {
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    authenticatedLocalRootCustody?: RpcLocalActionContext['authenticatedLocalRootCustody'];
  }> | undefined, serverId?: string): RequesterWorkAttributionV1 | undefined {
  const admission = context?.machineAdmission;
  const binding = context?.callerInputAuthorization?.binding;
  const localRoot = context?.authenticatedLocalRootCustody ?? context?.localActionContext?.authenticatedLocalRootCustody;
  // The authenticated Machine stamp wins over any in-process inherited context.
  const candidate = admission ? { serverId, accountId: admission.actorAccountId,
    machineId: admission.machineId, installationId: admission.installationId }
    : binding ? { serverId: serverId ?? binding.serverIdentityId, accountId: binding.accountId,
      machineId: binding.machineId, installationId: binding.installationId }
    : localRoot ? { serverId: serverId ?? localRoot.serverIdentityId, accountId: localRoot.accountId,
      machineId: localRoot.machineId, installationId: localRoot.installationId }
    : context?.requesterWorkAttributionV1 ?? context?.localActionContext?.requesterWorkAttributionV1
      ?? context?.requesterSessionBootstrap?.attribution;
  const parsed = RequesterWorkAttributionV1Schema.safeParse(candidate);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

/** Principal equality only; the caller must still verify the admission's currentness. */
export function isCustodianMachineAdmission(admission: Pick<NonNullable<RpcHandlerContext['machineAdmission']>,
  'actorAccountId' | 'custodianAccountId'>): boolean {
  return admission.actorAccountId === admission.custodianAccountId;
}

/** C41 owns Machine permission. This only prevents borrowing a different Account's credentials. */
export async function canUseCustodianAccountForMachineRequest(context: Pick<RpcHandlerContext,
  'machineAdmission' | 'verifyMachineAdmissionCurrent'> & Readonly<{ signal?: AbortSignal }> | undefined): Promise<boolean> {
  if (!context?.machineAdmission) return !context?.signal?.aborted;
  const admission = context.machineAdmission;
  if (context.signal?.aborted || !isCustodianMachineAdmission(admission)
    || !context.verifyMachineAdmissionCurrent) return false;
  try { return await context.verifyMachineAdmissionCurrent() && !context.signal?.aborted; }
  catch { return false; }
}

/** Transient launch currentness supplied by the verified ingress, not by stored attribution. */
export async function isRequesterLaunchAdmissionCurrent(options: Pick<SpawnSessionOptions,
  'verifyRequesterMachineAdmissionCurrent'>): Promise<boolean> {
  if (!options.verifyRequesterMachineAdmissionCurrent) return true;
  try { return await options.verifyRequesterMachineAdmissionCurrent(); }
  catch (error) {
    rethrowRequesterHomeReadFailure(error);
    return false;
  }
}

/** One spawn-result projection for every fresh requester admission checkpoint. */
export async function resolveRequesterLaunchAdmissionFailure(options: Pick<SpawnSessionOptions,
  'verifyRequesterMachineAdmissionCurrent'>): Promise<Extract<SpawnSessionResult, { type: 'error' }> | null> {
  const refusal = { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Requester Machine admission unavailable' } as const;
  try { return await isRequesterLaunchAdmissionCurrent(options) ? null : refusal; }
  catch (error) {
    if (!isPluginError(error) || error.code !== 'project_requester_home_unavailable' || error.retryable !== true) return refusal;
    return { ...refusal, errorMessage: 'Requester Home is temporarily unavailable',
      errorDetail: { kind: 'requester_home_unavailable' } };
  }
}
