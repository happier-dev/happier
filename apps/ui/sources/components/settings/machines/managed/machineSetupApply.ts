import {
    MachineSetupPlanResultV1Schema,
    type MachineSetupAppChildV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { prepareMachineSetupSourcesApplyInput, type MachineSetupPreparedApply } from './machineSetupReview';

import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';

/** Explicit Apply/Retry prepares the exact target plan after replacing its saved source copy. */
export async function prepareMachineSetupPresetApplyInput(params: Readonly<{
    executeAction: ReturnType<typeof createDefaultActionExecutor>['execute'];
    context: ActionExecutorContext;
    homeId: string;
    machineId: string;
    preset: Pick<ManagedMachinePresetV1, 'id' | 'revision' | 'setup'>;
    appChildren?: MachineSetupAppChildV1[];
    removeItemKeys?: string[];
    selectedMachineId?: string;
    isCurrent: () => boolean;
}>): Promise<MachineSetupPreparedApply> {
    const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
    const setup = params.preset.setup;
    if (!setup) return fail('managed_response_invalid');
    const response = await params.executeAction('machines.setup.plan', {
        homeId: params.homeId, machineId: params.machineId,
    }, params.context);
    if (!current()) return fail('continuation_retired');
    if (!response.ok) return response;
    const outcome = classifyHomeActionOutcome(response);
    if (outcome.kind !== 'completed') return fail('approval_required');
    const parsed = MachineSetupPlanResultV1Schema.safeParse(outcome.result);
    if (!parsed.success) return fail('managed_response_invalid');
    const plan = parsed.data;
    let replaced = false;
    const sources = plan.sources.map(source => {
        if (source.kind !== 'accountPreset' || source.presetId !== params.preset.id) return source;
        replaced = true;
        return { ...source, presetRevision: params.preset.revision, setup };
    });
    if (!replaced) sources.splice(sources.findIndex(source => source.kind === 'direct'), 0, {
        kind: 'accountPreset', presetId: params.preset.id, presetRevision: params.preset.revision, setup,
    });
    const combinedRequested = params.appChildren !== undefined || params.selectedMachineId !== undefined;
    return prepareMachineSetupSourcesApplyInput({ executeAction: params.executeAction, context: params.context,
        homeId: params.homeId, machineId: params.machineId, selectedMachineId: params.selectedMachineId,
        combined: combinedRequested, isCurrent: current, targets: [{ homeId: params.homeId, machineId: params.machineId,
            sources, current: plan, desiredRevision: plan.desiredRevision,
            ...(params.removeItemKeys === undefined ? {} : { removeItemKeys: params.removeItemKeys }),
            ...(params.appChildren === undefined ? {} : { appChildren: params.appChildren }) }] });
}
