import {
  PluginError,
} from '@happier-dev/plugin-sdk';
import type {
  ComposerReferenceResolutionV1,
  HookEventEnvelopeV1,
  PluginAgentCompositionResultV1,
  PluginContributionIdentityV1,
  PromptBlockV1,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

type HookPayload = Record<string, unknown>;
type HookRuntimeRegistry = Parameters<typeof dispatchPluginHookEvent>[0]['runtimeRegistry'];

export type ToolPromptContribution = Readonly<{
  pluginId: string;
  id: string;
  name?: string | null;
  title?: string | null;
  promptSnippet?: string | null;
  promptGuidelines?: readonly string[] | null;
}>;

/**
 * The one active next-turn tool selection. The provider loop owns its lifetime;
 * the existing native MCP bridge consumes it when registering this turn's tools.
 */
export type AgentCompositionToolSelection = Readonly<{
  /** Plugins whose valid composition result is consumed for this next turn. */
  managedPluginIds: readonly string[];
  /** Exact projected plugin tools admitted for composition-managed plugins. */
  selectedTools: readonly PluginContributionIdentityV1[];
  /**
   * Immutable executable descriptors admitted with this turn. These are a
   * turn-local selection snapshot, not another current catalog: MCP uses the
   * descriptor for listing and carries its immutable generation to the daemon
   * action owner for execution currentness.
   */
  selectedToolBindings: readonly AgentCompositionSelectedToolBinding[];
}>;

export type AgentCompositionSelectedToolBinding = Readonly<{
  tool: ProjectedPluginToolCatalogEntry;
  expectedContributorImmutableGenerationId: string;
}>;

export type AgentCompositionResolution = AgentCompositionToolSelection & Readonly<{
  toolPromptContributions: readonly ToolPromptContribution[];
  promptAssetBlocks: readonly PromptBlockV1[];
  additionalInstructions: readonly Readonly<{
    pluginId: string;
    text: string;
  }>[];
}>;

type AgentCompositionRuntimeRegistry = HookRuntimeRegistry & Pick<
  ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'targetActionInvocations' | 'resolvePromptAssetBlocks'
>;

const AGENT_TRANSFORM_HOOK_TIMEOUT_MS = 2_000;
const AGENT_STREAM_TOKEN_HOOK_TIMEOUT_MS = 100;
const AGENT_COMPOSITION_HANDLER_TIMEOUT_MS = 1_000;
const AGENT_COMPOSITION_AGGREGATE_TIMEOUT_MS = 3_000;
const MAX_AGENT_COMPOSITION_INSTRUCTIONS_PER_PLUGIN_BYTES = 8 * 1024;
const MAX_AGENT_COMPOSITION_INSTRUCTION_BYTES = 32 * 1024;

function isRecord(value: unknown): value is HookPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : undefined;
}

function readLocalizedString(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

function readTimestampMs(payload: HookPayload): number {
  const timestampMs = payload.timestampMs;
  return typeof timestampMs === 'number' && Number.isFinite(timestampMs) && timestampMs >= 0
    ? Math.trunc(timestampMs)
    : Date.now();
}

function buildHookEnvelope(params: Readonly<{
  eventId: HookEventEnvelopeV1['eventId'];
  category: HookEventEnvelopeV1['category'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
}>): HookEventEnvelopeV1 {
  const sessionId = readOptionalString(params.payload.sessionId);
  const agentId = readOptionalString(params.payload.agentId);
  const turnId = readOptionalString(params.payload.turnId);
  return {
    hookVersion: 1,
    eventId: params.eventId,
    category: params.category,
    scope: params.scope,
    ...(sessionId ? { happySessionId: sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(turnId ? { turnId } : {}),
    timestampMs: readTimestampMs(params.payload),
    payload: params.payload,
  };
}

async function dispatchTransformHookWithRuntimeRegistry(params: Readonly<{
  runtimeRegistry: HookRuntimeRegistry;
  eventId: HookEventEnvelopeV1['eventId'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
  signal?: AbortSignal;
}>): Promise<HookPayload> {
  const result = await dispatchPluginHookEvent({
    runtimeRegistry: params.runtimeRegistry,
    event: buildHookEnvelope({
      eventId: params.eventId,
      category: 'augmentation',
      scope: params.scope,
      payload: params.payload,
    }),
    handlerTimeoutMs: AGENT_TRANSFORM_HOOK_TIMEOUT_MS,
    ...(params.signal ? { context: { signal: params.signal } } : {}),
  });
  const transformed = result.aggregate?.result;
  return isRecord(transformed) ? transformed : params.payload;
}

export async function transformAgentContextThroughPluginRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  return await dispatchTransformHookWithRuntimeRegistry({
    runtimeRegistry,
    eventId: 'agent.context.before',
    scope: 'agent',
    payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

async function dispatchTransformHook(params: Readonly<{
  eventId: HookEventEnvelopeV1['eventId'];
  scope: HookEventEnvelopeV1['scope'];
  payload: HookPayload;
  signal?: AbortSignal;
}>): Promise<HookPayload> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return await dispatchTransformHookWithRuntimeRegistry({
      runtimeRegistry: lease.registry,
      eventId: params.eventId,
      scope: params.scope,
      payload: params.payload,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    logger.debug('[plugins] Plugin transform hook dispatch failed; using prior payload', {
      hookId: params.eventId,
      error: 'plugin_hook_dispatch_failed',
    });
    return params.payload;
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after hook dispatch', {
          hookId: params.eventId,
          error: 'plugin_hook_registry_release_failed',
        });
      });
    }
  }
}

export async function transformSessionInputThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'session.input.transform',
    scope: 'session',
    payload,
  });
}

