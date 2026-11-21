import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';

/** Projects present the same typed failure whether target preparation or an open holder channel failed. */
export function readManagedWorkspaceFailureCode(error: unknown): string | undefined {
    return error instanceof ManagedMachineControllerError ? error.code : readRpcErrorCode(error);
}
