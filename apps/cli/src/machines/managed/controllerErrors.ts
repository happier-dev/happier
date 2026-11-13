export { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeEffectGuardRefusal,
    ManagedMachineNativeObservationFailure, ManagedRetentionWaitSuperseded, readManagedNativeFailureDetails,
} from '@happier-dev/cli-common/machines/managed';

import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';

/** These acknowledgements cannot establish rollback; explicit refusals can. */
export function isUncertainManagedControllerRequest(error: unknown): error is ManagedMachineControllerError {
    if (!(error instanceof ManagedMachineControllerError)) return false;
    const details = error.details;
    return details?.kind === 'managedControllerRequest' && (details.category === 'transport' || details.category === 'schema'
        || details.category === 'status' && (details.status ?? 0) >= 500
            && error.code !== 'database_transaction_conflict_exhausted');
}
