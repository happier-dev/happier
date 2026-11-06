import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { readCliManagedProvisioners } from '@/machines/managed/provisionerAdmission';
import { executeCliManagedMachineRuntimeDemand, readCliManagedMachineTarget, type CliManagedMachineRuntimeAccount } from './managedMachineRuntime';

/** Existing captured Session and Account transports supply facts; the shared owner alone selects wake work. */
export function prepareCliManagedMachineWake(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    params: Readonly<{
        localMachineId?: string;
        provisionerAccount: CliManagedMachineRuntimeAccount;
        readSessionMachineId: ManagedWakePreparationReads['readSessionMachineId'];
        managedMachineAction: ActionExecutorDeps['managedMachineAction'];
    }>,
) {
    const reads: ManagedWakePreparationReads = {
        localMachineId: params.localMachineId,
        readSelectedProvisioners: pluginId => readCliManagedProvisioners(pluginId, params.provisionerAccount, request.context.signal),
        readSessionMachineId: params.readSessionMachineId,
        readMachineTarget: (machineId, context) => readCliManagedMachineTarget(machineId, context, params.provisionerAccount),
        readManagedMachine: async (input, context) => {
            if (!params.managedMachineAction) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            const result = await params.managedMachineAction({ actionId: 'machines.managed.get', input, context, signal: context.signal });
            const failure = ActionExecuteFailureSchema.safeParse(result);
            if (failure.success) return failure.data;
            return ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(result);
        },
    };
    return prepareManagedMachineWakeChildren(request, reads,
        execution => executeCliManagedMachineRuntimeDemand(execution, params.provisionerAccount, reads));
}
