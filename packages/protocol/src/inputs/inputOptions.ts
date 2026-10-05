import type { ActionExecutorDeps, ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionId } from '../actions/actionIds.js';
import type { PublicActionResultById } from '../actions/actionSpecs.js';
import { parseWorkflowDefinitionRefV1, formatWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionRefV1.js';
import { DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { SessionDirectoryIntentV1Schema } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { resolveReviewNarratorPolicy, ReviewEngineCapabilitiesSchema } from '../reviews/reviewEngines.js';
import { resolveActionBackendTargetSelection, resolveExecutionBackendTargetSelectionForValue, type ActionBackendTargetSelection } from '../actions/resolveActionBackendTargetSelection.js';
import { readRecord, readRecordListProperty, readNonEmptyString, isRecord, hasOwn } from './inputRecords.js';
import { projectInputOptionsDependencies } from './inputOptionsDependencies.js';
import { parseInputTypeOptionsSourceId } from './inputTypes.js';
import { resolveInputTypeOptions } from './inputTypeRuntime.js';
import type { InputOption } from './inputFields.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { parseSessionAwarenessListResultV1 } from '../sessions/awareness/action.js';
import { isSessionAwarenessContentReadableV1 } from '../sessions/awareness/availability.js';
import { readSessionAwarenessWorkStatusV1, readSessionWorkStateGroupV1 } from '../sessions/awareness/presentationV1.js';

export function normalizeResolvedOptions(value: unknown): readonly Readonly<{ value: string; label: string; description?: string; disabled?: boolean }>[] {
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
            : typeof item?.path === 'string'
              ? item.path
              : typeof item?.agentId === 'string'
                ? item.agentId
                : typeof item?.engineId === 'string'
                  ? item.engineId
                  : null;
      if (!valueCandidate) return null;
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

export function tryNormalizeExecutionBackendOptionValue(value: string): string | null {
  return resolveExecutionBackendTargetSelectionForValue(value)?.backendTargetKey ?? null;
}

export function readReviewNarratorOptions(value: unknown) {
  const items = readRecordListProperty(value, 'items').length > 0
    ? readRecordListProperty(value, 'items')
    : Array.isArray(value) ? value.filter(isRecord) : [];
  return items.flatMap((item) => {
    const capability = ReviewEngineCapabilitiesSchema.safeParse(item.capabilities);
    return normalizeResolvedOptions([item]).map((option) => ({
      ...option,
      value: tryNormalizeExecutionBackendOptionValue(option.value) ?? option.value,
      capabilities: capability.success ? capability.data : { structuredNarration: false },
    }));
  });
}

function resolveAgentInventorySelection(
  input: Record<string, unknown>,
  agentScope: 'required' | 'optional',
): ActionBackendTargetSelection | null {
  const resolvedSelection = resolveActionBackendTargetSelection({
    agentId: typeof input.agentId === 'string' ? input.agentId : undefined,
    backendTargetKey: typeof input.backendTargetKey === 'string' ? input.backendTargetKey : undefined,
  });
  if (!resolvedSelection.ok) return null;
  const selection = resolvedSelection.selection;
  if (!selection.agentId && !selection.backendTargetKey && agentScope === 'required') return null;
  return selection;
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
}>): Promise<Readonly<{ agentId?: string; backendTargetKey?: string }> | null> {
  const { deps, actionId, input } = params;
  const agentScope = params.agentScope ?? 'required';
  if (actionId === 'session.spawn_new') {
    const agentTarget = AgentExecutionTargetV1Schema.safeParse(input.agentTarget);
    if (!agentTarget.success) return agentScope === 'optional' ? {} : null;
    const machineId = readDynamicOptionMachineId(input, actionId);
    const serverId = readNonEmptyString(readRecord(input.executionTarget).serverId);
    return await deps.resolveSessionSpawnAgentInventorySelection?.({
      agentTarget: agentTarget.data,
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
    })
      ?? (agentScope === 'optional' ? {} : null);
  }

  const selection = resolveAgentInventorySelection(input, agentScope);
  if (!selection) return null;
  return {
    ...(selection.agentId ? { agentId: selection.agentId } : {}),
    ...(selection.backendTargetKey ? { backendTargetKey: selection.backendTargetKey } : {}),
  };
}

function readDynamicOptionMachineId(
  input: Record<string, unknown>,
  actionId: ActionId | null,
): string | undefined {
  if (actionId === 'session.spawn_new') {
    return readNonEmptyString(readRecord(input.executionTarget).machineId);
  }
  return typeof input.machineId === 'string' ? input.machineId : undefined;
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

export async function resolveInputOptions(params: Readonly<{
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  actionId: ActionId | null;
  optionsSourceId: string;
  input: Record<string, unknown>;
  includeSpawnModelCatalog?: boolean;
  readFailure: (result: unknown) => Extract<ActionExecuteResult, { ok: false }> | null;
  resolveSessionId: (input: unknown, ctx: ActionExecutorContext) => string | null;
  reviewScope: (input: unknown) => 'paths' | undefined;
}>): Promise<Extract<ActionExecuteResult, { ok: false }> | Readonly<{
  ok: true;
  result: readonly InputOption[];
  optionsSourceId?: null;
  modelCatalog?: NonNullable<PublicActionResultById['action.options.resolve']['modelCatalog']>;
}>> {
  const { deps, ctx, actionId, optionsSourceId } = params;
  const input = projectInputOptionsDependencies(params.input);
  const machineId = readDynamicOptionMachineId(input, actionId);
  const serverId = actionId === 'session.spawn_new'
    ? readNonEmptyString(readRecord(input.executionTarget).serverId)
    : readNonEmptyString(ctx.serverId);
  const modelId = readDynamicOptionModelId(input, actionId);
  const directory = readDynamicOptionDirectory(input, actionId);

  const inputTypeIdentity = parseInputTypeOptionsSourceId(optionsSourceId);
  if (inputTypeIdentity) {
    const sessionId = params.resolveSessionId(input, ctx);
    return resolveInputTypeOptions({ deps, ctx, identity: inputTypeIdentity, readFailure: params.readFailure,
      ...(sessionId ? { sessionId } : {}) });
  }

  if (optionsSourceId === 'sessions') {
    const sessionServerId = readNonEmptyString(ctx.serverId);
    if (!sessionServerId) return { ok: false, errorCode: 'server_not_selected', error: 'server_not_selected' };
    // Enter through the existing Action owner so credential grants, the caller's
    // admitted corpus and marked-query admission also govern option discovery.
    const { createActionExecutor } = await import('../actions/actionExecutor.js');
    const executor = createActionExecutor(deps);
    const groups: Record<'needsYou' | 'working' | 'recent', InputOption[]> = { needsYou: [], working: [], recent: [] };
    const groupLabels = { needsYou: 'Needs you', working: 'Working', recent: 'Recent' } as const;
    let cursor: string | undefined;
    do {
      ctx.signal?.throwIfAborted();
      const result = await executor.execute('session.list', { view: 'awareness', query: {
        v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: [], tagIds: [], includeAttention: false,
        ...(cursor ? { cursor } : {}),
      } }, ctx);
      if (!result.ok) return result;
      const page = parseSessionAwarenessListResultV1(result.result);
      if (!page || (page.hasNext && !page.nextCursor)) {
        return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      }
      for (const session of page.sessions) {
        const readable = isSessionAwarenessContentReadableV1(session.encryption);
        const group = readSessionWorkStateGroupV1(readSessionAwarenessWorkStatusV1({ awareness: session }).bucket);
        groups[group].push({
          value: VoiceTrackedSessionAddressV1Schema.parse({ serverId: sessionServerId, sessionId: session.sessionId }),
          label: readable ? session.title ?? session.sessionId : session.sessionId,
          description: groupLabels[group],
          ...(!readable ? { disabled: true } : {}),
        });
      }
      cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
    } while (cursor);
    ctx.signal?.throwIfAborted();
    return { ok: true, result: [...groups.needsYou, ...groups.working, ...groups.recent] };
  }

  if (optionsSourceId === 'workflows.references.available') {
    if (!deps.workflowAction) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:workflows.references.available' };
    }
    const [{ WorkflowDefinitionListResultV1Schema }, { getBuiltinWorkflowCatalogV1 }, { resolveWorkflowDefinitionRefV1 }] = await Promise.all([
      import('../workflows/actionsV1.js'), import('../workflows/builtins/catalog.js'), import('../workflows/workflowDefinitionResolverV1.js'),
    ]);
    const options: Array<{ value: string; label: string }> = [];
    let cursor: string | undefined;
    do {
      ctx.signal?.throwIfAborted();
      const result = await deps.workflowAction({ actionId: 'workflow.definition.list',
        input: cursor ? { cursor } : {}, context: ctx });
      const failure = params.readFailure(result);
      if (failure) return failure;
      const page = WorkflowDefinitionListResultV1Schema.parse(result);
      for (const plugin of page.pluginWorkflows ?? []) {
        options.push({ value: plugin.workflow, label: plugin.title });
      }
      for (const definition of page.definitions) {
        // Run source.workflow is the catalog arm; saved Runs require an exact
        // Artifact revision through source.definitionId instead.
        const ref = parseWorkflowDefinitionRefV1(definition.definitionId);
        if (actionId !== 'workflow.run.start' && ref?.kind === 'artifact') {
          options.push({ value: formatWorkflowDefinitionRefV1(ref), label: definition.metadata.title });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const entry of getBuiltinWorkflowCatalogV1()) {
      const resolved = await resolveWorkflowDefinitionRefV1(entry.id, { signal: ctx.signal });
      if (resolved?.kind === 'catalog') {
        options.push({ value: resolved.ref, label: entry.id });
      }
    }
    return { ok: true, result: options };
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
    const sessionId = params.resolveSessionId(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.reviewEnginesList({
      sessionId,
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
    const sessionId = params.resolveSessionId(input, ctx);
    if (!sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    const result = await deps.sessionModesList({ sessionId });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'agents.models.available') {
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsModelsList({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(serverId === undefined ? {} : { serverId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(params.includeSpawnModelCatalog ? { includeProviderProjection: true as const } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    const options = normalizeResolvedOptions(result);
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
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.agentsConfigOptionsList({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(serverId === undefined ? {} : { serverId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.paths.recent') {
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
    const result = await deps.machinesList({
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.servers.available') {
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
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
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
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const machineId = readDynamicOptionMachineId(input, actionId);
    const result = await deps.spawnConnectedServicesList({
      ...selectionArgs,
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
      ...(typeof input.includeUnavailable === 'boolean' ? { includeUnavailable: input.includeUnavailable } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  if (optionsSourceId === 'sessions.spawn.mcp_servers.preview') {
    if (!deps.spawnMcpServersPreview) {
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.spawn.mcp_servers.preview' };
    }
    const selectionArgs = await buildAgentInventorySelectionArgs({ deps, actionId, input });
    if (!selectionArgs) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const result = await deps.spawnMcpServersPreview({
      ...selectionArgs,
      ...(machineId === undefined ? {} : { machineId }),
      ...(directory ? { directory } : {}),
      ...(actionId === 'session.spawn_new'
        ? (hasOwn(input, 'mcpSelection') ? { selection: input.mcpSelection } : {})
        : (hasOwn(input, 'selection') ? { selection: input.selection } : {})),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    });
    const failure = params.readFailure(result);
    if (failure) return failure;
    return { ok: true, result: normalizeResolvedOptions(result) };
  }

  return { ok: false, errorCode: 'options_source_not_supported', error: 'options_source_not_supported' };
}