export async function transformSessionInputThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  return await dispatchTransformHookWithRuntimeRegistry({
    runtimeRegistry,
    eventId: 'session.input.transform',
    scope: 'session',
    payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export async function transformAgentContextThroughPluginHooks(payload: HookPayload): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'agent.context.before',
    scope: 'agent',
    payload,
  });
}

export async function transformAgentRequestThroughPluginHooks(
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  return await dispatchTransformHook({
    eventId: 'agent.request.before',
    scope: 'agent',
    payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export async function transformAgentRequestThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<HookPayload> {
  try {
    return await dispatchTransformHookWithRuntimeRegistry({
      runtimeRegistry,
      eventId: 'agent.request.before',
      scope: 'agent',
      payload,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    logger.debug('[plugins] Plugin ACP request hook dispatch failed; using prior payload');
    return payload;
  }
}

export async function observeAgentStreamTokenThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry,
  payload: HookPayload,
): Promise<void> {
  await dispatchPluginHookEvent({
    runtimeRegistry,
    event: buildHookEnvelope({
      eventId: 'agent.stream.token',
      category: 'lifecycle',
      scope: 'agent',
      payload,
    }),
    handlerTimeoutMs: AGENT_STREAM_TOKEN_HOOK_TIMEOUT_MS,
  });
}

export async function observeAgentStreamTokenThroughPluginHooks(payload: HookPayload): Promise<void> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    await observeAgentStreamTokenThroughRuntimeRegistry(lease.registry, payload);
  } catch {
    logger.debug('[plugins] Plugin stream token hook dispatch failed (non-fatal)');
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after stream token hook dispatch');
      });
    }
  }
}

export async function resolvePluginToolPromptContributions(
  options?: Readonly<{ excludePluginIds?: readonly string[] }>,
): Promise<readonly ToolPromptContribution[]> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return resolvePluginToolPromptContributionsThroughRuntimeRegistry(
      lease.registry,
      options,
    );
  } catch {
    logger.debug('[plugins] Failed to resolve plugin tool prompt contributions');
    return Object.freeze([]);
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after tool prompt resolution');
      });
    }
  }
}

