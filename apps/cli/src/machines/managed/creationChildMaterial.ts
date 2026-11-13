import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol';
import { managedChildRequiresRequesterMaterial } from '@/api/externalActionExecutionAuthorization';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { ManagedMachineControllerError } from './controllerErrors';

/**
 * Requester Account material for one signed creation child. The child dispatcher
 * decides when it is needed; another Account's controller never holds it.
 */
export async function resolveManagedCreationChildMaterial(authorization: ExternalActionExecutionAuthorizationV1,
    homeId: string, signal?: AbortSignal) {
    if (!managedChildRequiresRequesterMaterial(authorization.binding)) return undefined;
    const encryption = await readRequesterAccountActionContext(authorization)?.resolveEncryption(signal, authorization);
    if (encryption?.serverIdentityId !== homeId) throw new ManagedMachineControllerError('admission_unavailable');
    return encryption.material;
}
