import { MANAGED_EXEC_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ManagedMachineActionOutputSchemasV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { prepareManagedMachineWakeChildren, type ManagedWakePreparationReads } from '@happier-dev/cli-common/machines/managed';
import { readCliManagedProvisioners } from '@/machines/managed/provisionerAdmission';
import { openManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { executeCliManagedMachineRuntimeDemand, readCliManagedMachineTarget, type CliManagedMachineRuntimeAccount } from './managedMachineRuntime';

/** Existing captured Session and Account transports supply facts; the shared owner alone selects wake work. */
export function prepareCliManagedMachineWake(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    params: Readonly<{
        localMachineId?: string;
        reviewManagedExecForRemoteDispatch?: true;
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
        readManagedMachine: async (input, context, runtime) => {
            if (!params.managedMachineAction) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            const result = await params.managedMachineAction({ actionId: 'machines.managed.get', input, context, signal: context.signal });
            const failure = ActionExecuteFailureSchema.safeParse(result);
            if (failure.success) return failure.data;
            const parsed = ManagedMachineActionOutputSchemasV1['machines.managed.get'].safeParse(result);
            if (!parsed.success) return { ok: false, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' };
            if (runtime === 'native') return unwrapManagedMachineReadV1(parsed.data);
            if (!params.provisionerAccount.credentials) {
                return { ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
            }
            try {
                return await openManagedMachineRead({ credentials: params.provisionerAccount.credentials,
                    serverHttpBaseUrl: params.provisionerAccount.serverUrl, read: parsed.data,
                    ...(context.signal ? { signal: context.signal } : {}) });
            } catch {
                context.signal?.throwIfAborted();
                return { ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
            }
        },
    };
    const reviewOnly = request.actionId === MANAGED_EXEC_ACTION_ID_V1 && params.reviewManagedExecForRemoteDispatch;
    return prepareManagedMachineWakeChildren(request, reads, reviewOnly ? undefined
        : execution => executeCliManagedMachineRuntimeDemand(execution, params.provisionerAccount, reads));
}
