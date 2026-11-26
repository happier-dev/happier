import { machineSetupApplyTargetFromPlanV1, MachineSetupPlanResultV1Schema, MachineSetupCombinedPlanResultV1Schema, MachineSetupApplyInputV1Schema,
    type MachineSetupAppChildV1, type MachineSetupApplyInputV1, type MachineSetupCombinedPlanResultV1,
    type MachineSetupPlanResultV1, type MachineSetupPlanInputV1, type MachineSetupPlanUnavailableTargetV1, type MachineSetupSourceApplyV1,
    type MachineSetupPlanReviewV1, type MachineSetupRemoveInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { type MachineSetupSourceV1, reviewMachineSetupSourceChangeV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupReviewedStepV1 } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import {
    openManagedMachineSetupPlanSourcesV1,
    type ManagedMachineSetupSourcePresentationV1,
} from '@/sync/ops/machines/managedMachinePresetCustody';

export type MachineSetupReviewTarget = Readonly<{
    homeId: string; machineId: string; desiredRevision: number; sources: MachineSetupSourceApplyV1; appChildren?: MachineSetupAppChildV1[];
    preset?: MachineSetupApplyInputV1['targets'][number]['preset'];
    removeItemKeys?: string[];
    candidatePreset?: MachineSetupPlanInputV1['candidatePreset'];
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
/** One script the Plan runs: its exact body when this viewer opened the copy, otherwise its native step label. */
export type MachineSetupReviewScript = Readonly<{ body: string }> | Readonly<{ label: MachineSetupReviewedStepV1['label'] }>;
export type MachineSetupTargetSourcePresentations = Readonly<{
    homeId: string;
    machineId: string;
    sources: readonly ManagedMachineSetupSourcePresentationV1[];
    /** Exactly the scripts Apply runs on this target, in run order. */
    scripts?: readonly MachineSetupReviewScript[];
}>;
export type MachineSetupPreparedApply = Readonly<{
    ok: true; input: MachineSetupApplyInputV1; review?: MachineSetupCombinedPlanResultV1['review'];
    facts: readonly MachineSetupTargetReviewFacts[];
    /** Native Plan dispositions retained in the same review, never executable or queued targets. */
    unavailableTargets?: readonly MachineSetupPlanUnavailableTargetV1[];
    /** Exact locally opened Plan copies for presentation only; Action input remains opaque. */
    sourcePresentations?: readonly MachineSetupTargetSourcePresentations[];
}> | ActionExecuteFailure;

/** The same review facts, with only the exact native removal continuation executable. */
export type MachineSetupPreparedRemove = (Omit<Extract<MachineSetupPreparedApply, { ok: true }>, 'input'> & Readonly<{
    input: MachineSetupRemoveInputV1;
}>) | ActionExecuteFailure;

/** The Plan facts that address every script its Apply runs. */
export type MachineSetupPlanScriptReviewFacts = Readonly<{
    steps?: readonly MachineSetupReviewedStepV1[];
    presetUpdateEffects?: MachineSetupPlanReviewV1['presetUpdateEffects'];
}>;

/**
 * The one Review projection of the scripts a Plan runs, over this viewer's opened copies, in run order. Opened
 * copies keep only their running scripts; a copy this viewer cannot open is named by its native step label, never
 * treated as empty. A Plan without addresses is reviewable only when every copy is opened: all their scripts show.
 */
export function reviewMachineSetupPlanScripts(review: MachineSetupPlanScriptReviewFacts | undefined,
    presentations: readonly ManagedMachineSetupSourcePresentationV1[], requireAddresses: boolean,
): Readonly<{ ok: true; presentations: readonly ManagedMachineSetupSourcePresentationV1[]; scripts?: readonly MachineSetupReviewScript[] }>
    | ActionExecuteFailure {
    const fail = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const effects = review?.presetUpdateEffects;
    if (!effects) return requireAddresses || presentations.some(entry => entry.kind !== 'opened')
        ? fail('plan_changed') : { ok: true, presentations };
    const steps = effects.scripts.length ? review?.steps?.slice(-effects.scripts.length) ?? [] : [];
    const indicesBySource = new Map<number, Set<number>>();
    const scripts: MachineSetupReviewScript[] = [];
    for (const [index, { sourceIndex, scriptIndex }] of effects.scripts.entries()) {
        const presentation = presentations[sourceIndex];
        const body = presentation?.kind === 'opened' ? presentation.source.setup.scripts?.[scriptIndex]?.body : undefined;
        if (presentation?.kind === 'opened' && !body) return fail('managed_response_invalid');
        if (body) {
            const indices = indicesBySource.get(sourceIndex) ?? new Set<number>();
            indices.add(scriptIndex);
            indicesBySource.set(sourceIndex, indices);
            scripts.push({ body });
            continue;
        }
        const step = steps.length === effects.scripts.length ? steps[index] : undefined;
        if (!step) return fail('managed_response_invalid');
        scripts.push({ label: step.label });
    }
    if (effects.toolchain && !presentations.some(entry => entry.kind === 'opened' && entry.source.setup.toolchain))
        return fail('managed_response_invalid');
    return { ok: true, scripts, presentations: presentations.map((entry, sourceIndex) => {
        if (entry.kind !== 'opened') return entry;
        const { scripts: sourceScripts, toolchain, ...setup } = entry.source.setup;
        const indices = indicesBySource.get(sourceIndex);
        return { ...entry, source: { ...entry.source, setup: { ...setup,
            ...(effects.toolchain && toolchain ? { toolchain } : {}),
            ...(indices && sourceScripts ? { scripts: sourceScripts.filter((_script, scriptIndex) => indices.has(scriptIndex)) } : {}),
        } } };
    }) };
}

/** Open this viewer's copies of a Plan, then review exactly the scripts it runs: the one path every Setup review uses. */
export async function openMachineSetupPlanScriptReview(params: Readonly<{
    serverId?: string; accountId?: string; signal?: AbortSignal; requireAddresses: boolean;
    plan: Pick<MachineSetupPlanResultV1, 'sources' | 'resolvedSources'> & Readonly<{ review?: MachineSetupPlanScriptReviewFacts }>;
}>): Promise<ReturnType<typeof reviewMachineSetupPlanScripts>> {
    const presentations = await openManagedMachineSetupPlanSourcesV1({
        ...(params.serverId === undefined ? {} : { serverId: params.serverId }),
        ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
        plan: params.plan, ...(params.signal ? { signal: params.signal } : {}),
    });
    return reviewMachineSetupPlanScripts(params.plan.review, presentations, params.requireAddresses);
}

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
    const targets = params.targets.map(target => ({ homeId: target.homeId, machineId: target.machineId,
        ...(target.candidatePreset ? { candidatePreset: target.candidatePreset } : { sources: target.sources }),
        mode: 'effects' as const, ...(target.appChildren === undefined ? {} : { appChildren: target.appChildren }),
        ...(target.removeItemKeys === undefined ? {} : { removeItemKeys: target.removeItemKeys }) }));
    const expectedSources: Array<MachineSetupSourceApplyV1 | MachineSetupSourceV1> = [];
    for (const target of params.targets) {
        const currentSources = target.current?.sources;
        const proposedSources = target.sources;
        // Public direct/bundled sources retain the existing native-retention projection. An opaque
        // preset stays exact here; its keyholding host owns reviewing its private source body.
        if (currentSources?.every(source => source.kind !== 'accountPresetOpaque')
            && proposedSources.every(source => source.kind !== 'accountPresetOpaque')) {
            const change = reviewMachineSetupSourceChangeV1({ currentSources,
                currentSourceFacts: target.current?.sourceFacts, proposedSources, removeItemKeys: target.removeItemKeys });
            if (!change.ok) return change;
            expectedSources.push(change.sources);
        } else expectedSources.push(proposedSources);
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
    const sourcePresentations: MachineSetupTargetSourcePresentations[] = [];
    const unavailableTargets = [...params.unavailableTargets ?? []];
    for (const [index, expected] of params.targets.entries()) {
        const row = combined?.success ? combined.data.targets.find(target => target.homeId === expected.homeId && target.machineId === expected.machineId) : undefined;
        if (row && 'status' in row) { unavailableTargets.push(row); continue; }
        const target = row && 'plan' in row ? row : undefined;
        if (params.combined && !target) return fail('managed_response_invalid');
        const effects = MachineSetupPlanResultV1Schema.safeParse(target ? target.plan : outcome.result);
        if (!effects.success || effects.data.recipePlans === undefined) return fail('managed_response_invalid');
        // Older combined results can carry the operands on the target wrapper.
        const plan = effects.data.appChildren === undefined && target?.appChildren !== undefined
            ? { ...effects.data, appChildren: target.appChildren } : effects.data;
        if (expected.appChildren !== undefined && plan.appChildren === undefined) return fail('managed_response_invalid');
        if (effects.data.desiredRevision !== expected.desiredRevision
            || !sameStrictJsonValue(plan.candidatePreset, expected.candidatePreset)
            || expected.candidatePreset === undefined && !sameStrictJsonValue(plan.sources, expectedSources[index])) return fail('plan_changed');
        if (!sameStrictJsonValue(effects.data.removeItemKeys, expected.removeItemKeys)) return fail('plan_changed');
        if (expected.removeItemKeys !== undefined && effects.data.removalPlans === undefined) return fail('managed_response_invalid');
        const scriptReview = await openMachineSetupPlanScriptReview({
            ...(typeof params.context.serverId === 'string' ? { serverId: params.context.serverId } : {}),
            ...(typeof params.context.expectedAccountId === 'string' ? { accountId: params.context.expectedAccountId } : {}),
            plan, requireAddresses: expected.candidatePreset !== undefined,
            ...(params.context.signal ? { signal: params.context.signal } : {}),
        });
        if (!current()) return fail('continuation_retired');
        if (!scriptReview.ok) return scriptReview;
        const presentations = scriptReview.presentations;
        const reviewedScripts = scriptReview.scripts;
        admitted.push({ ...machineSetupApplyTargetFromPlanV1(expected, plan),
            ...(expected.preset ? { preset: expected.preset } : {}) });
        facts.push({ homeId: expected.homeId, machineId: expected.machineId, support: effects.data.support,
            ...(effects.data.review === undefined ? {} : { review: effects.data.review }),
            ...(effects.data.sourceFacts === undefined ? {} : { sourceFacts: effects.data.sourceFacts }),
            ...(effects.data.recipeTitles === undefined ? {} : { recipeTitles: effects.data.recipeTitles }),
            ...(effects.data.removalOffers === undefined ? {} : { removalOffers: effects.data.removalOffers }) });
        sourcePresentations.push({ homeId: expected.homeId, machineId: expected.machineId, sources: presentations, ...(reviewedScripts ? { scripts: reviewedScripts } : {}) });
    }
    if (!admitted.length) return { ok: false, errorCode: 'machine_offline', error: 'machine_offline', details: { targets: unavailableTargets } };
    if (combined?.success && combined.data.review.machineId === null) return fail('machine_unavailable');
    return { ok: true, ...(combined?.success ? { review: combined.data.review } : {}), facts,
        ...(sourcePresentations.length ? { sourcePresentations } : {}),
        ...(unavailableTargets.length ? { unavailableTargets } : {}), input: MachineSetupApplyInputV1Schema.parse({
        homeId: params.homeId, machineId: combined?.success ? combined.data.review.machineId : params.machineId, targets: admitted,
    }) };
}
