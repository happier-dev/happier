import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';

/** Receiving admission validates the already addressed Machine; it never selects or reranks. */
export async function assertProjectReceivingPlacement(input: Readonly<{
    choice: ProjectExecutionChoiceV1;
    sourceMachineId: string;
    receivingMachineId: string;
    readPool?: (poolId: string) => Promise<ActionExecuteResult>;
}>): Promise<void> {
    const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    if (input.choice.kind === 'primary') {
        if (input.sourceMachineId !== input.receivingMachineId) fail('target_not_local');
        return;
    }
    const destination = input.choice.destination;
    if (destination.kind === 'machine') {
        if (destination.machineId !== input.receivingMachineId) fail('target_not_local');
        return;
    }
    if (destination.selection === 'ask') fail('choice_required');
    if (!input.readPool) return fail('preferences_unavailable');
    const result = await input.readPool(destination.poolId);
    if (!result.ok) return fail(result.errorCode);
    const view = MachinePoolViewV1Schema.safeParse(result.result);
    if (!view.success) return fail('preferences_unavailable');
    if (view.data.pool.id !== destination.poolId || !view.data.pool.members.some(member =>
        member.machineId === input.receivingMachineId && member.enabled && member.state === 'connected')) fail('target_not_local');
}