export function resolvePluginToolPromptContributionsThroughRuntimeRegistry(
  runtimeRegistry: HookRuntimeRegistry & Readonly<{
    contributes: Readonly<{
      tools?: readonly Readonly<{
        pluginId?: string;
        definition: Readonly<{
          id: string;
          name?: string | null;
          title: string | Readonly<{ fallback: string }>;
          promptSnippet?: string | null;
          promptGuidelines?: readonly string[] | null;
        }>;
      }>[];
    }>;
  }>,
  options?: Readonly<{ excludePluginIds?: readonly string[] }>,
): readonly ToolPromptContribution[] {
  const excludedPluginIds = new Set(options?.excludePluginIds ?? []);
  return Object.freeze((runtimeRegistry.contributes.tools ?? [])
    .flatMap((tool) => {
      const pluginId = readOptionalString(tool.pluginId);
      const definition = tool.definition;
      if (
        !pluginId
        || excludedPluginIds.has(pluginId)
        || (!definition.promptSnippet && (definition.promptGuidelines?.length ?? 0) === 0)
      ) {
        return [];
      }
      return [Object.freeze({
        pluginId,
        id: definition.id,
        name: definition.name,
        title: readLocalizedString(definition.title),
        promptSnippet: definition.promptSnippet ?? null,
        promptGuidelines: definition.promptGuidelines ?? null,
      })];
    }));
}

export async function resolvePluginPromptAssetBlocks(params: Readonly<{
  agentId: string;
  selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
  sessionId?: string;
  machineId?: string;
  featureIds?: readonly string[];
  excludePluginIds?: readonly string[];
  signal?: AbortSignal;
}>): Promise<readonly import('@happier-dev/protocol').PromptBlockV1[]> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return await lease.registry.resolvePromptAssetBlocks(params);
  } finally {
    await lease.release();
  }
}

function qualifiedContributionKey(pluginId: string, localId: string): string {
  return `${pluginId}\0${localId}`;
}

function resolveAvailableAgentToolIds(params: Readonly<{
  runtimeRegistry: AgentCompositionRuntimeRegistry;
  pluginId: string;
  agentId: string;
}>): readonly string[] {
  if (resolveAgentToolsDelivery(params.agentId) !== 'native_mcp') {
    return Object.freeze([]);
  }
  const availableToolIds = new Set(
    projectExecutablePluginToolCatalog(params.runtimeRegistry)
      .filter((tool) => tool.surfaces.includes('agent'))
      .map((tool) => tool.toolId),
  );
  return Object.freeze((params.runtimeRegistry.contributes.tools ?? []).flatMap((tool) => (
    tool.pluginId === params.pluginId
    && tool.definition.surfaces.includes('agent')
    && availableToolIds.has(`${params.pluginId}/${tool.definition.id}`)
      ? [tool.definition.id]
      : []
  )).slice(0, 128));
}

function resolvePromptAssetTarget(params: Readonly<{
  pluginId: string;
  reference: string | Readonly<{ pluginId: string; localId: string }>;
}>): Readonly<{ pluginId: string; localId: string }> {
  return typeof params.reference === 'string'
    ? { pluginId: params.pluginId, localId: params.reference }
    : params.reference;
}

function resolveCurrentPluginAgentIdentity(params: Readonly<{
  runtimeRegistry: AgentCompositionRuntimeRegistry;
  agentId: string;
}>): Readonly<{ pluginId: string; localId: string }> | null {
  const matches = (params.runtimeRegistry.contributes.agents ?? []).filter((agent) => (
    agent.id === params.agentId && typeof agent.pluginId === 'string' && agent.pluginId.length > 0
  ));
  if (matches.length !== 1) return null;
  return Object.freeze({
    pluginId: matches[0]!.pluginId!,
    localId: matches[0]!.definition.id,
  });
}

function resolveApplicablePromptAssetIds(params: Readonly<{
  runtimeRegistry: AgentCompositionRuntimeRegistry;
  pluginId: string;
  agentId: string;
}>): readonly string[] {
  const agent = resolveCurrentPluginAgentIdentity({
    runtimeRegistry: params.runtimeRegistry,
    agentId: params.agentId,
  });
  if (!agent) return Object.freeze([]);
  return Object.freeze((params.runtimeRegistry.contributes.promptAssets ?? []).flatMap((asset) => {
    if (asset.pluginId !== params.pluginId) return [];
    const target = resolvePromptAssetTarget({
      pluginId: asset.pluginId,
      reference: asset.definition.target.agent,
    });
    return target.pluginId === agent.pluginId && target.localId === agent.localId
      ? [asset.definition.id]
      : [];
  }).slice(0, 128));
}

