import {
    machineSetupSourceApplyOriginKeyV1, MachineSetupPlanResultV1Schema,
    type MachineSetupAppChildV1, type MachineSetupSourceApplyV1, type MachineSetupSourceApplyEntryV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { mergeMachineSetupsV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
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

/** Attaching a selected source replaces its own copy, as preset Use does, and retains every other origin. */
function attachMachineSetupSource(sources: MachineSetupSourceApplyV1, proposed: MachineSetupSourceApplyEntryV1): MachineSetupSourceApplyV1 {
    const origin = machineSetupSourceApplyOriginKeyV1(proposed);
    const index = sources.findIndex(source => machineSetupSourceApplyOriginKeyV1(source) === origin);
    if (index >= 0) return sources.map((source, sourceIndex) => sourceIndex === index ? proposed : source);
    const attached = [...sources];
    attached.splice(attached.findIndex(source => source.kind === 'direct'), 0, proposed);
    return attached;
}

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
    const sources = attachMachineSetupSource(plan.sources, proposed);
    const combinedRequested = params.appChildren !== undefined || params.selectedMachineId !== undefined;
    return prepareMachineSetupSourcesApplyInput({ executeAction: params.executeAction, context: params.context,
        homeId: params.homeId, machineId: params.machineId, selectedMachineId: params.selectedMachineId,
        combined: combinedRequested, isCurrent: current, targets: [{ homeId: params.homeId, machineId: params.machineId,
            sources, current: plan, desiredRevision: plan.desiredRevision,
            ...(params.removeItemKeys === undefined ? {} : { removeItemKeys: params.removeItemKeys }),
            ...(params.appChildren === undefined ? {} : { appChildren: params.appChildren }) }] });
}

/** Prerequisite recipes join the Machine's existing sources in the same reviewed effects Plan. */
export async function prepareMachineSetupSourcesAdditionApplyInput(params: Omit<Parameters<typeof prepareMachineSetupPresetApplyInput>[0], 'preset'> & Readonly<{
    sources: MachineSetupSourceApplyV1;
}>): Promise<MachineSetupPreparedApply> {
    const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
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
    let sources = plan.sources;
    for (const addition of params.sources) {
        if (addition.kind !== 'direct') {
            sources = attachMachineSetupSource(sources, addition);
            continue;
        }
        const direct = sources.find(source => source.kind === 'direct')!;
        if (sameStrictJsonValue(direct.setup, addition.setup)) continue;
        const merged = mergeMachineSetupsV1([direct.setup, addition.setup]);
        if (!merged.ok) return merged;
        sources = attachMachineSetupSource(sources, { kind: 'direct', setup: merged.setup });
    }
    return prepareMachineSetupSourcesApplyInput({ executeAction: params.executeAction, context: params.context,
        homeId: params.homeId, machineId: params.machineId, selectedMachineId: params.selectedMachineId,
        combined: params.appChildren !== undefined || params.selectedMachineId !== undefined, isCurrent: current,
        targets: [{ homeId: params.homeId, machineId: params.machineId, sources, current: plan, desiredRevision: plan.desiredRevision,
            ...(params.removeItemKeys === undefined ? {} : { removeItemKeys: params.removeItemKeys }),
            ...(params.appChildren === undefined ? {} : { appChildren: params.appChildren }) }] });
}
