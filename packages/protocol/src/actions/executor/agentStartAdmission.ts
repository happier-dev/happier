import * as z from 'zod/mini';
import { admitAgentStartV1, AgentStartSessionCallerV1Schema, type AgentStartFactsV1, type AgentStartContextV1, type AgentStartRequestV1, type Unresolved } from '../../account/settings/admitAgentStartV1.js';
import { SessionAgentSpawnPolicyV1StrictSchema } from '../../account/settings/sessionAgentSpawnPolicyV1.js';
import { BackendTargetKeyV2Schema, PersistedBackendTargetRefV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, type PersistedBackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import { normalizeConnectedServiceSelectionInput } from '../../connect/normalizeConnectedServiceSelectionInput.js';
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
import type { WorkflowResolvedStepSelectionV1 } from '../../workflows/workflowStepSelectionV1.js';
import type { RoleEngineV1 } from '../../prompts/roles/roleArtifactV1.js';
import { parseQualifiedPluginContributionKey } from '../../plugins/contributionIdentity.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
/** Authenticated Session identity itself proves its own-target relation. */
export function isActionCallerOwnSessionV1(context: ActionExecutorContext | undefined, sessionId: unknown): boolean {
    return context?.actionCaller?.kind === 'session' && context.actionCaller.sessionId === sessionId;
}
const unresolved = { kind: 'unresolved' } as const;
const RunStartConfigOptionsSchema = z.record(z.string(), SpawnConfigOptionValueSchema);
// Admission needs authoritative selection facts, not a dynamically bound task
// body. The native Session owner still validates the complete effective input.
const spawnPolicyFields = SessionSpawnNewInputV2BaseSchema.pick({
    executionTarget: true, directory: true, agentTarget: true, roleId: true,
    modelSelection: true, permissionMode: true, agentModeId: true, configuration: true,
    profileId: true, environmentVariables: true, connectedServices: true, mcpSelection: true, transcriptStorage: true,
}).strip();
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
/** Action policies that may admit new Agent work, unlike observation and own-Session controls. */
export function requiresActionAgentStartDepthV1(actionId: string): boolean {
    return isAgentStartActionV1(actionId) || actionId === 'workflow.run.start'
        || actionId === 'workflow.definition.create' || actionId === 'workflow.definition.update'
        || actionId === 'workflow.definition.edit'
        || actionId === 'workflow.trigger.add' || actionId === 'workflow.trigger.update'
        || actionId === 'session.trigger.add' || actionId === 'session.trigger.update';
}
export function resolveRunStartModelAndConfig(data: Readonly<Record<string, unknown>>) {
    const modelId = typeof data.modelId === 'string' ? data.modelId.trim() : undefined;
    const canonical = AcpConfigOptionOverridesV1Schema.safeParse(data.sessionConfigOptionOverrides);
    const canonicalOverrides = canonical.success ? canonical.data : undefined;
    const shorthand = RunStartConfigOptionsSchema.safeParse(data.configOptions);
    const configOptions = shorthand.success ? shorthand.data : undefined;
    if (findSpawnConfigOptionAliasConflicts({ sessionConfigOptionOverrides: canonicalOverrides, configOptions }).length > 0) {
        return { ok: false as const };
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
    knownFacts?: AgentStartFactsV1;
}> {
    const { actionId, input: request, context, baseline } = params;
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
        const options = selected.sessionConfigOptionOverrides;
        const target = overrideEngine ? selected.agentTarget ?? unresolved : facts.agentTarget ?? selected.agentTarget ?? undefined;
        const selectedModel = inheritWorkflowModel ? selectedModelForTarget(target) : undefined;
        return {
            ...facts,
            agentTarget: target,
            modelSelection: overrideEngine ? selectedModel : facts.modelSelection === undefined ? selectedModel : facts.modelSelection,
            permissionMode: facts.permissionMode ?? selection(SessionSpawnNewInputV2Schema.shape.permissionMode.unwrap(), selected.permissionMode),
            agentModeId: facts.agentModeId === undefined ? selected.acpSessionModeId : facts.agentModeId,
            configOptions: facts.configOptions === undefined ? options === null ? null : options ? Object.fromEntries(Object.entries(options.overrides)
                .map(([name, option]) => [name, { value: option.value, updatedAtMs: option.updatedAt }])) : undefined : facts.configOptions,
            profileId: actionId !== 'session.spawn_new' && selected.profileId !== undefined ? selected.profileId
                : facts.profileId === undefined ? selected.profileId : facts.profileId,
            connectedServices: facts.connectedServices === undefined ? selected.connectedServices : facts.connectedServices,
            mcpSelection: facts.mcpSelection === undefined ? selected.mcpSelection : facts.mcpSelection,
            transcriptStorage: facts.transcriptStorage ?? selection(SessionSpawnNewInputV2Schema.shape.transcriptStorage.unwrap(), selected.transcriptStorage),
        };
    };
    if (!isAgentStartActionV1(actionId))
        return { ok: true, requests: [], effectiveInput: request };
    const selectedInput: Record<string, unknown> = { ...request };
    if (selected) {
        for (const key of ['permissionMode', 'connectedServices', 'mcpSelection', 'transcriptStorage'] as const) {
            if (selectedInput[key] === undefined && selected[key] !== undefined)
                selectedInput[key] = selected[key];
        }
        if (actionId === 'session.spawn_new' && selectedInput.profileId === undefined && selected.profileId !== undefined)
            selectedInput.profileId = selected.profileId;
        if (selectedInput.agentModeId === undefined && selectedInput.acpSessionModeId === undefined && selected.acpSessionModeId !== undefined)
            selectedInput.agentModeId = selected.acpSessionModeId;
        if (selectedInput.modelSelection === undefined && selectedInput.modelId === undefined && selectedInput.teamCredentialModel === undefined && selected.modelSelection !== undefined) {
            selectedInput.modelSelection = actionId === 'session.spawn_new' || selected.modelSelection === null
                ? selected.modelSelection : selected.modelSelection.ref;
        }
        if (actionId !== 'session.spawn_new' && selectedInput.sessionConfigOptionOverrides === undefined && selectedInput.configOptions === undefined
            && selected.sessionConfigOptionOverrides !== undefined)
            selectedInput.sessionConfigOptionOverrides = selected.sessionConfigOptionOverrides;
    }
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
        for (const key of spawnPolicyFields.keyof().options) {
            if (isUnresolvedStartFact(effectiveInput[key]))
                deferred[key] = true;
        }
        if (Object.keys(deferred).length > 0) {
            // Validate all known required fields with the same native schema. Only
            // actual deferred values are omitted, then retained as unresolved facts.
            const known = spawnPolicyFields.omit(deferred).safeParse(effectiveInput);
            if (known.success) {
                const partial: SpawnStartFactsInput = { ...known.data };
                for (const key of spawnPolicyFields.keyof().options)
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
    let targets = actionId === 'execution.run.start' ? [request.backendTarget === undefined && selected?.agentTarget
            ? selected.agentTarget : readAgentStartTargetV1(request.backendTarget)]
        : (Array.isArray(targetValues) ? targetValues : []).map((value) => {
            if (typeof value !== 'string')
                return null;
            const canonical = BackendTargetKeyV2Schema.safeParse(value);
            return canonical.success ? parseBackendTargetKeyV2(canonical.data)
                : resolveExecutionBackendTargetSelectionForValue(value)?.canonicalBackendTarget ?? null;
        });
    if (overrideEngine && selected?.agentTarget)
        targets = (targets.length ? targets : [selected.agentTarget]).map(() => selected.agentTarget!);
    else if (targetValues === undefined && targets.length === 0 && selected?.agentTarget)
        targets = [selected.agentTarget];
    const runOptions = resolveRunStartModelAndConfig(request);
    const teamModel = TeamCredentialProviderModelSelectionV1Schema.safeParse(request.teamCredentialModel);
    const startInput = { ...request, ...(runOptions.ok ? runOptions.options : {}),
        ...(teamModel.success ? { modelId: teamModel.data.modelId } : {}) };
    if (targets.length === 0 || targets.some((target) => !target))
        return { ok: false, errorCode: 'target_unavailable',
            knownFacts: selectedFacts(executionRunStartFactsV1(startInput, unresolved, context, baseline)),
        };
    inheritWorkflowModel = targets.every((target) => selected?.modelSelection === undefined || selectedModelForTarget(target ?? undefined) !== undefined);
    if (!inheritWorkflowModel && request.modelSelection === undefined && request.modelId === undefined && request.teamCredentialModel === undefined)
        delete selectedInput.modelSelection;
    if (!runOptions.ok)
        return { ok: false, errorCode: 'invalid_parameters' };
    const perTargetConnectedServices = request.connectedServicesByBackendTargetKey;
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
    const intent = actionId === 'execution.run.start' ? ExecutionRunIntentSchema.safeParse(request.intent) : null;
    if (intent && !intent.success)
        return { ok: false, errorCode: 'invalid_parameters' };
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
        ...(input.launchProfileId !== undefined ? { profileId: selection(SessionSpawnNewInputV2Schema.shape.profileId.unwrap(), input.launchProfileId) } : {}),
        ...(connected !== undefined ? { connectedServices: connected.ok && connected.defaultServiceIds.length === 0 ? connected.bindings : unresolved } : {}),
        ...(input.mcpSelection !== undefined ? { mcpSelection: selection(SessionSpawnNewInputV2Schema.shape.mcpSelection.unwrap(), input.mcpSelection) } : {}),
        ...(input.transcriptStorage !== undefined ? { transcriptStorage: selection(SessionSpawnNewInputV2Schema.shape.transcriptStorage.unwrap(), input.transcriptStorage) } : {}),
    };
}
export function spawnStartFactsV1(input: Readonly<SpawnStartFactsInput>): AgentStartFactsV1 {
    const configuration = isUnresolvedStartFact(input.configuration) ? undefined : input.configuration;
    const configurationUnresolved = isUnresolvedStartFact(input.configuration);
    const target = input.agentTarget ?? unresolved;
    return {
        machineId: input.executionTarget && !isUnresolvedStartFact(input.executionTarget) ? input.executionTarget.machineId : unresolved,
        directory: input.directory && !isUnresolvedStartFact(input.directory) && input.directory.kind === 'path' ? input.directory.path : unresolved,
        agentTarget: target,
        modelSelection: input.modelSelection ?? (configurationUnresolved ? unresolved : configuration?.model.value ? target.kind === 'unresolved' ? unresolved : {
            agentTargetKey: buildBackendTargetKeyV2(target), providerConnectionId: null, modelId: configuration.model.value,
        } : undefined),
        permissionMode: input.permissionMode ?? (configurationUnresolved ? unresolved : configuration?.permissionIntent.value ?? undefined),
        agentModeId: input.agentModeId ?? (configurationUnresolved ? unresolved : configuration?.mode.value ?? undefined),
        configOptions: configurationUnresolved ? unresolved : configuration?.options,
        profileId: input.profileId, connectedServices: input.connectedServices,
        hasEnvironmentVariables: input.environmentVariables !== undefined && input.environmentVariables !== null,
        mcpSelection: input.mcpSelection, transcriptStorage: input.transcriptStorage,
    };
}
export async function resolveActionAgentStartContextV1(deps: Pick<ActionExecutorDeps, 'resolveAgentStartContext'> & Partial<Pick<ActionExecutorDeps, 'sessionList'>>, context: ActionExecutorContext, targetSessionId?: string) {
    let resolved = context.agentStartContext ?? await deps.resolveAgentStartContext?.(context) ?? null;
    if (context.actionCaller?.kind === 'session') {
        const caller = context.actionCaller;
        if (!resolved || resolved.caller.kind !== 'session' || resolved.caller.sessionId !== caller.sessionId)
            return null;
        const original = AgentStartSessionCallerV1Schema.safeParse(caller);
        if (!original.success)
            return null;
        resolved = { ...resolved, caller: original.data };
    }
    if (!resolved || targetSessionId === undefined)
        return resolved;
    const origin = resolved.caller.kind === 'session' ? resolved.caller.sessionId : resolved.caller.runOriginSessionId;
    if (!origin || targetSessionId === origin || resolved.ledSubtreeSessionIds.includes(targetSessionId))
        return resolved;
    const ids = deps.sessionList
        ? await readActionCallerLedSubtreeSessionIds({ sessionList: deps.sessionList }, { ...context, defaultSessionId: origin }) : null;
    return { ...resolved, ledSubtreeSessionIds: ids ? [...ids] : [] };
}
export function admitActionAgentStartV1(context: ActionExecutorContext, request: AgentStartRequestV1, resolved: AgentStartContextV1 | null) {
    const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(context.sessionAgentSpawnPolicyV1 ?? {});
    if (!resolved || !policy.success)
        return { ok: false as const, refusal: { code: 'target_unavailable' as const }, error: {
                ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable',
            } satisfies ActionExecuteFailure };
    const admission = admitAgentStartV1(policy.data, request, resolved);
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
    if (!stamped.roleId || !stamped.engine)
        return input;
    const baseline = context.caller.kind === 'session' ? context.baseline : { machineId: context.baseline.machineId, directory: context.baseline.directory };
    return projectAgentStartSelectionV1(input, { ...stamped, engine: stamped.engine }, kind, baseline);
}
function projectAgentStartSelectionV1(input: Readonly<Record<string, unknown>>, selection: Readonly<{
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
    if (kind === 'spawn_new') {
        delete result.profileId;
        delete result.profileSourceCustody;
    }
    else {
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
        const ref = modelSelection ?? { agentTargetKey: stamped.engine.agentTargetKey,
            providerConnectionId: inheritedModel?.agentTargetKey === stamped.engine.agentTargetKey ? inheritedModel.providerConnectionId : null,
            modelId: stamped.engine.modelId,
        };
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
