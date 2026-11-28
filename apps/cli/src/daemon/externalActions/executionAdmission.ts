import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { ActionOperationRpcContext } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import type { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isOriginalOwnAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

export function requiresPortableSessionSpawnServerIdentity(actionId: string, input: unknown): boolean {
  if (actionId === 'session.spawn_new' || actionId === 'approval.request.decide') return true;
  if (actionId !== 'approval.request.create' || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  return (input as Readonly<Record<string, unknown>>).actionId === 'session.spawn_new';
}

export function createRequesterAccountOperationContext(input: Readonly<{
  machineId: string; custodianAccountId: string | null;
  installationIdentity: ReturnType<typeof readInstallationIdentityIfExistsSync>;
}>) {
  return (apiMachine: ApiMachineClient, requester: Pick<RequesterAccountActionContext, 'authorization' | 'isCurrent'>,
    signal?: AbortSignal): ActionOperationRpcContext => {
    if (!input.installationIdentity || !input.custodianAccountId) {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    }
    // Resource mode belongs to the installed controller, not the requester.
    const ownCustodian = isOriginalOwnAccountActionCustody(requester.authorization.binding)
      && requester.authorization.binding.custodianAccountId === input.custodianAccountId;
    const role = requester.authorization.binding.admittedMachineRole ?? (ownCustodian ? 'manage' : undefined);
    // The receipt names the deciding fact: no Home-admitted role and not original own custody.
    if (!role) throw createActionExecuteFailureError({
      ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable', effectAttempted: false,
      failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'admission_unavailable', httpStatus: null,
        nativeErrorReason: 'admitted_machine_role' },
    });
    return {
      machineAdmission: {
        actorAccountId: requester.authorization.binding.accountId,
        custodianAccountId: input.custodianAccountId,
        machineId: input.machineId,
        installationId: input.installationIdentity.installationId,
        role,
        encryptionMode: apiMachine.getMachineEncryptionMode(),
      },
      verifyMachineAdmissionCurrent: requester.isCurrent,
      ...(signal ? { signal } : {}),
    };
  };
}
