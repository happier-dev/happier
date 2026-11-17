import { MachineSetupCombinedPlanResultV1Schema, MachineSetupRemoveInputV1Schema, type MachineSetupCombinedPlanResultV1, type MachineSetupPlanUnavailableTargetV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { isMachineSetupRecipeItemV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { machineSetupItemKeyV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import type { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { prepareMachineSetupSourcesApplyInput, type MachineSetupPreparedApply, type MachineSetupPreparedRemove, type MachineSetupReviewTarget } from './machineSetupReview';

type SoftwarePlanReadParams = Readonly<{
    executeAction: ReturnType<typeof createDefaultActionExecutor>['execute']; context: ActionExecutorContext; homeId: string; machineId: string;
    targets: readonly Readonly<{ homeId: string; machineId: string }>[];
    selectedMachineId?: string; isCurrent: () => boolean;
}>;

/** Read and parse current sources once; an inline settings review can reuse this typed answer. */
export async function readMachineSetupSoftwareCurrentPlan(params: SoftwarePlanReadParams): Promise<
    Readonly<{ ok: true; plan: MachineSetupCombinedPlanResultV1 }> | ActionExecuteFailure
> {
    const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
    const result = await params.executeAction('machines.setup.plan', {
        homeId: params.homeId, machineId: params.machineId, targets: params.targets,
        ...(params.selectedMachineId === undefined ? {} : { selectedMachineId: params.selectedMachineId }),
    }, params.context);
    if (!current()) return fail('continuation_retired');
    if (!result.ok) return result;
    const outcome = classifyHomeActionOutcome(result);
    if (outcome.kind !== 'completed') return fail('approval_required');
    const parsed = MachineSetupCombinedPlanResultV1Schema.safeParse(outcome.result);
    if (!parsed.success || parsed.data.targets.length !== params.targets.length) return fail('managed_response_invalid');
    return { ok: true, plan: parsed.data };
}

/** Direct Software changes the implicit source; preset copies and literal scripts stay untouched. */
export async function prepareMachineSetupSoftwareApplyInput(params: SoftwarePlanReadParams & Readonly<{
    setup: MachineSetupV1; currentPlan?: MachineSetupCombinedPlanResultV1;
    intent?: 'install' | 'remove'; removeItemKeys?: Readonly<Record<string, string[]>>;
}>): Promise<MachineSetupPreparedApply> {
    const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
    const observed = params.currentPlan ? { ok: true as const, plan: params.currentPlan }
        : await readMachineSetupSoftwareCurrentPlan(params);
    if (!current()) return fail('continuation_retired');
    if (!observed.ok) return observed;
    const targets: MachineSetupReviewTarget[] = [];
    const unavailableTargets: MachineSetupPlanUnavailableTargetV1[] = [];
    const detaching = params.intent === 'remove';
    const detachedKeys = new Set(detaching ? (params.setup.items ?? []).filter(isMachineSetupRecipeItemV1).map(machineSetupItemKeyV1) : []);
    for (const target of params.targets) {
        const row = observed.plan.targets.find(row => row.homeId === target.homeId && row.machineId === target.machineId);
        if (!row) return fail('managed_response_invalid');
        if ('status' in row) { unavailableTargets.push(row); continue; }
        const plan = row.plan;
        // Preserve direct items shared with readable preset sources. Opaque source bodies are
        // retained and reviewed by the keyholding resolver after resolve.
        const attachedKeys = new Set(detaching ? plan.sources.flatMap(source =>
            source.kind === 'direct' || source.kind === 'accountPresetOpaque' ? []
                : (source.setup.items ?? []).filter(isMachineSetupRecipeItemV1).map(machineSetupItemKeyV1)) : []);
        const sources = plan.sources.map(source => {
            if (source.kind !== 'direct') return source;
            if (detaching) return { ...source, setup: { ...source.setup,
                items: (source.setup.items ?? []).filter(item => !isMachineSetupRecipeItemV1(item) || !detachedKeys.has(machineSetupItemKeyV1(item))
                    || attachedKeys.has(machineSetupItemKeyV1(item))) } };
            const items = [...source.setup.items ?? []];
            for (const item of params.setup.items ?? []) if (!items.some(existing => sameStrictJsonValue(existing, item))) items.push(item);
            return { ...source, setup: { ...source.setup,
                ...(params.setup.toolchain === undefined ? {} : { toolchain: params.setup.toolchain }),
                ...(params.setup.items === undefined ? {} : { items }) } };
        });
        targets.push({ ...target, sources, desiredRevision: plan.desiredRevision,
            ...(detaching ? { current: plan, removeItemKeys: params.removeItemKeys?.[target.machineId] ?? [] } : {}) });
    }
    return prepareMachineSetupSourcesApplyInput({ ...params, combined: true, targets, unavailableTargets });
}

/** Secondary Remove on one installed Software row: review first, with every removal initially unselected. */
export async function prepareMachineSetupSoftwareRemoveInput(params: Omit<Parameters<typeof prepareMachineSetupSoftwareApplyInput>[0],
    'intent' | 'targets' | 'selectedMachineId' | 'removeItemKeys'> & Readonly<{ removeItemKeys?: string[] }>): Promise<MachineSetupPreparedRemove> {
    const prepared = await prepareMachineSetupSoftwareApplyInput({ ...params, intent: 'remove',
        targets: [{ homeId: params.homeId, machineId: params.machineId }], selectedMachineId: params.machineId,
        removeItemKeys: { [params.machineId]: params.removeItemKeys ?? [] } });
    if (!prepared.ok) return prepared;
    const target = prepared.input.targets[0]!;
    return { ...prepared, input: MachineSetupRemoveInputV1Schema.parse({
        homeId: target.homeId, machineId: target.machineId, sources: target.sources,
        desiredRevision: target.desiredRevision, exclusions: target.exclusions,
        removeItemKeys: target.removeItemKeys, removalPlans: target.removalPlans,
    }) };
}

/** The row's reviewed confirmation uses the existing dangerous Action and its approval continuation. */
export function removeMachineSetupSoftware(params: Readonly<{
    executeAction: Pick<ReturnType<typeof createFrontDoorActionExecute>, 'confirmed'>;
    context: ActionExecutorContext; prepared: Extract<MachineSetupPreparedRemove, { ok: true }>;
}>): Promise<ActionExecuteResult> {
    return params.executeAction.confirmed('machines.setup.remove', params.prepared.input, params.context);
}
