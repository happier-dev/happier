import { MachineSetupPlanResultV1Schema, MachineSetupCombinedPlanResultV1Schema, MachineSetupApplyInputV1Schema,
    type MachineSetupAppChildV1, type MachineSetupApplyInputV1, type MachineSetupCombinedPlanResultV1,
    type MachineSetupPlanResultV1, type MachineSetupPlanUnavailableTargetV1,
    type MachineSetupRemoveInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { reviewMachineSetupSourceChangeV1, type MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';

export type MachineSetupReviewTarget = Readonly<{
    homeId: string; machineId: string; desiredRevision: number; sources: MachineSetupSourceV1; appChildren?: MachineSetupAppChildV1[];
    removeItemKeys?: string[];
    /** Snapshot read before proposing a source change; native retention normalizes the expected response. */
    current?: Pick<MachineSetupPlanResultV1, 'sources' | 'sourceFacts'>;
}>;
/**
 * What each target's Plan reported for the review: native-item support, items left out of its sources, the apps it
 * already accepted and, when known, administrator/downtime/host/apps.
 */
export type MachineSetupTargetReviewFacts = Readonly<{
    homeId: string; machineId: string; support: MachineSetupPlanResultV1['support']; review?: MachineSetupPlanResultV1['review'];
    sourceFacts?: MachineSetupPlanResultV1['sourceFacts']; removalOffers?: MachineSetupPlanResultV1['removalOffers'];
    recipeTitles?: MachineSetupPlanResultV1['recipeTitles'];
}>;
export type MachineSetupPreparedApply = Readonly<{
    ok: true; input: MachineSetupApplyInputV1; review?: MachineSetupCombinedPlanResultV1['review'];
    facts: readonly MachineSetupTargetReviewFacts[];
    /** Native Plan dispositions retained in the same review, never executable or queued targets. */
    unavailableTargets?: readonly MachineSetupPlanUnavailableTargetV1[];
}> | ActionExecuteFailure;

/** The same review facts, with only the exact native removal continuation executable. */
export type MachineSetupPreparedRemove = (Omit<Extract<MachineSetupPreparedApply, { ok: true }>, 'input'> & Readonly<{
    input: MachineSetupRemoveInputV1;
}>) | ActionExecuteFailure;

/** One effects-Plan/result admission for preset Use and direct Software, before any Apply. */
export async function prepareMachineSetupSourcesApplyInput(params: Readonly<{
    executeAction: ReturnType<typeof createDefaultActionExecutor>['execute']; context: ActionExecutorContext; homeId: string; machineId: string;
    targets: readonly MachineSetupReviewTarget[]; selectedMachineId?: string; combined: boolean; isCurrent: () => boolean;
    unavailableTargets?: readonly MachineSetupPlanUnavailableTargetV1[];
}>): Promise<MachineSetupPreparedApply> {
    const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const current = () => params.isCurrent() && !params.context.signal?.aborted;
    if (!current()) return fail('continuation_retired');
    if (!params.targets.length) return params.unavailableTargets?.length ? {
        ok: false, errorCode: 'machine_offline', error: 'machine_offline', details: { targets: params.unavailableTargets },
    } : fail('invalid_parameters');
    const targets = params.targets.map(target => ({ homeId: target.homeId, machineId: target.machineId, sources: target.sources,
        mode: 'effects' as const, ...(target.appChildren === undefined ? {} : { appChildren: target.appChildren }),
        ...(target.removeItemKeys === undefined ? {} : { removeItemKeys: target.removeItemKeys }) }));
    const expectedSources: MachineSetupSourceV1[] = [];
    for (const target of params.targets) {
        if (!target.current) { expectedSources.push(target.sources); continue; }
        const change = reviewMachineSetupSourceChangeV1({ currentSources: target.current.sources,
            currentSourceFacts: target.current.sourceFacts, proposedSources: target.sources, removeItemKeys: target.removeItemKeys });
        if (!change.ok) return change;
        expectedSources.push(change.sources);
    }
    const response = await params.executeAction('machines.setup.plan', params.combined ? {
        homeId: params.homeId, machineId: params.machineId, targets,
        ...(params.selectedMachineId === undefined ? {} : { selectedMachineId: params.selectedMachineId }),
    } : targets[0], params.context);
    if (!current()) return fail('continuation_retired');
    if (!response.ok) return response;
    const outcome = classifyHomeActionOutcome(response);
    if (outcome.kind !== 'completed') return fail('approval_required');
    const combined = params.combined ? MachineSetupCombinedPlanResultV1Schema.safeParse(outcome.result) : undefined;
    if (combined && (!combined.success || combined.data.targets.length !== targets.length)) return fail('managed_response_invalid');
    const admitted = [];
    const facts: MachineSetupTargetReviewFacts[] = [];
    const unavailableTargets = [...params.unavailableTargets ?? []];
    for (const [index, expected] of params.targets.entries()) {
        const row = combined?.success ? combined.data.targets.find(target => target.homeId === expected.homeId && target.machineId === expected.machineId) : undefined;
        if (row && 'status' in row) { unavailableTargets.push(row); continue; }
        const target = row && 'plan' in row ? row : undefined;
        if (params.combined && (!target || expected.appChildren !== undefined && target.appChildren === undefined)) return fail('managed_response_invalid');
        const effects = MachineSetupPlanResultV1Schema.safeParse(target ? target.plan : outcome.result);
        if (!effects.success || effects.data.recipePlans === undefined) return fail('managed_response_invalid');
        if (effects.data.desiredRevision !== expected.desiredRevision || !sameStrictJsonValue(effects.data.sources, expectedSources[index])) return fail('plan_changed');
        if (!sameStrictJsonValue(effects.data.removeItemKeys, expected.removeItemKeys)) return fail('plan_changed');
        if (expected.removeItemKeys !== undefined && effects.data.removalPlans === undefined) return fail('managed_response_invalid');
        admitted.push({ homeId: expected.homeId, machineId: expected.machineId, sources: effects.data.sources,
            desiredRevision: effects.data.desiredRevision, recipePlans: effects.data.recipePlans, exclusions: effects.data.exclusions,
            ...(effects.data.removeItemKeys === undefined ? {} : { removeItemKeys: effects.data.removeItemKeys }),
            ...(effects.data.removalPlans === undefined ? {} : { removalPlans: effects.data.removalPlans }),
            ...(target?.appChildren === undefined ? {} : { appChildren: target.appChildren }) });
        facts.push({ homeId: expected.homeId, machineId: expected.machineId, support: effects.data.support,
            ...(effects.data.review === undefined ? {} : { review: effects.data.review }),
            ...(effects.data.sourceFacts === undefined ? {} : { sourceFacts: effects.data.sourceFacts }),
            ...(effects.data.recipeTitles === undefined ? {} : { recipeTitles: effects.data.recipeTitles }),
            ...(effects.data.removalOffers === undefined ? {} : { removalOffers: effects.data.removalOffers }) });
    }
    if (!admitted.length) return { ok: false, errorCode: 'machine_offline', error: 'machine_offline', details: { targets: unavailableTargets } };
    if (combined?.success && combined.data.review.machineId === null) return fail('machine_unavailable');
    return { ok: true, ...(combined?.success ? { review: combined.data.review } : {}), facts,
        ...(unavailableTargets.length ? { unavailableTargets } : {}), input: MachineSetupApplyInputV1Schema.parse({
        homeId: params.homeId, machineId: combined?.success ? combined.data.review.machineId : params.machineId, targets: admitted,
    }) };
}
