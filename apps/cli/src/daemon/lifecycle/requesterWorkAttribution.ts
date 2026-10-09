import type { RpcHandlerContext } from '@/api/rpc/types';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
export { RequesterWorkAttributionV1Schema, RequesterWorkAttributionStoredReadV1Schema,
  type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';

/** C41 owns Machine permission. This only prevents borrowing a different Account's credentials. */
export async function canUseCustodianAccountForMachineRequest(context: Pick<RpcHandlerContext,
  'machineAdmission' | 'verifyMachineAdmissionCurrent'> & Readonly<{ signal?: AbortSignal }> | undefined): Promise<boolean> {
  if (!context?.machineAdmission) return !context?.signal?.aborted;
  const admission = context.machineAdmission;
  if (context.signal?.aborted || admission.actorAccountId !== admission.custodianAccountId
    || !context.verifyMachineAdmissionCurrent) return false;
  try { return await context.verifyMachineAdmissionCurrent() && !context.signal?.aborted; }
  catch { return false; }
}

/** Transient launch currentness supplied by the verified ingress, not by stored attribution. */
export async function isRequesterLaunchAdmissionCurrent(options: Pick<SpawnSessionOptions,
  'verifyRequesterMachineAdmissionCurrent'>): Promise<boolean> {
  if (!options.verifyRequesterMachineAdmissionCurrent) return true;
  try { return await options.verifyRequesterMachineAdmissionCurrent(); }
  catch { return false; }
}
