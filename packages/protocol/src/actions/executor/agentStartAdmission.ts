import * as z from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from './actionStartDiagnostics.js';
export { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from './actionStartDiagnostics.js';
export type { ActionStartDiagnosticV1, ActionStartPhaseV1 } from './actionStartDiagnostics.js';
import { admitAgentStartV1, AgentStartSessionCallerV1Schema, type AgentStartFactsV1, type AgentStartContextV1, type AgentStartRequestV1, type Unresolved } from '../../account/settings/admitAgentStartV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { BackendTargetKeyV2InputSchema, PersistedBackendTargetRefV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { normalizeConnectedServiceSelectionInput } from '../../connect/normalizeConnectedServiceSelectionInput.js';
import { AgentStartBaselineSelectionErrorV1, resolveAgentStartBaselineSelectionV1 } from './agentStartBaselineSelectionV1.js';
export { resolveAgentStartBaselineSelectionV1 } from './agentStartBaselineSelectionV1.js';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '../../providers/selection/v1.js';
import { parseAgentPermissionIntentV1Alias } from '../../runtime/permissionIntentV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../../sessions/metadata/metadataOverridesV1.js';
import { SessionSpawnNewInputV2BaseSchema, SessionSpawnNewInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { readActionCallerLedSubtreeSessionIds } from './sessionLedSubtree.js';
import { findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases } from '../sessionSpawnConfigOptions.js';
import { SpawnConfigOptionValueSchema } from '../sessionSpawnConfigOptions.js';
import { resolveExecutionBackendTargetSelectionForValue } from '../resolveActionBackendTargetSelection.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../../teams/credentials/resourceV1.js';
import { ExecutionRunIntentSchema } from '../../execution/runs/runPrimitives.js';
import { projectExecutionRunChildChoiceV1, withExecutionRunStartFailureDetails } from '../../execution/runs/responseSchemas.js';
import { resolveWorkflowStepSelectionV1, type WorkflowResolvedStepSelectionV1 } from '../../workflows/workflowStepSelectionV1.js';
import { readRoleEngineModelRefV1, type RoleEngineV1 } from '../../prompts/roles/roleArtifactV1.js';
import { parseQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { ManagedAcquireAgentStartV1Schema } from '../../machines/managed/agentStartV1.js';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1, parseProfileActionRequestV1 } from '../../profiles/profileActionsV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema, SessionSkillSelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { actionInputIssueFailure } from './actionInputValidation.js';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '../../bots/templates/botTemplateActionIdsV1.js';

/** Native Workflow leaves already admitted by materialization retain that host-stamped depth. */
export function readAdmittedWorkflowLeafStartDepthV1(actionId: string, context: ActionExecutorContext): number | undefined {
    return (actionId === 'execution.run.start' || actionId === 'session.spawn_new')
        && context.actionCaller?.kind === 'workflowRun'
        && context.executionRunWorkflowRunId === context.actionCaller.runId
        ? context.agentStartWorkDepth : undefined;
}

/** Only fresh Session creation admits a Profile; resume keeps its stored session selection. */
export async function resolveProfileSkillSeedsAtAdmissionV1(input: Readonly<Record<string, unknown>>,
    deps: Pick<ActionExecutorDeps, 'profileActionExecute'>, context: ActionExecutorContext,
): Promise<Readonly<{ ok: true; input: Readonly<Record<string, unknown>> }> | ActionExecuteFailure> {
    if (typeof input.profileId !== 'string') return { ok: true, input };
    if (!deps.profileActionExecute) {
        return actionStartTargetUnavailableV1(context, 'agent_start_context', 'profile_unavailable');
    }
    const response = await deps.profileActionExecute(parseProfileActionRequestV1('launch_profiles.read', { id: input.profileId }), context);
    if (!response.ok) return response;
    const read = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.read'].safeParse(response.result);
    if (!read.success || read.data.status !== 'present') {
        return actionStartTargetUnavailableV1(context, 'agent_start_context', 'profile_unavailable');
    }
    const seeds = read.data.profile.skillSeeds ?? [];
    if (seeds.length === 0) return { ok: true, input };
    const selection = SessionCapabilitySelectionAuthoringV1Schema.parse(input.capabilitySelection ?? {});
    const skills = SessionSkillSelectionAuthoringV1Schema.parse(selection.skills ?? {});
    const excluded = new Set(skills.forceExcludeSkillIds);
    return { ok: true, input: { ...input, capabilitySelection: { ...selection, skills: { ...skills,
        forceIncludeSkillIds: [...new Set([...skills.forceIncludeSkillIds, ...seeds.filter(id => !excluded.has(id))])],
    } } } };
}
/** Authenticated Session identity itself proves its own-target relation. */
export function isActionCallerOwnSessionV1(context: ActionExecutorContext | undefined, sessionId: unknown): boolean {
    return context?.actionCaller?.kind === 'session' && context.actionCaller.sessionId === sessionId;
}
const unresolved = { kind: 'unresolved' } as const;
const RunStartConfigOptionsSchema = z.record(z.string(), SpawnConfigOptionValueSchema);
// Admission needs authoritative selection facts, not a dynamically bound task
// body. The native Session owner still validates the complete effective input.
const spawnPolicyFields = lazyZodSchema(() => z.object(z.pick(SessionSpawnNewInputV2BaseSchema, {
    executionTarget: true, directory: true, agentTarget: true, roleId: true,
    modelSelection: true, permissionMode: true, agentModeId: true, configuration: true,
    profileId: true, environmentVariables: true, connectedServices: true, capabilitySelection: true, transcriptStorage: true,
}).shape));
type SpawnStartFactsInput = {
    [Key in keyof z.infer<typeof spawnPolicyFields>]?: z.infer<typeof spawnPolicyFields>[Key] | Unresolved;
};
function isUnresolvedStartFact(value: unknown): value is Unresolved {
    return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'unresolved';
}
export function isAgentStartActionV1(actionId: string): boolean {
    return actionId === 'session.spawn_new' || actionId === 'execution.run.start'
        || actionId === 'review.start' || actionId === 'subagents.plan.start'
        || actionId === 'subagents.delegate.start' || actionId === 'voice_agent.start';
}
/** Acquisition admits Agent work only when it carries ordinary Session authoring. */
export function isAgentStartActionInvocationV1(actionId: string, input: Readonly<Record<string, unknown>>): boolean {
    return isAgentStartActionV1(actionId)
        || (actionId === 'session.goal.set' && typeof input.objective === 'string' && input.resumeInactiveWithInitialGoal !== false)
        || (actionId === 'machines.managed.acquire' && input.agentStart !== undefined);
}
/** Action policies that may admit new Agent work, unlike observation and own-Session controls. */
export function requiresActionAgentStartDepthV1(actionId: string): boolean {
    return isAgentStartActionV1(actionId) || actionId === BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
        || actionId === 'workflow.run.start' || actionId === 'workflow.trigger.run_now'
        || actionId === 'workflow.definition.create' || actionId === 'workflow.definition.update'
        || actionId === 'workflow.definition.edit'
        || actionId === 'workflow.trigger.add' || actionId === 'workflow.trigger.update'
        || actionId === 'session.trigger.add' || actionId === 'session.trigger.update';
}
/** Native target input supplied by Workflow Agent selection. */
export function readActionWorkflowTargetInputFieldV1(actionId: string): 'agentTarget' | 'backendTarget' | 'engineIds' | 'backendTargetKeys' | null {
    if (!isAgentStartActionV1(actionId)) return null;
    return actionId === 'session.spawn_new' ? 'agentTarget'
        : actionId === 'execution.run.start' ? 'backendTarget'
            : actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys';
}
/** Workflow selection fields shared by static validation and native admission. */
export function projectActionWorkflowSelectionInputV1(
    actionId: string,
    input: Readonly<Record<string, unknown>>,
    selected: WorkflowResolvedStepSelectionV1 | undefined,
): Record<string, unknown> {
    const projected = { ...input };
    if (!selected || !isAgentStartActionV1(actionId)) return projected;
    const targetField = readActionWorkflowTargetInputFieldV1(actionId);
    if (selected.agentTarget && targetField) {
        if (projected[targetField] === undefined) projected[targetField] = targetField === 'agentTarget' || targetField === 'backendTarget'
            ? selected.agentTarget : [buildBackendTargetKeyV2(selected.agentTarget)];
    }
    for (const key of ['permissionMode', 'allowedTools', 'unlistedTools', 'connectedServices', 'capabilitySelection', 'transcriptStorage'] as const) {
        if (projected[key] === undefined && selected[key] !== undefined) projected[key] = selected[key];
    }
    const profileField = actionId === 'session.spawn_new' ? 'profileId' : 'launchProfileId';
    if (projected[profileField] === undefined && selected.profileId !== undefined
        && (actionId === 'session.spawn_new' || selected.profileId !== null))
        projected[profileField] = selected.profileId;
    if (projected.agentModeId === undefined && projected.acpSessionModeId === undefined && selected.acpSessionModeId !== undefined)
        projected.agentModeId = selected.acpSessionModeId;
    if (projected.modelSelection === undefined && projected.modelId === undefined && projected.teamCredentialModel === undefined
        && selected.modelSelection !== undefined) {
        projected.modelSelection = actionId === 'session.spawn_new' || selected.modelSelection === null
            ? selected.modelSelection : selected.modelSelection.ref;
    }
    if (actionId !== 'session.spawn_new' && projected.sessionConfigOptionOverrides === undefined && projected.configOptions === undefined
        && selected.sessionConfigOptionOverrides !== undefined) projected.sessionConfigOptionOverrides = selected.sessionConfigOptionOverrides;
    return projected;
}
export function resolveRunStartModelAndConfig(data: Readonly<Record<string, unknown>>) {
    const modelId = typeof data.modelId === 'string' ? data.modelId.trim() : undefined;
    const canonical = AcpConfigOptionOverridesV1Schema.safeParse(data.sessionConfigOptionOverrides);
    const canonicalOverrides = canonical.success ? canonical.data : undefined;
    const shorthand = RunStartConfigOptionsSchema.safeParse(data.configOptions);
    const configOptions = shorthand.success ? shorthand.data : undefined;
    const conflicts = findSpawnConfigOptionAliasConflicts({ sessionConfigOptionOverrides: canonicalOverrides, configOptions });
    if (conflicts.length > 0) {
        return { ok: false as const, error: actionInputIssueFailure(...conflicts.map(conflict => ({
            code: 'conflicting_selection', path: ['configOptions', conflict.id],
        }))) };
    }
    const merged = mergeSpawnConfigOptionAliases({
        ...(canonicalOverrides ? { sessionConfigOptionOverrides: canonicalOverrides } : {}),
        ...(configOptions ? { configOptions } : {}),
    });
    return { ok: true as const, options: {
            ...(modelId ? { modelId } : {}), ...(merged ? { sessionConfigOptionOverrides: merged } : {}),
        } };
}
/** The same selected Action facts are admitted before a Workflow row and at native dispatch. */
export function resolveActionAgentStartRequestsV1(params: Readonly<{
    actionId: string;
    input: Readonly<Record<string, unknown>>;
    context: ActionExecutorContext;
    baseline: AgentStartContextV1['baseline'];
    effectiveSelection?: Readonly<{
        selection: WorkflowResolvedStepSelectionV1;
        overrideEngine?: boolean;
    }>;
}>): Readonly<{
    ok: true;
    requests: readonly AgentStartRequestV1[];
    effectiveInput: Readonly<Record<string, unknown>>;
}> | Readonly<{
    ok: false;
    errorCode: 'target_unavailable' | 'invalid_parameters';
    details?: ActionExecuteFailure['details'];
    knownFacts?: AgentStartFactsV1;
    /** Concrete fan-out members still need Workflow admission while another member is deferred. */
    knownRequests?: readonly AgentStartRequestV1[];
}> {
    const { actionId, input: request, context, baseline } = params;
    if (actionId === 'session.goal.set' || actionId === 'session.goal.clear') {
        return { ok: true, effectiveInput: request,
            requests: [{ kind: 'session_target', targetSessionId: String(request.sessionId) }] };
    }
    if (actionId === 'machines.managed.acquire' && request.agentStart !== undefined) {
        const continuation = ManagedAcquireAgentStartV1Schema.safeParse(request.agentStart);
        if (!continuation.success) return { ok: false, errorCode: 'invalid_parameters' };
        return { ok: true, effectiveInput: request, requests: [{
            kind: 'spawn_new',
            facts: { ...spawnStartFactsV1(continuation.data), machineId: { kind: 'new_machine' } },
            ...(continuation.data.roleId ? { roleId: continuation.data.roleId } : {}),
        }] };
    }
    const selected = params.effectiveSelection?.selection;
    const overrideEngine = params.effectiveSelection?.overrideEngine === true;
    let inheritWorkflowModel = true;
    const selectedModelForTarget = (target: AgentStartFactsV1['agentTarget']) => {
        const model = selected?.modelSelection;
        if (model === undefined || model === null)
            return model;
        if (!target || target.kind === 'unresolved')
            return undefined;
        let modelTarget: PersistedBackendTargetRefV2 | null;
        try {
            modelTarget = parseBackendTargetKeyV2(model.ref.agentTargetKey);
        }
        catch {
            const identity = parseQualifiedPluginContributionKey(model.ref.agentTargetKey);
            modelTarget = identity ? { kind: 'agent', identity } : null;
        }
        return modelTarget && buildBackendTargetKeyV2(modelTarget) === buildBackendTargetKeyV2(target) ? model.ref : undefined;
    };
    const selectedFacts = (facts: AgentStartFactsV1): AgentStartFactsV1 => {
        if (!selected)
            return facts;
        const target = overrideEngine ? selected.agentTarget ?? unresolved : facts.agentTarget ?? selected.agentTarget ?? undefined;
        const options = target?.kind === 'agent'
            ? resolveWorkflowStepSelectionV1({ defaults: selected, step: { agentTarget: target }, purpose: 'authoring' })
                .selection.sessionConfigOptionOverrides : selected.sessionConfigOptionOverrides;
        const selectedModel = inheritWorkflowModel ? selectedModelForTarget(target) : undefined;
        return {
            ...facts,
            agentTarget: target,
            modelSelection: overrideEngine ? selectedModel : facts.modelSelection === undefined ? selectedModel : facts.modelSelection,
            permissionMode: facts.permissionMode ?? selection(SessionSpawnNewInputV2Schema.shape.permissionMode._zod.def.innerType, selected.permissionMode),
            agentModeId: facts.agentModeId === undefined ? selected.acpSessionModeId : facts.agentModeId,
            configOptions: facts.configOptions === undefined ? options === null ? null : options ? Object.fromEntries(Object.entries(options.overrides)
                .map(([name, option]) => [name, { value: option.value, updatedAtMs: option.updatedAt }])) : undefined : facts.configOptions,
            profileId: actionId !== 'session.spawn_new' && selected.profileId !== undefined ? selected.profileId
                : facts.profileId === undefined ? selected.profileId : facts.profileId,
            connectedServices: facts.connectedServices === undefined ? selected.connectedServices : facts.connectedServices,
            capabilitySelection: facts.capabilitySelection === undefined ? selected.capabilitySelection : facts.capabilitySelection,
            transcriptStorage: facts.transcriptStorage ?? selection(SessionSpawnNewInputV2Schema.shape.transcriptStorage._zod.def.innerType, selected.transcriptStorage),
        };
    };
    if (!isAgentStartActionV1(actionId))
        return { ok: true, requests: [], effectiveInput: request };
    let selectedInput = projectActionWorkflowSelectionInputV1(actionId, request, selected);
    const projectSelectedEngine = (input: Readonly<Record<string, unknown>>, kind: 'spawn_new' | 'execution_run') => {
        if (!overrideEngine || !selected?.agentTarget)
            return input;
        const effort = selected.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value;
        const projected = projectAgentStartSelectionV1(input, { engine: { agentTargetKey: buildBackendTargetKeyV2(selected.agentTarget),
                ...(selected.modelSelection ? { modelId: selected.modelSelection.ref.modelId } : {}), ...(typeof effort === 'string' ? { effort } : {}) },
            ...(kind === 'spawn_new' && selected.profileId ? { profileId: selected.profileId } : {}),
        }, kind, baseline, selected.modelSelection?.ref);
        // A native Execution Action profile is plugin-owned execution policy, not
        // the portable Launch Profile used to materialize Workflow Agent settings.
        return kind === 'spawn_new' ? projected : { ...projected,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
            ...(input.profileSourceCustody === undefined ? {} : { profileSourceCustody: input.profileSourceCustody }),
        };
    };
    if (actionId === 'session.spawn_new') {
        const target = overrideEngine ? selected?.agentTarget : readAgentStartTargetV1(request.agentTarget) ?? selected?.agentTarget;
        if (!overrideEngine && request.modelSelection === undefined && selected?.modelSelection !== undefined
            && selectedModelForTarget(target ?? undefined) === undefined)
            delete selectedInput.modelSelection;
        const effectiveInput = projectSelectedEngine({ ...selectedInput,
            ...(selected?.agentTarget && (overrideEngine || request.agentTarget === undefined) ? { agentTarget: selected.agentTarget } : {}),
        }, 'spawn_new');
        const spawn = spawnPolicyFields.safeParse(effectiveInput);
        if (spawn.success)
            return { ok: true, effectiveInput,
                requests: [{ kind: 'spawn_new', facts: selectedFacts(spawnStartFactsV1(spawn.data)), roleId: spawn.data.roleId }] };
        const deferred: Partial<Record<keyof typeof spawnPolicyFields.shape, true>> = {};
        for (const key of z.keyof(spawnPolicyFields).options) {
            if (isUnresolvedStartFact(effectiveInput[key]))
                deferred[key] = true;
        }
        if (Object.keys(deferred).length > 0) {
            // Validate all known required fields with the same native schema. Only
            // actual deferred values are omitted, then retained as unresolved facts.
            const known = z.omit(spawnPolicyFields, deferred).safeParse(effectiveInput);
            if (known.success) {
                const partial: SpawnStartFactsInput = { ...known.data };
                for (const key of z.keyof(spawnPolicyFields).options)
                    if (deferred[key])
                        partial[key] = unresolved;
                // An unresolved Role can change the eventual effective Agent Engine.
                if (deferred.roleId)
                    partial.agentTarget = unresolved;
                return { ok: true, effectiveInput, requests: [{ kind: 'spawn_new',
                            facts: selectedFacts(spawnStartFactsV1(partial)), ...(typeof partial.roleId === 'string' ? { roleId: partial.roleId } : {}),
                        }] };
            }
        }
        return { ok: false, errorCode: 'invalid_parameters' };
    }
    const targetValues = actionId === 'review.start' ? request.engineIds : request.backendTargetKeys;
    const projectedTargetValues = actionId === 'review.start' ? selectedInput.engineIds : selectedInput.backendTargetKeys;
    let targets = actionId === 'execution.run.start' ? [readAgentStartTargetV1(selectedInput.backendTarget)]
        : (Array.isArray(projectedTargetValues) ? projectedTargetValues : []).map((value) => {
            if (typeof value !== 'string')
                return null;
            const canonical = BackendTargetKeyV2InputSchema.safeParse(value);
            const key = canonical.success ? canonical.data
                : resolveExecutionBackendTargetSelectionForValue(value)?.backendTargetKey;
            return key ? parseBackendTargetKeyV2(key) : null;
        });
    if (overrideEngine && selected?.agentTarget)
        targets = (targets.length ? targets : [selected.agentTarget]).map(() => selected.agentTarget!);
    const runOptions = resolveRunStartModelAndConfig(request);
    const teamModel = TeamCredentialProviderModelSelectionV1Schema.safeParse(request.teamCredentialModel);
    const startInput = { ...request, ...(runOptions.ok ? runOptions.options : {}),
        ...(teamModel.success ? { modelId: teamModel.data.modelId } : {}) };
    if (targets.length === 0)
        return { ok: false, errorCode: 'target_unavailable',
            knownFacts: selectedFacts(executionRunStartFactsV1(startInput, unresolved, context, baseline)),
        };
    inheritWorkflowModel = targets.every((target) => !target || selected?.modelSelection === undefined || selectedModelForTarget(target) !== undefined);
    if (selected) {
        // The Workflow selection owner drops inherited model/effort when any concrete engine replaces it.
        const compatible = targets.reduce((selection, target) => target?.kind === 'agent'
            ? resolveWorkflowStepSelectionV1({ defaults: selection, step: { agentTarget: target }, purpose: 'authoring' }).selection
            : selection, selected);
        selectedInput = projectActionWorkflowSelectionInputV1(actionId, request, compatible);
    }
    if (!inheritWorkflowModel && request.modelSelection === undefined && request.modelId === undefined && request.teamCredentialModel === undefined)
        delete selectedInput.modelSelection;
    const perTargetConnectedServices = request.connectedServicesByBackendTargetKey;
    const intent = actionId === 'execution.run.start' ? ExecutionRunIntentSchema.safeParse(request.intent) : null;
    const requests: AgentStartRequestV1[] = [];
    for (const [index, target] of targets.entries()) {
        if (!target)
            continue;
        const key = Array.isArray(targetValues) ? targetValues[index] : undefined;
        const connected = typeof key === 'string' && perTargetConnectedServices && typeof perTargetConnectedServices === 'object'
            && !Array.isArray(perTargetConnectedServices) ? Reflect.get(perTargetConnectedServices, key) : undefined;
        const effective = { ...startInput,
            ...(connected !== undefined ? { connectedServices: connected } : {}),
        };
        requests.push({ kind: 'execution_run',
            source: actionId === 'review.start' ? 'review' : actionId === 'subagents.plan.start' ? 'subagents_plan'
                : actionId === 'subagents.delegate.start' ? 'subagents_delegate' : actionId === 'voice_agent.start' ? 'voice_agent' : 'execution_run',
            intent: intent?.success ? intent.data : actionId === 'review.start' ? 'review'
                : actionId === 'subagents.plan.start' ? 'plan' : actionId === 'subagents.delegate.start' ? 'delegate' : 'voice_agent',
            ...(typeof request.roleId === 'string' ? { roleId: request.roleId } : {}),
            facts: selectedFacts(executionRunStartFactsV1(effective, target, context, baseline)), backendTargets: [target],
        });
    }
    if (targets.some((target) => !target))
        return { ok: false, errorCode: 'target_unavailable', knownRequests: requests,
            knownFacts: selectedFacts(executionRunStartFactsV1(startInput, unresolved, context, baseline)),
        };
    if (!runOptions.ok)
        return { ok: false, errorCode: 'invalid_parameters', details: runOptions.error.details };
    if (intent && !intent.success)
        return { ok: false, errorCode: 'invalid_parameters' };
    let projectedConnectedServices: Readonly<Record<string, unknown>> | undefined;
    if (overrideEngine && Array.isArray(targetValues) && perTargetConnectedServices
        && typeof perTargetConnectedServices === 'object' && !Array.isArray(perTargetConnectedServices)) {
        const selections = new Map<string, {
            value: unknown;
            normalized: ReturnType<typeof normalizeConnectedServiceSelectionInput>;
        }>();
        for (const [index, rawKey] of targetValues.entries()) {
            if (typeof rawKey !== 'string')
                return { ok: false, errorCode: 'target_unavailable' };
            const target = targets[index];
            if (!target)
                return { ok: false, errorCode: 'target_unavailable' };
            const selectedValue = Reflect.get(perTargetConnectedServices, rawKey);
            const value = selectedValue === undefined ? request.connectedServices : selectedValue;
            const normalized = normalizeConnectedServiceSelectionInput(value);
            if (!normalized.ok)
                return { ok: false, errorCode: 'target_unavailable' };
            const key = buildBackendTargetKeyV2(target);
            const existing = selections.get(key);
            if (existing && !sameStrictJsonValue(existing.normalized, normalized))
                return { ok: false, errorCode: 'target_unavailable' };
            selections.set(key, { value, normalized });
        }
        projectedConnectedServices = Object.fromEntries([...selections].flatMap(([key, selection]) => selection.value === undefined ? [] : [[key, selection.value]]));
    }
    const effectiveInput: Record<string, unknown> = { ...projectSelectedEngine(selectedInput, 'execution_run') };
    if (actionId === 'execution.run.start' && request.backendTarget === undefined)
        effectiveInput.backendTarget = targets[0];
    if (actionId !== 'execution.run.start' && (overrideEngine || targetValues === undefined)) {
        delete effectiveInput.backendTarget;
        effectiveInput[actionId === 'review.start' ? 'engineIds' : 'backendTargetKeys'] = targets.map((target) => buildBackendTargetKeyV2(target!));
    }
    if (projectedConnectedServices)
        effectiveInput.connectedServicesByBackendTargetKey = projectedConnectedServices;
    return { ok: true, requests, effectiveInput };
}
function selection<Value>(schema: z.core.$ZodType<Value>, value: unknown) {
    if (value === undefined)
        return undefined;
    const parsed = z.safeParse(schema, value);
    return parsed.success ? parsed.data : unresolved;
}
/** Selection translation only. All policy, role and depth decisions stay in admitAgentStartV1. */
export function executionRunStartFactsV1(input: Readonly<Record<string, unknown>>, target: PersistedBackendTargetRefV2 | Unresolved, context: ActionExecutorContext, baseline: AgentStartContextV1['baseline']): AgentStartFactsV1 {
    const modelSelection = input.modelSelection !== undefined
        ? selection(ProviderBoundModelRefSchema, input.modelSelection)
        : typeof input.modelId === 'string'
            ? target.kind === 'unresolved' ? unresolved : { agentTargetKey: buildBackendTargetKeyV2(target), providerConnectionId: null, modelId: input.modelId }
            : undefined;
    const overrides = AcpConfigOptionOverridesV1Schema.safeParse(input.sessionConfigOptionOverrides);
    const shorthand = input.configOptions;
    const shorthandOptions = RunStartConfigOptionsSchema.safeParse(shorthand);
    const configOptions = input.sessionConfigOptionOverrides !== undefined
        ? overrides.success ? Object.fromEntries(Object.entries(overrides.data.overrides).map(([key, entry]) => [key, {
                value: entry.value, updatedAtMs: baseline.configuration?.configOptions?.[key]?.updatedAtMs ?? 0,
            }])) : unresolved
        : shorthand !== undefined ? shorthandOptions.success
            ? Object.fromEntries(Object.entries(shorthandOptions.data).map(([key, value]) => [key, { value, updatedAtMs: baseline.configuration?.configOptions?.[key]?.updatedAtMs ?? 0 }]))
            : unresolved : undefined;
    const connected = input.connectedServices === undefined ? undefined : normalizeConnectedServiceSelectionInput(input.connectedServices);
    return {
        agentTarget: target,
        ...(input.cwd !== undefined ? { directory: selection(z.string().check(z.minLength(1)), input.cwd) } : {}),
        ...(context.executionRunTargetMachineId ? { machineId: context.executionRunTargetMachineId } : {}),
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        ...(input.permissionMode !== undefined ? { permissionMode: typeof input.permissionMode === 'string' ? parseAgentPermissionIntentV1Alias(input.permissionMode) ?? unresolved : unresolved } : {}),
        ...(input.agentModeId !== undefined || input.acpSessionModeId !== undefined ? { agentModeId: selection(z.string().check(z.minLength(1)), input.agentModeId ?? input.acpSessionModeId) } : {}),
        ...(configOptions !== undefined ? { configOptions } : {}),
        ...(input.launchProfileId !== undefined ? { profileId: selection(SessionSpawnNewInputV2Schema.shape.profileId._zod.def.innerType, input.launchProfileId) } : {}),
        ...(connected !== undefined ? { connectedServices: connected.ok && connected.defaultServiceIds.length === 0 ? connected.bindings : unresolved } : {}),
        ...(input.capabilitySelection !== undefined ? { capabilitySelection: selection(SessionSpawnNewInputV2Schema.shape.capabilitySelection._zod.def.innerType, input.capabilitySelection) } : {}),
        ...(input.transcriptStorage !== undefined ? { transcriptStorage: selection(SessionSpawnNewInputV2Schema.shape.transcriptStorage._zod.def.innerType, input.transcriptStorage) } : {}),
    };
}
export function spawnStartFactsV1(input: Readonly<SpawnStartFactsInput>): AgentStartFactsV1 {
    const configuration = isUnresolvedStartFact(input.configuration) ? undefined : input.configuration;
    const configurationUnresolved = isUnresolvedStartFact(input.configuration);
    const target = input.agentTarget ?? unresolved;
    return {
        machineId: input.executionTarget && !isUnresolvedStartFact(input.executionTarget) ? input.executionTarget.machineId : unresolved,
        directory: input.directory && !isUnresolvedStartFact(input.directory)
            ? input.directory.kind === 'path' ? input.directory.path : input.directory
            : unresolved,
        agentTarget: target,
        modelSelection: input.modelSelection ?? (configurationUnresolved ? unresolved : configuration?.model.value ? target.kind === 'unresolved' ? unresolved : {
            agentTargetKey: buildBackendTargetKeyV2(target), providerConnectionId: null, modelId: configuration.model.value,
        } : undefined),
        permissionMode: input.permissionMode ?? (configurationUnresolved ? unresolved : configuration?.permissionIntent.value ?? undefined),
        agentModeId: input.agentModeId ?? (configurationUnresolved ? unresolved : configuration?.mode.value ?? undefined),
        configOptions: configurationUnresolved ? unresolved : configuration?.options,
        profileId: input.profileId, connectedServices: input.connectedServices,
        hasEnvironmentVariables: input.environmentVariables !== undefined && input.environmentVariables !== null,
        capabilitySelection: input.capabilitySelection, transcriptStorage: input.transcriptStorage,
    };
}
export async function resolveActionAgentStartContextV1(deps: Pick<ActionExecutorDeps, 'resolveAgentStartContext'> & Partial<Pick<ActionExecutorDeps, 'sessionList' | 'sessionRead'>>, context: ActionExecutorContext, targetSessionId?: string | readonly string[],
    options?: Parameters<NonNullable<ActionExecutorDeps['resolveAgentStartContext']>>[1]): Promise<Awaited<ReturnType<NonNullable<ActionExecutorDeps['resolveAgentStartContext']>>>> {
    let resolved = context.agentStartContext ?? await measureActionStartPhaseV1(context, 'agent_start_context',
      async () => await deps.resolveAgentStartContext?.(context, options) ?? null);
    if (resolved && 'ok' in resolved) return resolved;
    if (context.actionCaller?.kind === 'session') {
        const caller = context.actionCaller;
        if (!resolved || resolved.caller.kind !== 'session' || resolved.caller.sessionId !== caller.sessionId) {
            return resolved ? actionStartTargetUnavailableV1(context, 'agent_start_context', 'caller_witness_invalid') : null;
        }
        const original = AgentStartSessionCallerV1Schema.safeParse(caller);
        if (!original.success) {
            return actionStartTargetUnavailableV1(context, 'agent_start_context', 'caller_witness_invalid');
        }
        resolved = { ...resolved, caller: original.data };
    }
    if (!resolved || targetSessionId === undefined)
        return resolved;
    const origin = resolved.caller.kind === 'session' ? resolved.caller.sessionId : resolved.caller.runOriginSessionId;
    const targets = (typeof targetSessionId === 'string' ? [targetSessionId] : targetSessionId).filter(id => id !== origin);
    if (!origin || targets.length === 0)
        return resolved;
    // Captured start facts preserve caller identity and depth, not a continuing
    // grant to a Session that has since been detached or revoked.
    // Readable led Sessions do not widen an explicitly current-Session-only
    // start corpus, including when captured caller facts named them earlier.
    const ids = context.sessionListAccess !== 'current_session' && deps.sessionRead
        ? await readActionCallerLedSubtreeSessionIds({ sessionRead: deps.sessionRead },
          { ...context, defaultSessionId: origin }, undefined, targets) : null;
    return { ...resolved, ledSubtreeSessionIds: !context.signal?.aborted && ids ? [...ids] : [] };
}
export function admitActionAgentStartV1(context: ActionExecutorContext, request: AgentStartRequestV1,
    resolved: Awaited<ReturnType<NonNullable<ActionExecutorDeps['resolveAgentStartContext']>>>) {
    if (resolved && 'ok' in resolved) return { ok: false as const, refusal: resolved.details, error: resolved };
    const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(context.sessionAgentSpawnPolicyV1 ?? {});
    if (!resolved || !policy.success) {
        const reason = !resolved ? 'agent_start_context_unavailable' as const : 'spawn_policy_invalid' as const;
        const error = actionStartTargetUnavailableV1(context, 'agent_start_context', reason);
        return { ok: false as const, refusal: { code: 'target_unavailable' as const, reason },
            error };
    }
    const admission = admitAgentStartV1(policy.data, request, resolved);
    if (!admission.ok && admission.refusal.code === 'target_unavailable' && admission.refusal.reason)
        context.recordActionStartDiagnostic?.({ phase: 'agent_start_context', refusalReason: admission.refusal.reason });
    return admission.ok ? admission : { ok: false as const, refusal: admission.refusal, error: {
            ok: false as const, errorCode: admission.refusal.code, error: admission.refusal.code, details: admission.refusal,
        } satisfies ActionExecuteFailure };
}
export function readAgentStartTargetV1(value: unknown) {
    const parsed = PersistedBackendTargetRefV2Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function stampAgentStartSelectionV1(input: Readonly<Record<string, unknown>>, stamped: Extract<ReturnType<typeof admitAgentStartV1>, {
    ok: true;
}>['stamped'], kind: 'spawn_new' | 'execution_run', context: AgentStartContextV1) {
    const baseline = context.caller.kind === 'session' ? context.baseline : { machineId: context.baseline.machineId, directory: context.baseline.directory };
    const selected = stamped.roleId && stamped.engine
        ? projectAgentStartSelectionV1(input, { ...stamped, engine: stamped.engine }, kind, baseline)
        : input;
    const target = readAgentStartTargetV1(kind === 'spawn_new' ? selected.agentTarget : selected.backendTarget);
    const profileField = kind === 'spawn_new' ? 'profileId' : 'launchProfileId';
    const machineId = kind === 'spawn_new' && selected.executionTarget && typeof selected.executionTarget === 'object'
        && 'machineId' in selected.executionTarget ? selected.executionTarget.machineId : selected.machineId;
    try {
        const inherited = resolveAgentStartBaselineSelectionV1({
            targetKey: target ? buildBackendTargetKeyV2(target) : undefined,
            profileId: selected[profileField], connectedServices: selected.connectedServices,
            connectedServicesDefaultServiceIds: selected.connectedServicesDefaultServiceIds,
            modelSelection: selected.modelSelection, teamCredentialModel: selected.teamCredentialModel, childSelection: selected.childSelection,
        }, machineId !== undefined && machineId !== baseline.machineId ? undefined : baseline.configuration);
        return { ...selected,
            ...(inherited.profileId !== undefined ? { [profileField]: inherited.profileId } : {}),
            ...(inherited.connectedServices !== undefined ? { connectedServices: inherited.connectedServices } : {}),
        };
    } catch (error) {
        if (error instanceof AgentStartBaselineSelectionErrorV1 && target) {
            const parentModel = baseline.configuration?.modelSelection;
            Object.assign(error, { details: withExecutionRunStartFailureDetails({ childChoice: projectExecutionRunChildChoiceV1({
                agentTargetKey: buildBackendTargetKeyV2(target), parentRouteCompatibility: 'incompatible',
                parentModelSelection: parentModel && 'ref' in parentModel ? parentModel.ref : parentModel ?? null,
            }) }, 'noRunCreated') });
        }
        throw error;
    }
}
export function projectAgentStartSelectionV1(input: Readonly<Record<string, unknown>>, selection: Readonly<{
    engine: RoleEngineV1;
    profileId?: string;
    intent?: Extract<ReturnType<typeof admitAgentStartV1>, {
        ok: true;
    }>['stamped']['intent'];
}>, kind: 'spawn_new' | 'execution_run', baseline: AgentStartContextV1['baseline'], modelSelection?: ProviderBoundModelRef) {
    const stamped = selection;
    const target = parseBackendTargetKeyV2(stamped.engine.agentTargetKey);
    const result: Record<string, unknown> = { ...input, ...(kind === 'spawn_new' ? { agentTarget: target } : { backendTarget: target }) };
    delete result.modelSelection;
    delete result.modelId;
    delete result.teamCredentialModel;
    delete result.teamCredentialSessionBindingConsent;
    if (kind === 'spawn_new' && stamped.profileId !== undefined) {
        delete result.profileId;
        delete result.profileSourceCustody;
    }
    else if (kind === 'execution_run' && stamped.profileId !== undefined) {
        delete result.launchProfileId;
    }
    if (kind === 'spawn_new') {
        const configuration = SessionSpawnNewInputV2Schema.shape.configuration.safeParse(input.configuration);
        if (configuration.success && configuration.data)
            result.configuration = {
                ...configuration.data,
                model: { value: stamped.engine.modelId ?? null, updatedAtMs: 0 },
            };
    }
    if (stamped.engine.modelId) {
        const baselineModel = baseline.configuration?.modelSelection;
        const inheritedModel = baselineModel && 'ref' in baselineModel ? baselineModel.ref : baselineModel;
        const ref = modelSelection ?? readRoleEngineModelRefV1(stamped.engine, inheritedModel)!;
        if (kind === 'spawn_new')
            result.modelSelection = { v: 1, ref, updatedAt: 0 };
        else {
            result.modelId = stamped.engine.modelId;
            result.modelSelection = ref;
        }
    }
    if (stamped.profileId)
        result[kind === 'spawn_new' ? 'profileId' : 'launchProfileId'] = stamped.profileId;
    if (stamped.intent && kind === 'execution_run')
        result.intent = stamped.intent;
    if (stamped.engine.effort) {
        if (kind === 'spawn_new') {
            const configuration = SessionSpawnNewInputV2Schema.shape.configuration.parse(result.configuration);
            result.configuration = { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, ...configuration,
                options: { ...configuration?.options, reasoning_effort: { value: stamped.engine.effort, updatedAtMs: 0 } } };
        }
        else {
            const overrides = AcpConfigOptionOverridesV1Schema.safeParse(input.sessionConfigOptionOverrides);
            result.sessionConfigOptionOverrides = { v: 1, updatedAt: 0, overrides: { ...(overrides.success ? overrides.data.overrides : {}), reasoning_effort: { value: stamped.engine.effort, updatedAt: 0 } } };
        }
    }
    return result;
}
