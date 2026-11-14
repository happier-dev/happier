import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { ManagedControllerContextOutputV1Schema,
    type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiManagedAccountHomeRequest, normalizeUiManagedAccountMachine, type UiManagedAccountMachineNormalizer } from './managedMachineAccountHome';

/** Retained creation follows up through the invoking Account's existing child executor. */
export async function completeUiManagedAccountGuest(params: Readonly<{
    account: LazyActionAccountContext;
    context: ActionExecutorContext;
    input: ManagedAcquireInputV1;
    machine: ManagedMachineFullV1;
    requestId: string;
    signal?: AbortSignal;
    normalizer?: UiManagedAccountMachineNormalizer;
}>): Promise<ManagedMachineFullV1> {
    if (!params.input.agentStart) return params.machine;
    const post = createUiManagedAccountHomeRequest(params);
    const retained = await post('context', {
        homeId: params.machine.homeId, managedId: params.machine.id,
        expectedIntentRevision: params.machine.intentRevision, requestId: params.requestId,
    }, ManagedControllerContextOutputV1Schema);
    const machine = normalizeUiManagedAccountMachine(params.normalizer, retained.machine);
    const port = params.context.hostReviewedChild;
    if (!machine.enrolledMachineId || !port) throw new ManagedMachineControllerError('enrollment_retired');
    params.signal?.throwIfAborted();
    const result = await port.invoke({ action: 'session.spawn_new', role: 'session.spawn_new',
        input: projectNativeJsonValueForTransport({ ...params.input.agentStart,
            executionTarget: { serverId: params.context.serverId ?? machine.homeId, machineId: machine.enrolledMachineId },
            managedCreation: { homeId: machine.homeId, managedId: machine.id,
                ...(machine.controller ? { controller: machine.controller } : {}) },
        }), invocationServices: { managedMachine: machine, managedContinuation: {
            managedId: machine.id, creationRequestId: retained.requestId, expectedIntentRevision: machine.intentRevision,
        } } });
    if (!result.ok) throw new ManagedMachineControllerError(result.errorCode);
    const spawn = SessionSpawnNewActionResultV1Schema.safeParse(result.result);
    if (!spawn.success) throw new ManagedMachineControllerError('invalid_action_output');
    if (spawn.data.type === 'error') throw new ManagedMachineControllerError(spawn.data.code);
    if (spawn.data.type === 'pending') {
        params.context.operationOwnerUpdate?.update({ observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } });
    } else params.context.operationOwnerUpdate?.update({ observation: null });
    return machine;
}