function buildAgentCompositionEnvelope(params: Readonly<{
  sessionId: string;
  agentId: string;
  runtimeFamily: 'hostSession' | 'acpSession';
}>): HookEventEnvelopeV1 {
  return buildHookEnvelope({
    eventId: 'agent.composition.resolve',
    category: 'augmentation',
    scope: 'agent',
    payload: {
      sessionId: params.sessionId,
      agentId: params.agentId,
      runtimeFamily: params.runtimeFamily,
      declaredToolIds: [],
      declaredPromptAssetIds: [],
    },
  });
}

function buildHandlerScopedCompositionEnvelope(params: Readonly<{
  handler: ResolvedPluginHookHandler;
  envelope: HookEventEnvelopeV1;
  runtimeRegistry: AgentCompositionRuntimeRegistry;
}>): HookEventEnvelopeV1 {
  const payload = isRecord(params.envelope.payload) ? params.envelope.payload : {};
  const agentId = readOptionalString(payload.agentId);
  return Object.freeze({
    ...params.envelope,
    payload: Object.freeze({
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      runtimeFamily: payload.runtimeFamily,
      declaredToolIds: resolveAvailableAgentToolIds({
        runtimeRegistry: params.runtimeRegistry,
        pluginId: params.handler.pluginId,
        agentId: agentId ?? '',
      }),
      declaredPromptAssetIds: agentId ? resolveApplicablePromptAssetIds({
        runtimeRegistry: params.runtimeRegistry,
        pluginId: params.handler.pluginId,
        agentId,
      }) : [],
    }),
  });
}

function isDeclaredCompositionSelection(params: Readonly<{
  selected: readonly string[] | undefined;
  declared: readonly string[];
}>): boolean {
  if (params.selected === undefined) return true;
  const declared = new Set(params.declared);
  return params.selected.every((id) => declared.has(id));
}

function readCompositionResult(value: unknown): PluginAgentCompositionResultV1 | null {
  return isRecord(value) ? value as PluginAgentCompositionResultV1 : null;
}

function selectedCompositionIds(params: Readonly<{
  selected: readonly string[] | undefined;
  declared: readonly string[];
}>): readonly string[] {
  return Object.freeze(params.selected === undefined ? [...params.declared] : [...params.selected]);
}

function deepFreezeTurnSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreezeTurnSnapshot(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function snapshotSelectedTool(tool: ProjectedPluginToolCatalogEntry): ProjectedPluginToolCatalogEntry {
  // The provider turn outlives the registry lease. Copy and freeze the bounded
  // projection before release so a reload or retained author object cannot
  // mutate this turn's advertised executable descriptor.
  return deepFreezeTurnSnapshot(structuredClone(tool));
}

function readAdditionalInstructionBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Resolves one next-turn Agent composition through the existing hook, action,
 * Resource, and prompt owners. It does not own a tool registry, persistence,
 * provider request mutation, or a Session lifecycle.
 */
export async function resolveAgentCompositionThroughRuntimeRegistry(
  runtimeRegistry: AgentCompositionRuntimeRegistry,
  params: Readonly<{
    sessionId: string;
    agentId: string;
    runtimeFamily: 'hostSession' | 'acpSession';
    machineId?: string;
    featureIds?: readonly string[];
    projectId?: string;
    signal?: AbortSignal;
  }>,
): Promise<AgentCompositionResolution> {
  const envelope = buildAgentCompositionEnvelope(params);
  let dispatch: Awaited<ReturnType<typeof dispatchPluginHookEvent>>;
  try {
    dispatch = await dispatchPluginHookEvent({
      runtimeRegistry,
      event: envelope,
      ...(params.signal ? { context: { signal: params.signal } } : {}),
      handlerTimeoutMs: AGENT_COMPOSITION_HANDLER_TIMEOUT_MS,
      aggregateTimeoutMs: AGENT_COMPOSITION_AGGREGATE_TIMEOUT_MS,
      dispatchMode: 'concurrent',
      buildHandlerEvent: ({ handler, envelope: event }) => buildHandlerScopedCompositionEnvelope({
        handler,
        envelope: event,
        runtimeRegistry,
      }),
    });
  } catch (error) {
    if (params.signal?.aborted) throw error;
    logger.debug('[plugins] Agent composition dispatch failed; preserving the static prompt contribution path', {
      error: 'agent_composition_dispatch_failed',
    });
    return emptyAgentCompositionResolution();
  }
  const handlers = runtimeRegistry.hookHandlersByHookId.get('agent.composition.resolve') ?? [];
  const selectedToolKeys = new Set<string>();
  const selectedAssetRefs = new Map<string, Readonly<{ pluginId: string; localId: string }>>();
  const additionalInstructions: Array<Readonly<{ pluginId: string; text: string }>> = [];
  const managedPluginIds = new Set<string>();
  const instructionBytesByPluginId = new Map<string, number>();
  let aggregateInstructionBytes = 0;

  for (const outcome of dispatch.outcomes) {
    const handler = handlers.find((candidate) => (
      candidate.pluginId === outcome.pluginId
      && candidate.localId === outcome.localId
    ));
    if (!handler || outcome.status !== 'fulfilled') continue;
    const result = readCompositionResult(outcome.result);
    if (!result) continue;
    const declaredToolIds = resolveAvailableAgentToolIds({
      runtimeRegistry,
      pluginId: handler.pluginId,
      agentId: params.agentId,
    });
    const declaredPromptAssetIds = resolveApplicablePromptAssetIds({
      runtimeRegistry,
      pluginId: handler.pluginId,
      agentId: params.agentId,
    });
    if (!isDeclaredCompositionSelection({ selected: result.enabledToolIds, declared: declaredToolIds })
      || !isDeclaredCompositionSelection({ selected: result.enabledPromptAssetIds, declared: declaredPromptAssetIds })) {
      logger.debug('[plugins] Ignoring Agent composition result with foreign or undeclared ids', {
        pluginId: handler.pluginId,
        hookId: handler.hookId,
      });
      continue;
    }
    managedPluginIds.add(handler.pluginId);
    for (const localId of selectedCompositionIds({
      selected: result.enabledToolIds,
      declared: declaredToolIds,
    })) {
      selectedToolKeys.add(qualifiedContributionKey(handler.pluginId, localId));
    }
    for (const localId of selectedCompositionIds({
      selected: result.enabledPromptAssetIds,
      declared: declaredPromptAssetIds,
    })) {
      const selectedAsset = Object.freeze({ pluginId: handler.pluginId, localId });
      selectedAssetRefs.set(
        qualifiedContributionKey(handler.pluginId, localId),
        selectedAsset,
      );
    }
    if (result.additionalInstructions) {
      const bytes = readAdditionalInstructionBytes(result.additionalInstructions);
      const pluginInstructionBytes = instructionBytesByPluginId.get(handler.pluginId) ?? 0;
      if (
        pluginInstructionBytes + bytes <= MAX_AGENT_COMPOSITION_INSTRUCTIONS_PER_PLUGIN_BYTES
        && aggregateInstructionBytes + bytes <= MAX_AGENT_COMPOSITION_INSTRUCTION_BYTES
      ) {
        instructionBytesByPluginId.set(handler.pluginId, pluginInstructionBytes + bytes);
        aggregateInstructionBytes += bytes;
        additionalInstructions.push(Object.freeze({
          pluginId: handler.pluginId,
          text: result.additionalInstructions,
        }));
      }
    }
  }

  params.signal?.throwIfAborted();
  const availableTools = projectExecutablePluginToolCatalog(runtimeRegistry)
    .filter((tool) => tool.surfaces.includes('agent'));
  const selectedTools = Object.freeze(availableTools.flatMap((tool) => {
    const separatorIndex = tool.toolId.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === tool.toolId.length - 1) return [];
    const pluginId = tool.toolId.slice(0, separatorIndex);
    const localId = tool.toolId.slice(separatorIndex + 1);
    return selectedToolKeys.has(qualifiedContributionKey(pluginId, localId))
      ? [Object.freeze({ pluginId, localId })]
      : [];
  }));
  const selectedToolBindings = Object.freeze(availableTools.flatMap((tool) => {
    const separatorIndex = tool.toolId.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex === tool.toolId.length - 1) return [];
    const pluginId = tool.toolId.slice(0, separatorIndex);
    const localId = tool.toolId.slice(separatorIndex + 1);
    if (!selectedToolKeys.has(qualifiedContributionKey(pluginId, localId))) return [];
    const immutableGenerationId = runtimeRegistry.contributes
      .immutableGenerationIdsByPluginId?.[pluginId]?.trim();
    // A partial registry must never turn an unbound local id into a live MCP
    // tool. The canonical executable registry always stamps this fact.
    if (!immutableGenerationId) return [];
    return [Object.freeze({
      tool: snapshotSelectedTool(tool),
      expectedContributorImmutableGenerationId: immutableGenerationId,
    })];
  }));
  const promptContributionsByKey = new Map(
    resolvePluginToolPromptContributionsThroughRuntimeRegistry(runtimeRegistry)
      .map((tool) => [qualifiedContributionKey(tool.pluginId, tool.id), tool] as const),
  );
  const toolPromptContributions = Object.freeze(selectedTools.flatMap((tool) => {
    const key = qualifiedContributionKey(tool.pluginId, tool.localId);
    const contribution = promptContributionsByKey.get(key);
    return contribution ? [contribution] : [];
  }));
  const promptAssetBlocks = (await Promise.all([...selectedAssetRefs.values()].map(async (selectedAsset) => {
    try {
      return await runtimeRegistry.resolvePromptAssetBlocks({
        agentId: params.agentId,
        sessionId: params.sessionId,
        selectedAsset,
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(params.featureIds ? { featureIds: params.featureIds } : {}),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (params.signal?.aborted) throw error;
      logger.debug('[plugins] Ignoring unavailable Agent composition prompt asset', {
        pluginId: selectedAsset.pluginId,
        localId: selectedAsset.localId,
        error: 'prompt_asset_unavailable',
      });
      return Object.freeze([]) as readonly PromptBlockV1[];
    }
  }))).flat();
  return Object.freeze({
    managedPluginIds: Object.freeze([...managedPluginIds]),
    selectedTools,
    selectedToolBindings,
    toolPromptContributions,
    promptAssetBlocks: Object.freeze([...promptAssetBlocks]),
    additionalInstructions: Object.freeze(additionalInstructions),
  });
}

function emptyAgentCompositionResolution(): AgentCompositionResolution {
  return Object.freeze({
    managedPluginIds: Object.freeze([]),
    selectedTools: Object.freeze([]),
    selectedToolBindings: Object.freeze([]),
    toolPromptContributions: Object.freeze([]),
    promptAssetBlocks: Object.freeze([]),
    additionalInstructions: Object.freeze([]),
  });
}

/**
 * Direct-runtime composition reads the canonical registry under one lease.
 * Plugin-local failures preserve the static prompt path; cancellation still
 * reaches the turn owner rather than being reclassified as a plugin failure.
 */
export async function resolveAgentCompositionThroughPluginHooks(params: Readonly<{
  sessionId: string;
  agentId: string;
  runtimeFamily: 'hostSession' | 'acpSession';
  machineId?: string;
  featureIds?: readonly string[];
  projectId?: string;
  signal?: AbortSignal;
}>): Promise<AgentCompositionResolution> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return await resolveAgentCompositionThroughRuntimeRegistry(lease.registry, params);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    logger.debug('[plugins] Agent composition failed; preserving the prior prompt contribution path', {
      error: 'agent_composition_failed',
    });
    return emptyAgentCompositionResolution();
  } finally {
    if (lease) {
      await lease.release().catch(() => {
        logger.debug('[plugins] Failed to release plugin runtime registry lease after Agent composition');
      });
    }
  }
}

/**
 * Resolves through the currently leased canonical target-registration adapter.
 * The caller owns prompt delivery; this helper owns no reference persistence,
 * provider selection, or fallback registry.
 */
export async function resolvePluginComposerReferenceThroughRuntimeRegistry(
  runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'composerReferences'>,
  params: Readonly<{
    reference: PluginContributionIdentityV1;
    candidateId: string;
    signal: AbortSignal;
  }>,
): Promise<ComposerReferenceResolutionV1> {
  const references = runtimeRegistry.composerReferences;
  if (!references) {
    throw new PluginError({
      code: 'composer_reference_unavailable',
      message: 'Composer references are unavailable',
    });
  }
  return await references.resolve(params);
}

export async function resolvePluginComposerReference(params: Readonly<{
  reference: PluginContributionIdentityV1;
  candidateId: string;
  signal: AbortSignal;
}>): Promise<ComposerReferenceResolutionV1> {
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    return await resolvePluginComposerReferenceThroughRuntimeRegistry(lease.registry, params);
  } finally {
    await lease.release();
  }
}
