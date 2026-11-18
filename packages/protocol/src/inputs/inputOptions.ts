import { areServerProfileIdentifiersEquivalent } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import type { ActionHomeEquivalence } from '../actions/executor/coreInvocation.js';
import type { ActionExecutorDeps, ActionExecutorContext } from '../actions/executor/types.js';
import { resolveReviewEngineInventoryTarget } from '../actions/executor/reviewEngineInventoryTarget.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actions/actionExecutionResult.js';
import { actionInputIssueFailure } from '../actions/executor/actionInputValidation.js';
import type { ActionId } from '../actions/actionIds.js';
import type { PublicActionResultById } from '../actions/actionSpecs.js';
import { AgentInventoryProbeInputSchema } from '../actions/actionSpecs.js';
import { parseWorkflowDefinitionRefV1, formatWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionRefV1.js';
import { isWorkflowSavedDefinitionActionId } from '../actions/workflowSavedDefinitionActionIds.js';
import { DaemonProviderModelProjectionResponseV1Schema, getConnectedAccountModelObservationConfidence, isProviderSourceModelCatalogConfidenceUsable } from '../rpc/providers.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { BackendTargetKeyV2InputSchema } from '../backends/targets/backendTargetRefV2.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { readCapabilitySelectionCarrierV1, SessionCapabilitySelectionAuthoringV1Schema, setSessionCapabilitySelectionItemV1 } from '../reach/sessionCapabilitySelectionV1.js';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '../actions/specs/sessionCapabilities.js';
import { resolveReviewNarratorPolicy, ReviewEngineCapabilitiesSchema } from '../reviews/reviewEngines.js';
import { ExecutionRunRetentionPolicySchema } from '../execution/runs/runPrimitives.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { resolveActionBackendTargetSelection, resolveExecutionBackendTargetSelectionForValue } from '../actions/resolveActionBackendTargetSelection.js';
import { readRecord, readRecordListProperty, readNonEmptyString, isRecord, hasOwn } from './inputRecords.js';
import { projectInputOptionsDependencies } from './inputOptionsDependencies.js';
import { inputTypeOptionsSourceId, parseInputTypeOptionsSourceId } from './inputTypes.js';
import { resolveInputTypeOptions, narrowInputFieldOptions, type InputTypeOptionsQueryV1 } from './inputTypeRuntime.js';
import type { InputOption, InputFieldHint } from './inputFields.js';
import type { InputOptionsConsumerV1 } from './inputOptionsConsumer.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedSessionAddressV1.js';
import { parseSessionAwarenessListResultV1 } from '../sessions/awareness/action.js';
import { SESSION_LIST_PAGE_MAX_LIMIT } from '../sessions/listing/query.js';
import { isSessionAwarenessContentReadableV1 } from '../sessions/awareness/availability.js';
import { readSessionAwarenessWorkStatusV1, readSessionWorkStateGroupV1 } from '../sessions/awareness/presentationV1.js';
import { SessionAwarenessProjectionV1Schema, type SessionAwarenessProjectionV1 } from '../sessions/awareness/projectionV1.js';
import { projectNativeJsonValueForTransport, type JsonValue } from '../json/strictJsonValue.js';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { WorkspaceRefV1Schema } from '../workspaces/workspaceRefV1.js';
import { createProjectAnchorOfKeyV1 } from '../workspaces/workspaceRefResolutionV1.js';
import { MachineVitalsSnapshotV1Schema } from '../machines/vitals/machineVitalsRpcV1.js';
import { normalizeUsageQuery, readUsageGroupByOptions, readUsagePeriodOptions } from './usageQuery.js';
import { DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1, DEPLOYMENT_TELEMETRY_ROUTES_OPTIONS_SOURCE_ID_V1,
  resolveDeploymentTelemetryEnvironmentOptionsV1, resolveDeploymentTelemetryRouteOptionsV1 } from './deploymentTelemetryEnvironmentOptions.js';
import { readUsageScopeOptions } from '../usage/usageFilterOptions.js';
import { resolveMachineSetupSoftwareOptions } from './machineSetupSoftwareOptions.js';
import { DesktopDisplaysListResultSchema } from '../actions/specs/desktopShell.js';
import { BrowserExtensionsListResultV1Schema } from '../actions/browserExtensionActions.js';

export function normalizeResolvedOptions(value: unknown, options: Readonly<{ allowEmptyValue?: boolean }> = {}): readonly Readonly<{ value: string; label: string; description?: string; disabled?: boolean }>[] {
  const items = readRecordListProperty(value, 'items').length > 0
    ? readRecordListProperty(value, 'items')
    : Array.isArray(value)
      ? value.filter(isRecord)
      : [];

  return items
    .map((item) => {
      const valueCandidate =
        typeof item?.targetKey === 'string'
          ? item.targetKey
          : typeof item?.value === 'string'
          ? item.value
          : typeof item?.id === 'string'
            ? item.id
            // Machine inventory rows (the UI machines list) name their Machine by machineId.
            : typeof item?.machineId === 'string'
            ? item.machineId
            : typeof item?.modelId === 'string'
              ? item.modelId
              : typeof item?.path === 'string'
                ? item.path
                : typeof item?.agentId === 'string'
                  ? item.agentId
                  : typeof item?.engineId === 'string'
                    ? item.engineId
                    : null;
      if (valueCandidate === null || (valueCandidate === '' && options.allowEmptyValue !== true)) return null;
      const labelCandidate =
        typeof item?.label === 'string'
          ? item.label
          : typeof item?.title === 'string'
            ? item.title
            : valueCandidate;
      const descriptionCandidate = typeof item?.description === 'string' ? item.description : undefined;
      const disabledCandidate =
        item?.disabled === true || item?.enabled === false ? true : undefined;
      return {
        value: valueCandidate,
        label: labelCandidate,
        ...(descriptionCandidate ? { description: descriptionCandidate } : {}),
        ...(disabledCandidate ? { disabled: true as const } : {}),
      };
    })
    .filter((option): option is NonNullable<typeof option> => option !== null);
}

/**
 * A Machine picker's choices from a Machine inventory read: retired and replaced Machines are not
 * choices, each says whether it can answer now, and the online ones lead in their listed order.
 * `toChoice` names one Machine (`null` skips it; `'invalid'` refuses the whole read).
 */
function readMachineChoices(
  result: unknown,
  toChoice: (machine: Record<string, unknown>) => Omit<InputOption, 'description'> | null | 'invalid',
): InputOption[] | null {
  const online: InputOption[] = [];
  const offline: InputOption[] = [];
  for (const machine of readRecordListProperty(result, 'items')) {
    if (typeof machine.revokedAt === 'number' && machine.revokedAt > 0 || readNonEmptyString(machine.replacedByMachineId)) continue;
    const choice = toChoice(machine);
    if (choice === 'invalid') return null;
    if (!choice) continue;
    const answers = machine.presence === 'online' || (machine.presence === undefined && machine.active === true);
    (answers ? online : offline).push({ ...choice, description: answers ? 'Online' : 'Offline' });
  }
  return [...online, ...offline];
}

export function tryNormalizeExecutionBackendOptionValue(value: string): string | null {
  // Options carry durable identity, not a host-catalog routing decision.
  const canonicalKey = BackendTargetKeyV2InputSchema.safeParse(value.trim());
  if (canonicalKey.success) return canonicalKey.data;
  return resolveExecutionBackendTargetSelectionForValue(value)?.backendTargetKey ?? null;
}

export function readReviewNarratorOptions(value: unknown) {
  const items = readRecordListProperty(value, 'items').length > 0
    ? readRecordListProperty(value, 'items')
    : Array.isArray(value) ? value.filter(isRecord) : [];
  return items.flatMap((item) => {
    const capability = ReviewEngineCapabilitiesSchema.safeParse(item.capabilities);
    const retentionPolicy = ExecutionRunRetentionPolicySchema.safeParse(item.retentionPolicy);
    const profileSourceCustody = PluginSourceCustodyV1Schema.safeParse(item.profileSourceCustody);
    return normalizeResolvedOptions([item]).map((option) => ({
      ...option,
      value: tryNormalizeExecutionBackendOptionValue(option.value) ?? option.value,
      capabilities: capability.success ? capability.data : { structuredNarration: false },
      ...(retentionPolicy.success ? { retentionPolicy: retentionPolicy.data } : {}),
      ...(typeof item.profileId === 'string' ? { profileId: item.profileId } : {}),
      ...(profileSourceCustody.success ? { profileSourceCustody: profileSourceCustody.data } : {}),
    }));
  });
}

/**
 * The agent an inventory read is scoped to.
 *
 * `required` is the rule for every inventory that cannot be enumerated without
 * knowing whose it is — models, config options, session modes, connected
 * services. `optional` belongs to the profiles catalog alone: a Launch Profile
 * carries its own `supportedAgentIds`, so the agent narrows the answer rather
 * than making it possible, and a caller that picks a profile FIRST has no agent
 * to name yet. A contradictory pair is still refused in both modes.
 */
export async function buildAgentInventorySelectionArgs(params: Readonly<{
  deps: ActionExecutorDeps;
  actionId: ActionId | null;
  input: Record<string, unknown>;
  agentScope?: 'required' | 'optional';
}>): Promise<Readonly<{ agentId?: string; backendTargetKey?: string }> | ActionExecuteFailure> {
  const { deps, actionId, input } = params;
  const agentScope = params.agentScope ?? 'required';
  const invalidSelection = (field: string) => actionInputIssueFailure({ code: 'invalid_selection',
    path: [...(actionId ? ['draftInput'] : []), field] });
  if (actionId === 'session.spawn_new') {
    const agentTarget = AgentExecutionTargetV1Schema.safeParse(input.agentTarget);
    if (!agentTarget.success) return agentScope === 'optional' ? {} : invalidSelection('agentTarget');
    const machineId = readDynamicOptionMachineId(input, actionId);
    const serverId = readNonEmptyString(readRecord(input.executionTarget).serverId);
    return await deps.resolveSessionSpawnAgentInventorySelection?.({
      agentTarget: agentTarget.data,
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
    })
      ?? (agentScope === 'optional' ? {} : invalidSelection('agentTarget'));
  }

  const resolved = resolveActionBackendTargetSelection({
    agentId: typeof input.agentId === 'string' ? input.agentId : undefined,
    backendTargetKey: typeof input.backendTargetKey === 'string' ? input.backendTargetKey : undefined,
  });
  if (!resolved.ok) return invalidSelection(resolved.path);
  const selection = resolved.selection;
  if (!selection.agentId && !selection.backendTargetKey && agentScope === 'required') return invalidSelection('backendTargetKey');
  return {
    ...(selection.agentId ? { agentId: selection.agentId } : {}),
    ...(selection.backendTargetKey ? { backendTargetKey: selection.backendTargetKey } : {}),
  };
}

function readDynamicOptionMachineId(
  input: Record<string, unknown>,
  actionId: ActionId | null,
  context?: ActionExecutorContext,
): string | undefined {
  if (actionId === 'session.spawn_new') {
    return readNonEmptyString(readRecord(input.executionTarget).machineId);
  }
  return readNonEmptyString(input.machineId)
    ?? (actionId === 'execution.run.start' ? readNonEmptyString(context?.defaultSessionMachineId) : undefined);
}

function readDynamicOptionModelId(
  input: Record<string, unknown>,
  actionId: ActionId | null,
): string | undefined {
  if (actionId !== 'session.spawn_new') {
    return typeof input.modelId === 'string' ? input.modelId : undefined;
  }

  const selectedModelId = readNonEmptyString(readRecord(readRecord(input.modelSelection).ref).modelId);
  if (selectedModelId) return selectedModelId;
  return readNonEmptyString(readRecord(readRecord(input.configuration).model).value);
}

function readDynamicOptionDirectory(
  input: Record<string, unknown>,
  actionId: ActionId | null,
): string | undefined {
  if (actionId === 'session.spawn_new') {
    const intent = SessionDirectoryIntentV1Schema.safeParse(input.directory);
    return intent.success && intent.data.kind === 'path' ? intent.data.path : undefined;
  }
  return readNonEmptyString(input.directory) ?? readNonEmptyString(input.path);
}

const SESSION_GROUP_LABELS = { needsYou: 'Needs you', working: 'Working', recent: 'Recent' } as const;

/**
 * The one rule for which Sessions the picker offers, whether a Session arrives in the inventory scan or in a
 * point read: archived Sessions are not offered (the scan also asks for `storage: 'active'`), a locked one is
 * offered as a disabled option, and a gone one never arrives. Returns null when the Session is not offered.
 */
function readSessionAwarenessOption(serverId: string, session: SessionAwarenessProjectionV1) {
  if (session.lifecycle === 'archived') return null;
  const readable = isSessionAwarenessContentReadableV1(session.encryption);
  const group = readSessionWorkStateGroupV1(readSessionAwarenessWorkStatusV1({ awareness: session }).bucket);
  const option: InputOption = {
    value: VoiceTrackedSessionAddressV1Schema.parse({ serverId, sessionId: session.sessionId }),
    label: readable ? session.title ?? session.sessionId : session.sessionId,
    description: SESSION_GROUP_LABELS[group],
    ...(!readable ? { disabled: true } : {}),
  };
  return { group, option };
}

/**
 * The `sessions` source's point check: each picked Session is answered by the one-Session status read
 * instead of paging the whole Home, then judged by the same rule as the scan. A pick the Home reports gone
 * has no option; a read that cannot answer is that read's own failure, not a reason to scan.
 */
async function readSessionOptionsForValues(params: Readonly<{
  executor: Readonly<{ execute: (actionId: ActionId, input: unknown, ctx?: ActionExecutorContext) => Promise<ActionExecuteResult> }>;
  ctx: ActionExecutorContext;
  serverId: string;
  values: readonly JsonValue[];
  sameHome: ActionHomeEquivalence;
}>): Promise<Extract<ActionExecuteResult, { ok: false }> | readonly InputOption[]> {
  const options: InputOption[] = [];
  for (const value of params.values) {
    const address = VoiceTrackedSessionAddressV1Schema.safeParse(value);
    // The inventory only ever offers this Home's Sessions, so any other pick has no option there either.
    if (!address.success || !params.sameHome(address.data.serverId, params.serverId)) continue;
    params.ctx.signal?.throwIfAborted();
    const result = await params.executor.execute('session.status.get', { sessionId: address.data.sessionId }, params.ctx);
    if (!result.ok) return result;
    const status = readRecord(result.result);
    if (status.ok === false) {
      const code = typeof status.code === 'string' && status.code ? status.code : 'unavailable';
      if (code === 'session_not_found') continue;
      return { ok: false, errorCode: code, error: code };
    }
    const awareness = SessionAwarenessProjectionV1Schema.safeParse(status.awareness);
    if (!awareness.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    // A host that resolves ids by prefix answers another Session when this exact id does not exist.
    if (awareness.data.sessionId !== address.data.sessionId) continue;
    const offered = readSessionAwarenessOption(params.serverId, awareness.data);
    if (offered) options.push(offered.option);
  }
  return options;
}

/** Field choices restrict, never replace, the type's schema and declared Resource choices. */
export async function resolveTypedInputFieldOptions(params: Omit<Parameters<typeof resolveInputOptions>[0], 'optionsSourceId'> &
  Readonly<{ field: InputFieldHint }>): ReturnType<typeof resolveInputOptions> {
  const { field, deps, ctx } = params;
  const identity = field.inputType;
  if (!identity || 'hostType' in identity) return { ok: false, errorCode: 'input_type_unavailable', error: 'input_type_unavailable' };
  const type = await deps.resolveInputType?.(identity, ctx);
  if (!type || type.identity.pluginId !== identity.pluginId || type.identity.localId !== identity.localId)
    return { ok: false, errorCode: 'input_type_unavailable', error: 'input_type_unavailable' };
  let typeOptions: readonly InputOption[] | undefined;
  let nextCursor: string | undefined;
  if (type.definition.options) {
    const sessionId = params.resolveSessionId(params.input, ctx);
    const resolved = await resolveInputTypeOptions({ deps, ctx, identity, query: params.query, readFailure: params.readFailure,
      ...(sessionId ? { sessionId } : {}) });
    if (!resolved.ok) return resolved;
    typeOptions = resolved.result;
    nextCursor = resolved.nextCursor;
  }
  let options = field.options ?? typeOptions ?? [];
  if (field.options === undefined && field.optionsSourceId) {
    const resolved = await resolveInputOptions({ ...params, optionsSourceId: field.optionsSourceId });
    if (!resolved.ok) return resolved;
    options = resolved.result;
  }
  const current = await deps.resolveInputType?.(identity, ctx);
  if (ctx.signal?.aborted || current?.occurrenceId !== type.occurrenceId)
    return { ok: false, errorCode: 'input_type_retired', error: 'input_type_retired' };
  return { ok: true, ...(nextCursor === undefined ? {} : { nextCursor }), result: narrowInputFieldOptions({ field, type, options: typeOptions ?? options, candidates: options }),
    ...(field.options !== undefined || !field.optionsSourceId && !type.definition.options ? { optionsSourceId: null } : {}) };
}

export async function resolveInputOptions(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  sameHome?: ActionHomeEquivalence;
  actionId: ActionId | null;
  optionsSourceId: string;
  input: Record<string, unknown>;
  consumer?: InputOptionsConsumerV1;
  query?: InputTypeOptionsQueryV1;
  /** Picked values to check: a source that can answer them directly does not read its whole inventory. */
  values?: readonly JsonValue[];
  includeSpawnModelCatalog?: boolean;
  /** Sources owned by a client Action use the same admitted transport from headless hosts. */
  executeOwnerAction?: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  readFailure: (result: unknown) => Extract<ActionExecuteResult, { ok: false }> | null;
  resolveSessionId: (input: unknown, ctx: ActionExecutorContext) => string | null;
  reviewScope: (input: unknown) => 'paths' | undefined;
}>): Promise<Extract<ActionExecuteResult, { ok: false }> | Readonly<{
  ok: true;
  result: readonly InputOption[];
  optionsSourceId?: null;
  nextCursor?: string;
  modelCatalog?: NonNullable<PublicActionResultById['action.options.resolve']['modelCatalog']>;
  machineRecipeDetails?: NonNullable<PublicActionResultById['action.options.resolve']['machineRecipeDetails']>;
}>> {
  const { deps, ctx, actionId, optionsSourceId } = params;
  const sameHome = params.sameHome ?? areServerProfileIdentifiersEquivalent;
  const input = projectInputOptionsDependencies(params.input);
  const machineId = readDynamicOptionMachineId(input, actionId, ctx);
  const serverId = actionId === 'session.spawn_new'
    ? readNonEmptyString(readRecord(input.executionTarget).serverId)
    : readNonEmptyString(ctx.serverId);
  const modelId = readDynamicOptionModelId(input, actionId);
  const directory = readDynamicOptionDirectory(input, actionId);

  if (optionsSourceId === 'browser.profiles.available') {
    if (!machineId) return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
      details: { requiredDraftPath: 'machineId' } };
    const ownerContext = { ...ctx, externalActionTarget: ctx.externalActionTarget ?? { kind: 'machine' as const, machineId } };
    let result: unknown;
    if (params.executeOwnerAction) {
      const executed = await params.executeOwnerAction('browser.extensions.list', { machineId }, ownerContext);
      if (!executed.ok) return executed;
      result = executed.result;
    } else if (deps.runtimeActionExecute) {
      result = await deps.runtimeActionExecute({ actionId: 'browser.extensions.list', input: { machineId }, context: ownerContext });
    } else {
      return { ok: false, errorCode: 'unavailable', error: 'browser.profiles.available' };
    }
    const failure = params.readFailure(result);
    if (failure) return failure;
    const parsed = BrowserExtensionsListResultV1Schema.safeParse(result);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    if (parsed.data.status === 'unavailable') return { ok: false, errorCode: parsed.data.code,
      error: parsed.data.message ?? parsed.data.code };
    if (parsed.data.profiles === undefined) return { ok: false, errorCode: 'unavailable', error: 'browser.profiles.available' };
    return { ok: true, result: parsed.data.profiles.map(profile => ({ value: profile.profileId,
      label: profile.displayName ?? profile.profileId })) };
  }

  if (optionsSourceId === 'desktop.displays.list') {
    let result: unknown;
    if (params.executeOwnerAction) {
      const executed = await params.executeOwnerAction('desktop.displays.list', {});
      if (!executed.ok) return executed;
      result = executed.result;
    } else if (deps.desktopDisplaysList) {
      result = await deps.desktopDisplaysList({ context: ctx });
    } else {
      return { ok: false, errorCode: 'unavailable', error: 'desktop.displays.list' };
    }
    const failure = params.readFailure(result);
    if (failure) return failure;
    const parsed = DesktopDisplaysListResultSchema.safeParse(result);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const { displays, automaticResolvesTo } = parsed.data;
    const automatic = displays.find(display => display.storageKey === automaticResolvesTo);
    return { ok: true, result: [
      { value: 'automatic', label: 'Automatic', ...(automatic ? { description: automatic.name } : {}) },
      ...(displays.some(display => display.builtIn) ? [{ value: 'built_in', label: 'Built-in display' }] : []),
      { value: 'main', label: 'Display with the Happier window' },
      ...displays.map(display => ({ value: `named:${display.storageKey}`, label: display.name,
        description: display.connected ? 'Connected' : 'Not connected' })),
    ] };
  }

  if (optionsSourceId === 'machines.setup.software.available' || optionsSourceId === 'machines.setup.recipes.available') {
    return resolveMachineSetupSoftwareOptions({ deps, ctx, actionId, input, values: params.values,
      softwareOnly: optionsSourceId === 'machines.setup.software.available' });
  }

  if (optionsSourceId === 'usage.query.period' || optionsSourceId === inputTypeOptionsSourceId({ hostType: 'usageQuery', field: 'period' })) {
    const draft = isRecord(params.input.query) ? params.input.query : params.input;
    return { ok: true, result: readUsagePeriodOptions(draft.period) };
  }

  if (optionsSourceId === 'usage.query.breakdown') {
    const draft = isRecord(params.input.query) ? params.input.query : params.input;
    return { ok: true, result: readUsageGroupByOptions(draft.breakdown) };
  }

  const usageField = optionsSourceId === 'usage.filters.agents' ? 'agents'
    : optionsSourceId === 'usage.filters.machines' ? 'machines'
    : optionsSourceId === 'usage.filters.projects' ? 'projects'
    : optionsSourceId === 'usage.filters.sources' ? 'sources' : null;
  if (usageField) {
    // Inventory is the same authorized accounting read the Usage toolbar consumes; no execution
    // target catalog or consumer-owned picker decides what a usage identity means.
    const draft = isRecord(params.input.query) ? params.input.query : params.input;
    const query = normalizeUsageQuery({ period: draft.period, session: draft.session, costBasis: draft.costBasis,
      includeAccounting: true, includeContributions: false, includeComparison: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
      includeSeries: false, includeInsights: false, includeActivity: false, includeLeaders: false,
      includeModelTimeline: false, includeMessageStats: false,
      breakdown: ['agent', 'machine', 'project', 'source'] });
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if (!deps.usageActions) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    // The typed port admits its transport once. Only an external Action needs
    // result re-admission and envelope projection, not an in-process picker.
    const batch = await deps.usageActions.query({ queries: [query] }, ctx);
    if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    if ('ok' in batch) return batch;
    const selected = Array.isArray(draft[usageField]) ? draft[usageField].filter((value): value is string => typeof value === 'string') : [];
    // Usage a checkout was stamped with before it joined a Project is offered under that Project (owner 11-08).
    let anchorOf: ((key: string) => string) | undefined;
    const projectHome = readNonEmptyString(ctx.serverId);
    if (usageField === 'projects' && projectHome && deps.projectWorkspaceRefs) {
      const census = await deps.projectWorkspaceRefs({ serverId: projectHome }, ctx);
      ctx.signal?.throwIfAborted();
      if (!params.readFailure(census)) {
        const refs = readRecordListProperty(census, 'workspaceRefs').flatMap(row => {
          const ref = WorkspaceRefV1Schema.safeParse(row);
          return ref.success ? [ref.data] : [];
        });
        const resolve = createProjectAnchorOfKeyV1(refs);
        anchorOf = key => resolve(projectHome, key);
      }
    }
    const labels = readUsageScopeOptions(batch.results, usageField, selected, anchorOf);
    if (usageField === 'machines' && deps.machinesList) {
      if (!serverId) return { ok: false, errorCode: 'server_not_selected', error: 'server_not_selected' };
      const machines = await deps.machinesList({ serverId, purpose: 'input' }, ctx);
      const failure = params.readFailure(machines);
      if (failure) return failure;
      ctx.signal?.throwIfAborted();
      // This catalog names only the existing accounting identities; it cannot add choices.
      for (const machine of readRecordListProperty(machines, 'items')) {
        const id = readNonEmptyString(machine.machineId) ?? readNonEmptyString(machine.id);
        const label = readNonEmptyString(machine.label);
        if (id && label && labels.has(id)) labels.set(id, label);
      }
    }
    return { ok: true, result: [...labels]
      .map(([value, label]) => ({ value, label })) };
  }

  if (optionsSourceId === 'host-input:workspace') {
    const selectedServerId = readNonEmptyString(ctx.serverId);
    if (!selectedServerId) return { ok: false, errorCode: 'server_not_selected', error: 'server_not_selected' };
    if (!deps.projectWorkspaceRefs) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.list' };
    const result = await deps.projectWorkspaceRefs({ serverId: selectedServerId }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    ctx.signal?.throwIfAborted();
    // Machine names only tell apart the same checkout on two machines; an unreadable list leaves the path to do that.
    // A host marks a row `named: false` when its label is not a real name (hidden or still loading), and supplies the word
    // for a machine it does not list (`unlistedLabel`), so every checkout is named the way the host's own screens name it.
    const machineList = deps.machinesList ? await deps.machinesList({ serverId: selectedServerId, purpose: 'input' }, ctx) : undefined;
    const machineLabels = new Map<string | undefined, string>();
    let unlistedLabel: string | undefined;
    if (machineList !== undefined && !params.readFailure(machineList)) {
      unlistedLabel = readNonEmptyString(readRecord(machineList).unlistedLabel);
      for (const machine of readRecordListProperty(machineList, 'items')) {
        const id = readNonEmptyString(machine.machineId) ?? readNonEmptyString(machine.id);
        const label = readNonEmptyString(machine.label);
        if (id && label && machine.named !== false) machineLabels.set(id, label);
      }
    }
    const options: InputOption[] = [];
    for (const row of readRecordListProperty(result, 'workspaceRefs')) {
      const ref = WorkspaceRefV1Schema.safeParse(row);
      if (!ref.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      // Recency changes whenever the checkout is opened; a saved pin must keep matching its option.
      const { lastOpenedAtMs: _recency, ...stable } = ref.data;
      const machineLabel = machineLabels.get(ref.data.machineId) ?? unlistedLabel;
      options.push({ value: projectNativeJsonValueForTransport(stable), label: ref.data.label ?? ref.data.rootPath.split(/[\\/]+/).filter(Boolean).at(-1) ?? ref.data.rootPath,
        description: machineLabel ? `${machineLabel} · ${ref.data.rootPath}` : ref.data.rootPath });
    }
    return { ok: true, result: options };
  }

  if (optionsSourceId === 'host-input:machine') {
    const selectedServerId = readNonEmptyString(ctx.serverId);
    if (!selectedServerId) return { ok: false, errorCode: 'server_not_selected', error: 'server_not_selected' };
    if (!deps.machinesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:machines.list' };
    const result = await deps.machinesList({ serverId: selectedServerId,
      ...(ctx.surface === 'voice' ? {} : { purpose: 'input' as const }) }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    ctx.signal?.throwIfAborted();
    const options = readMachineChoices(result, (machine) => {
      const target = MachineTargetV1Schema.safeParse({ serverId: readNonEmptyString(machine.serverId) ?? selectedServerId,
        machineId: readNonEmptyString(machine.machineId) ?? readNonEmptyString(machine.id) });
      if (!target.success || !sameHome(target.data.serverId, selectedServerId)) return 'invalid';
      return { value: target.data, label: readNonEmptyString(machine.label) ?? target.data.machineId };
    });
    if (!options) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    return { ok: true, result: options };
  }

  if (optionsSourceId === DEPLOYMENT_TELEMETRY_ENVIRONMENTS_OPTIONS_SOURCE_ID_V1) {
    return await resolveDeploymentTelemetryEnvironmentOptionsV1({ deps, ctx, readFailure: params.readFailure });
  }

  if (optionsSourceId === DEPLOYMENT_TELEMETRY_ROUTES_OPTIONS_SOURCE_ID_V1) {
    return await resolveDeploymentTelemetryRouteOptionsV1({ deps, ctx, input, readFailure: params.readFailure });
  }

  if (optionsSourceId === 'machines.volumes.available') {
    const machine = MachineTargetV1Schema.safeParse(input.machine);
    if (!machine.success) return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
      details: { requiredDraftPath: 'machine' } };
    const { createActionExecutor } = await import('../actions/actionExecutor.js');
    const result = await createActionExecutor(deps).execute('machines.vitals.get', { ...machine.data, view: 'overview' }, ctx);
    if (!result.ok) return result;
    const snapshot = MachineVitalsSnapshotV1Schema.safeParse(result.result);
    if (!snapshot.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const disk = snapshot.data.sample?.disk;
    if (!disk?.reported) return { ok: false, errorCode: 'machine_volumes_unavailable', error: 'machine_volumes_unavailable' };
    return { ok: true, result: disk.volumes.map(volume => ({ value: volume.id, label: volume.label, description: volume.mount })) };
  }

  if (optionsSourceId === inputTypeOptionsSourceId({ hostType: 'usageQuery', field: 'session' })) {
    // The Usage Session type stores a session id on the current Home: the same Home sessions, by name,
    // chosen in place like the Period (no picker dialog).
    const sessions = await resolveInputOptions({ ...params, optionsSourceId: 'sessions', values: undefined });
    if (!sessions.ok) return sessions;
    return { ok: true, result: sessions.result.map(option => ({ ...option,
      value: VoiceTrackedSessionAddressV1Schema.parse(option.value).sessionId })) };
  }

  const inputTypeIdentity = parseInputTypeOptionsSourceId(optionsSourceId);
  if (inputTypeIdentity) {
    const sessionId = params.resolveSessionId(input, ctx);
    return resolveInputTypeOptions({ deps, ctx, identity: inputTypeIdentity, query: params.query, readFailure: params.readFailure,
      ...(sessionId ? { sessionId } : {}) });
  }

  if (optionsSourceId === 'sessions') {
    // The admitted consumer owns the qualified values it compares with a saved pin.
    // Transport still uses ctx's captured profile; profile aliases are not input identity.
    const sessionServerId = readNonEmptyString(params.consumer?.kind === 'widget'
      ? params.consumer.selectedSession?.serverId ?? params.consumer.surface.serverId : ctx.serverIdentityId ?? ctx.serverId);
    if (!sessionServerId) return { ok: false, errorCode: 'server_not_selected', error: 'server_not_selected' };
    // Enter through the existing Action owner so credential grants, the caller's
    // admitted corpus and marked-query admission also govern option discovery.
    const { createActionExecutor } = await import('../actions/actionExecutor.js');
    const executor = createActionExecutor(deps);
    if (params.values) {
      const direct = await readSessionOptionsForValues({ executor, ctx, serverId: sessionServerId, values: params.values, sameHome });
      return 'ok' in direct ? direct : { ok: true, result: direct };
    }
    const groups: Record<'needsYou' | 'working' | 'recent', InputOption[]> = { needsYou: [], working: [], recent: [] };
    const consumer = params.consumer;
    const project = consumer?.kind === 'widget' && consumer.surface.owner.kind === 'project'
      ? { serverId: consumer.surface.serverId, projectKey: consumer.surface.owner.projectId }
      : undefined;
    // Project membership belongs to session.list's admitted metadata/workspace owner.
    // Read it through that owner, then order the same Home corpus without narrowing it.
    const projectSessionIds = new Set<string>();
    for (const projectFilter of project ? [project, undefined] : [undefined]) {
      let cursor: string | undefined;
      do {
        ctx.signal?.throwIfAborted();
        const result = await executor.execute('session.list', { view: 'awareness', ...(projectFilter ? { project: projectFilter } : {}), query: {
          v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
          audiences: [], tagIds: [], includeAttention: false,
          // The picker reads the whole inventory, one round trip per page: ask for the largest page the Home's list allows.
          limit: SESSION_LIST_PAGE_MAX_LIMIT,
          ...(cursor ? { cursor } : {}),
        } }, ctx);
        if (!result.ok) return result;
        const page = parseSessionAwarenessListResultV1(result.result);
        if (!page || (page.hasNext && !page.nextCursor)) {
          return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        }
        for (const session of page.sessions) {
          if (projectFilter) {
            projectSessionIds.add(session.sessionId);
            continue;
          }
          const offered = readSessionAwarenessOption(sessionServerId, session);
          if (offered) groups[offered.group].push(offered.option);
        }
        cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
      } while (cursor);
    }
    ctx.signal?.throwIfAborted();
    const options = [...groups.needsYou, ...groups.working, ...groups.recent];
    const belongsToProject = (option: InputOption) => projectSessionIds.has(VoiceTrackedSessionAddressV1Schema.parse(option.value).sessionId);
    return { ok: true, result: project
      ? [...options.filter(belongsToProject), ...options.filter(option => !belongsToProject(option))]
      : options };
  }

  if (optionsSourceId === 'workflows.references.available') {
    if (!deps.workflowAction) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workflows.references.available' };
    }
    const [{ WorkflowDefinitionListResultV1Schema }, { getBuiltinWorkflowCatalogV1 }, { resolveWorkflowDefinitionRefV1 }] = await Promise.all([
      import('../workflows/actionsV1.js'), import('../workflows/builtins/catalog.js'), import('../workflows/workflowDefinitionResolverV1.js'),
    ]);
    const options: Array<{ value: string; label?: string }> = [];
    // A saved-definition field (workflow.definition.get and its siblings) offers saved workflows only, by name.
    const savedOnly = isWorkflowSavedDefinitionActionId(actionId);
    let cursor: string | undefined;
    do {
      ctx.signal?.throwIfAborted();
      const result = await deps.workflowAction({ actionId: 'workflow.definition.list',
        input: cursor ? { cursor } : {}, context: ctx });
      const failure = params.readFailure(result);
      if (failure) return failure;
      const page = WorkflowDefinitionListResultV1Schema.parse(result);
      for (const plugin of savedOnly ? [] : page.pluginWorkflows ?? []) {
        options.push({ value: plugin.workflow, label: plugin.title });
      }
      for (const definition of page.definitions) {
        // Run source.workflow is the catalog arm; saved Runs require an exact
        // Artifact revision through source.definitionId instead.
        const ref = parseWorkflowDefinitionRefV1(definition.definitionId);
        if (actionId !== 'workflow.run.start' && ref?.kind === 'artifact') {
          options.push({ value: formatWorkflowDefinitionRefV1(ref),
            ...(definition.metadata ? { label: definition.metadata.title } : {}) });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const entry of savedOnly ? [] : getBuiltinWorkflowCatalogV1()) {
      const resolved = await resolveWorkflowDefinitionRefV1(entry.id, { signal: ctx.signal });
      if (resolved?.kind === 'catalog') {
        options.push({ value: resolved.ref, label: entry.id });
      }
    }
    return { ok: true, result: normalizeResolvedOptions(options) };
  }

  if (optionsSourceId === 'notifications.channels.available') {
    if (!deps.notificationChannelsList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:notifications.channels.available' };
    }
    const result = await deps.notificationChannelsList(ctx);
    const failure = params.readFailure(result);
    return failure ?? { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'execution.backends.enabled' || optionsSourceId === 'agents.backends.enabled') {
    if (!deps.agentsBackendsList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.backends.list' };
    const result = await deps.agentsBackendsList({
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : { includeDisabled: false }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(machineId === undefined ? {} : { machineId }),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return {
      ok: true,
      result: normalizeResolvedOptions(result)
        .map((option) => {
          const normalizedValue = tryNormalizeExecutionBackendOptionValue(option.value);
          if (!normalizedValue) {
            return null;
          }
          return {
            ...option,
            value: normalizedValue,
          };
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option)),
    };
  }

  if (optionsSourceId === 'review.engines.available') {
    if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:review.engines.list' };
    const target = resolveReviewEngineInventoryTarget(input, ctx, params.resolveSessionId);
    if (!target.ok) return target;
    const result = await deps.reviewEnginesList({
      ...target.target,
      ...(typeof input.includeDisabled === 'boolean' ? { includeDisabled: input.includeDisabled } : {}),
      ...(params.reviewScope(input) ? { scope: 'paths' as const } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    const options = normalizeResolvedOptions(result);
    if (input.fieldPath === 'narrator.engineId') {
      const engines = readReviewNarratorOptions(result);
      return { ok: true, result: options.filter((option) => resolveReviewNarratorPolicy({
        selectedEngineIds: [tryNormalizeExecutionBackendOptionValue(option.value) ?? option.value], engines,
      }).defaultNarratorEngineId !== null) };
    }
    return { ok: true, result: options };
  }

  if (optionsSourceId === 'session.modes.available') {
    if (!deps.sessionModesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.modes.list' };
    const sessionId = params.resolveSessionId(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.sessionModesList({ sessionId });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result, { allowEmptyValue: true }) };
  }

  const readInventoryProbe = () => AgentInventoryProbeInputSchema.safeParse({
    ...readRecord(input.probe),
    ...(directory ? { cwd: directory } : {}),
    ...(hasOwn(input, 'profileId') && input.profileId != null ? { profileId: input.profileId } : {}),
    ...(hasOwn(input, 'connectedServices') && input.connectedServices != null ? { connectedServices: input.connectedServices } : {}),
    ...(hasOwn(input, 'runtimeDescriptorV1') && input.runtimeDescriptorV1 != null ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
  });

  if (optionsSourceId === 'agents.models.available') {
    if (!deps.agentsModelsList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.models.list' };
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    // Configured model inventory is selected by definition, as on direct reads.
    // The installed routing id stays private to the host's probe adapter.
    const modelInventorySelection = actionId === 'session.spawn_new' && readRecord(input.agentTarget).definitionId !== undefined
      ? { backendTargetKey: selectionArgs.backendTargetKey } : selectionArgs;
    // Use the native producer for this exact launch context, including the selected
    // Connected Account. A generic inventory read has no such account binding.
    const probe = readInventoryProbe();
    if (!probe.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsModelsList({
      ...modelInventorySelection,
      ...(machineId === undefined ? {} : { machineId }),
      ...(serverId === undefined ? {} : { serverId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(params.includeSpawnModelCatalog ? { includeProviderProjection: true as const } : {}),
      ...(machineId ? { probe: probe.data } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    const connectedAccountSelected = Object.values(probe.data.connectedServices?.bindingsByServiceId ?? {})
      .some(selection => selection.source === 'connected');
    const observationSource = readRecord(result).source;
    const confidence = getConnectedAccountModelObservationConfidence(observationSource === 'dynamic' ? observationSource : undefined);
    const options = connectedAccountSelected && !isProviderSourceModelCatalogConfidenceUsable(confidence)
      ? [] : normalizeResolvedOptions(result);
    if (!params.includeSpawnModelCatalog) return { ok: true, result: options };
    const projection = DaemonProviderModelProjectionResponseV1Schema.safeParse(readRecord(result).providerProjection);
    return { ok: true, result: options, modelCatalog: {
      nativeModels: options.map(({ value, label, description }) => ({ value, label,
        ...(description === undefined ? {} : { description }) })),
      providerProjection: projection.success && projection.data.status === 'success' ? projection.data : null,
    } };
  }

  if (optionsSourceId === 'agents.session_modes.available') {
    if (!deps.agentsSessionModesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.session_modes.list' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    const result = await deps.agentsSessionModesList({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(serverId === undefined ? {} : { serverId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'agents.config_options.available') {
    if (!deps.agentsConfigOptionsList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.config_options.list' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    const probe = readInventoryProbe();
    if (!probe.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsConfigOptionsList({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(serverId === undefined ? {} : { serverId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(machineId ? { probe: probe.data } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.paths.recent') {
    if (!deps.pathsListRecent) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:paths.list_recent' };
    const result = await deps.pathsListRecent({
      ...(machineId === undefined ? {} : { machineId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    const pathOptions = normalizeResolvedOptions(result).flatMap((option) => {
      const intent = SessionDirectoryIntentV1Schema.safeParse({ kind: 'path', path: option.value });
      return intent.success ? [{ ...option, value: JSON.stringify(intent.data) }] : [];
    });
    return { ok: true, result: [
      { value: JSON.stringify(SessionDirectoryIntentV1Schema.parse({ kind: 'managed' })), label: 'No folder' },
      ...pathOptions,
    ] };
  }

  if (optionsSourceId === 'sessions.spawn.machines.available') {
    if (!deps.machinesList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:machines.list' };
    const voice = ctx.surface === 'voice';
    const result = await deps.machinesList({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      // A form's Machine picker reads the Home inventory with its told-apart names and presence, like the typed Machine input.
      ...(voice ? {} : { purpose: 'input' as const }),
    }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    if (voice) return { ok: true, result: normalizeResolvedOptions(result) };
    return { ok: true, result: readMachineChoices(result, (machine) => {
      const machineId = readNonEmptyString(machine.machineId) ?? readNonEmptyString(machine.id);
      return machineId ? { value: machineId, label: readNonEmptyString(machine.label) ?? machineId } : null;
    }) ?? [] };
  }

  if (optionsSourceId === 'sessions.spawn.servers.available') {
    if (!deps.serversList) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:servers.list' };
    const result = await deps.serversList({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.profiles.available') {
    if (!deps.spawnProfilesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.profiles.list' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({
      deps,
      actionId,
      input,
      agentScope: 'optional',
    });
    if ('ok' in selectionArgs) return selectionArgs;
    const result = await deps.spawnProfilesList({
      ...selectionArgs,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.connected_services.available') {
    if (!deps.spawnConnectedServicesList) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.connected_services.list' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    const result = await deps.spawnConnectedServicesList({
      ...selectionArgs,
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
      ...(typeof input.includeUnavailable === 'boolean' ? { includeUnavailable: input.includeUnavailable } : {}),
    }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.capabilities.preview') {
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    const selection = SessionCapabilitySelectionAuthoringV1Schema.safeParse(input.capabilitySelection === undefined ? {} : input.capabilitySelection);
    if (!selectionArgs.agentId || !machineId || !selection.success) {
      return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    // Preview owns Profile seed admission and the Machine projection. Options
    // replace the whole field, so the draft item writer preserves other choices.
    const { createActionExecutor } = await import('../actions/actionExecutor.js');
    const result = await createActionExecutor(deps).execute('sessions.spawn.capabilities.preview', {
      machineId,
      agentId: selectionArgs.agentId,
      ...(directory ? { directory } : {}),
      ...(hasOwn(input, 'profileId') ? { profileId: input.profileId } : {}),
      ...(hasOwn(input, 'capabilitySelection') ? { capabilitySelection: selection.data } : {}),
    }, serverId ? { ...ctx, serverId } : ctx);
    if (!result.ok) return result;
    const preview = SpawnCapabilitiesPreviewOutputV1Schema.parse(result.result);
    if (!preview.ok) return { ok: false, errorCode: preview.reason, error: preview.reason };
    return { ok: true, result: [...preview.mcp.items, ...preview.skills.items].map(item => ({
      value: setSessionCapabilitySelectionItemV1(selection.data, item.kind, item.id, 'on'),
      label: item.title ?? item.name,
      ...(item.selectable ? {} : { disabled: true }),
    })) };
  }

  if (optionsSourceId === 'sessions.spawn.mcp_servers.preview') {
    if (!deps.spawnMcpServersPreview) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if ('ok' in selectionArgs) return selectionArgs;
    const result = await deps.spawnMcpServersPreview({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(directory ? { directory } : {}),
      ...(actionId === 'session.spawn_new'
        ? (hasOwn(input, 'capabilitySelection') ? { selection: readCapabilitySelectionCarrierV1(input)?.mcp } : {})
        : (hasOwn(input, 'selection') ? { selection: input.selection } : {})),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    }, ctx);
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  return { ok: false, errorCode: 'options_source_not_supported', error: 'options_source_not_supported' };
}
