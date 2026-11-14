import {
    machineSetupSourceApplyOriginKeyV1, MachineSetupPlanResultV1Schema,
    type MachineSetupAppChildV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { prepareMachineSetupSourcesApplyInput, type MachineSetupPreparedApply } from './machineSetupReview';
import { reviewMachineSetupRecipeInputs } from './MachineSetupRecipeInputs';
import { machineSetupPresetApplySource, type MachineSetupPresetInput } from './machineSetupPresetChoices';

import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { createMachinePresetCollectionClient } from '@/sync/ops/machines/machinePresetCollectionClient';

export type { MachineSetupPresetInput } from './machineSetupPresetChoices';

/** Explicit Apply/Retry prepares the exact target plan after replacing its saved source copy. */
export async function prepareMachineSetupPresetApplyInput(params: Readonly<{
    executeAction: ReturnType<typeof createDefaultActionExecutor>['execute'];
    context: ActionExecutorContext;
    homeId: string;
    machineId: string;
    preset: MachineSetupPresetInput;
    appChildren?: MachineSetupAppChildV1[];
    removeItemKeys?: string[];
    selectedMachineId?: string;
    isCurrent: () => boolean;
}>): Promise<MachineSetupPreparedApply | null> {
    const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
    if (!params.preset.setup) return fail('managed_response_invalid');
    const setup = await reviewMachineSetupRecipeInputs({ setup: params.preset.setup,
        context: params.context, isCurrent: current });
    if (!setup) return null;
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
    let presetContentOverride;
    if (!('kind' in params.preset) && !sameStrictJsonValue(params.preset.setup, setup)) {
        const { serverId, expectedAccountId } = params.context;
        if (typeof serverId !== 'string' || typeof expectedAccountId !== 'string' || !params.preset.recipientProjection) return fail('content_unavailable');
        const override = await createMachinePresetCollectionClient({ serverId, accountId: expectedAccountId }, params.homeId)
            .prepareSetupOverride({ ...params.preset, recipientProjection: params.preset.recipientProjection }, setup, params.context.signal);
        if (!current()) return fail('continuation_retired');
        if (override.kind === 'failed') return fail(override.code);
        presetContentOverride = override.kind === 'ready' ? override.override : undefined;
    }
    const proposed = machineSetupPresetApplySource({ ...params.preset, setup }, presetContentOverride);
    const origin = machineSetupSourceApplyOriginKeyV1(proposed);
    let replaced = false;
    const sources = plan.sources.map(source => {
        if (machineSetupSourceApplyOriginKeyV1(source) !== origin) return source;
        replaced = true;
        return proposed;
    });
    if (!replaced) sources.splice(sources.findIndex(source => source.kind === 'direct'), 0, proposed);
    const combinedRequested = params.appChildren !== undefined || params.selectedMachineId !== undefined;
    return prepareMachineSetupSourcesApplyInput({ executeAction: params.executeAction, context: params.context,
        homeId: params.homeId, machineId: params.machineId, selectedMachineId: params.selectedMachineId,
        combined: combinedRequested, isCurrent: current, targets: [{ homeId: params.homeId, machineId: params.machineId,
            sources, current: plan, desiredRevision: plan.desiredRevision,
            ...(params.removeItemKeys === undefined ? {} : { removeItemKeys: params.removeItemKeys }),
            ...(params.appChildren === undefined ? {} : { appChildren: params.appChildren }) }] });
}
