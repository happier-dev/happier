import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PET_IMPORT_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import { PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol/pets/daemonRpc';
import { prepareMachinePetImportV1 } from '@happier-dev/protocol/pets/importActionV1';
import type { CliMachineActionCall } from './machineTransport';

/** Headless Agent approvals obtain the same daemon preview as interactive imports. */
export function createCliPetImportPrepare(callMachineAction: CliMachineActionCall): NonNullable<ActionExecutorDeps['preparePetImport']> {
    return async ({ input, context }) => {
        return prepareMachinePetImportV1(input, (machineId, request) => callMachineAction({
            machineId, method: PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE,
            request, context, signal: context.signal, effectActionId: PET_IMPORT_ACTION_ID_V1,
        }));
    };
}
