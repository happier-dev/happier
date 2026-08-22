import { randomUUID } from 'node:crypto';

import {
  readProviderSessionIdSessionState,
} from '@happier-dev/agents';
import {
  type AgentSessionControlContext,
  type AgentSessionGoalMutation,
  type AgentSessionRuntimeFactory,
  type AgentSessionUsageLimitRecoveryResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { WorkStatePublisher } from '@happier-dev/plugin-sdk/sessions/work-state';

import type { Metadata } from '@/api/types';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { SessionCatalogControlAdapterParams } from '@/session/catalogControls/sessionCatalogControlTypes';
import type {
  SessionGoalControlAdapter,
  SessionGoalControlAdapterParams,
} from '@/session/goalControls/sessionGoalControlTypes';
import type {
  SessionUsageLimitRecoveryBackoffPolicy,
  SessionUsageLimitRecoveryControlAdapterParams,
  SessionUsageLimitRecoveryReadinessProbeResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import {
  createBackoffSessionUsageLimitRecoveryControlAdapter,
} from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';

type RuntimeRegistryLease = PluginRuntimeRegistryLease;
type InactiveControlAdapterParams =
  | SessionGoalControlAdapterParams
  | SessionCatalogControlAdapterParams
  | SessionUsageLimitRecoveryControlAdapterParams;

type NativeInactiveOperation =
  | 'goal.get'
  | 'goal.set'
  | 'goal.clear'
  | 'catalog.vendorPlugins'
  | 'catalog.skills'
  | 'usage.checkNow'
  | 'usage.consumeResetCredit';

type NativeInvocationResolution =
  | Readonly<{
      kind: 'native';
      context: AgentSessionControlContext;
      factory: AgentSessionRuntimeFactory;
      metadata: () => Record<string, unknown>;
      goalSource: WorkStatePublisher | null;
      isCurrent(): boolean;
      goalSet: Readonly<{
        fields: readonly ('objective' | 'status' | 'tokenBudget')[];
        writableStatuses?: readonly ('active' | 'paused' | 'complete')[];
      }> | null;
    }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

export type NativeInactiveSessionControlDependencies = Readonly<{
  acquireRuntimeRegistryLease?: () => Promise<RuntimeRegistryLease>;
}>;

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unavailableDiagnostic(code: string) {
  return Object.freeze({ code, severity: 'error' as const });
}

function unavailableGoalResult(code: string) {
  return Object.freeze({
    status: 'unavailable' as const,
    diagnostic: unavailableDiagnostic(code),
    retryable: true,
  });
}

function unsupportedGoalResult(code: string) {
  return Object.freeze({
    status: 'unsupported' as const,
    diagnostic: unavailableDiagnostic(code),
  });
}

function unavailableUsageResult(code: string) {
  return Object.freeze({
    ok: false as const,
    errorCode: code,
    error: code,
  });
}

function toHostUsageResult(result: AgentSessionUsageLimitRecoveryResult): unknown {
  if (result.status !== 'unsupported' && result.status !== 'unavailable' && result.status !== 'rejected') {
    return result;
  }
  return Object.freeze({
    ok: false as const,
    errorCode: result.diagnostic.code,
    error: result.diagnostic.message ?? result.diagnostic.code,
  });
}

function toReadinessProbeResult(
  result: AgentSessionUsageLimitRecoveryResult,
): SessionUsageLimitRecoveryReadinessProbeResult {
  if (result.status === 'waiting') {
    return {
      status: 'waiting',
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  }
  if (result.status === 'unsupported' || result.status === 'unavailable' || result.status === 'rejected') {
    return { status: 'unavailable', errorCode: result.diagnostic.code };
  }
  if (result.status === 'switchAttempted') {
    return { status: 'waiting' };
  }
  return { status: 'ready' };
}

function declaresInactiveOperation(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  agentId: string,
  operation: NativeInactiveOperation,
): boolean {
  const sessions = readAgentSessionCapabilities(
    registry.contributes.agentDefinitionsById.get(agentId)?.richDefinition?.definition,
  );
  if (!sessions) return false;
  if (operation === 'goal.get') return sessions.goals?.inactive?.get === true;
  if (operation === 'goal.set') return sessions.goals?.inactive?.set !== undefined;
  if (operation === 'goal.clear') return sessions.goals?.inactive?.clear === true;
  if (operation === 'catalog.vendorPlugins') {
    return sessions.catalog?.inactive?.includes('vendorPlugins') === true;
  }
  if (operation === 'catalog.skills') {
    return sessions.catalog?.inactive?.includes('skills') === true;
  }
  if (operation === 'usage.checkNow') {
    return sessions.usageLimitRecovery?.inactive?.includes('checkNow') === true;
  }
  return sessions.usageLimitRecovery?.inactive?.includes('consumeResetCredit') === true;
}

function hasNativeFacet(factory: AgentSessionRuntimeFactory, operation: NativeInactiveOperation): boolean {
  if (operation.startsWith('goal.')) return factory.goals !== undefined;
  if (operation.startsWith('catalog.')) return factory.catalog !== undefined;
  return factory.usageLimitRecovery !== undefined;
}

async function buildControlContext(params: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  lease: AgentRuntimeRegistrationLease;
  adapterParams: InactiveControlAdapterParams;
  signal: AbortSignal;
}>): Promise<Readonly<{
  context: AgentSessionControlContext;
  metadata: () => Record<string, unknown>;
  workState: ReturnType<typeof createNativeAgentSessionWorkStateService>;
}>> {
  const cwd = params.adapterParams.cwd ?? process.cwd();
  const signal = params.signal;
  const services = await params.registry.createAgentInvocationServices({
    pluginId: params.lease.pluginId,
    pluginVersion: params.lease.pluginVersion,
    agentId: params.lease.agentId,
    generation: params.lease.generation,
    correlationId: randomUUID(),
    cwd,
    signal,
    isGenerationCurrent: params.lease.isCurrent,
  });
  // Inactive routers decrypt and validate this boundary before invoking a facet. The
  // metadata shape is therefore canonical even though the host route contract exposes
  // it as an open record.
  let currentMetadata = params.adapterParams.metadata as Metadata;
  const workState = createNativeAgentSessionWorkStateService({
    session: {
      sessionId: params.adapterParams.sessionId,
      async updateMetadata(handler) {
        currentMetadata = handler(currentMetadata);
      },
    },
    pluginId: params.lease.pluginId,
    contributionId: params.lease.agentId,
    agentId: params.lease.agentId,
    generationId: params.lease.generation,
    declarations: readAgentSessionCapabilities(
      params.registry.contributes.agentDefinitionsById
        .get(params.lease.agentId)
        ?.richDefinition
        ?.definition,
    )?.workStateSources ?? [],
    isCurrent: params.lease.isCurrent,
  });
  const providerSessionId = readProviderSessionIdSessionState(currentMetadata).value;
  const baseContext = Object.freeze({
    plugin: Object.freeze({ id: params.lease.pluginId, version: params.lease.pluginVersion }),
    contribution: Object.freeze({
      id: params.lease.agentId,
      qualifiedId: `${params.lease.pluginId}/agents/${params.lease.agentId}`,
    }),
    surface: 'agent' as const,
    signal,
    services,
    ui: createPluginInvocationPresentation({
      currentSession: null,
      signal,
      isGenerationCurrent: params.lease.isCurrent,
    }),
    agent: Object.freeze({ id: params.lease.agentId }),
    protocols: Object.freeze({
      acp: Object.freeze({
        async open(): Promise<never> {
          throw new PluginError({
            code: 'inactive_agent_session_protocol_unavailable',
            message: 'Session protocol composition is unavailable to inactive controls',
          });
        },
      }),
    }),
    session: Object.freeze({
      id: params.adapterParams.sessionId,
      cwd,
      activity: 'inactive' as const,
      ...(providerSessionId ? { providerSessionId } : {}),
      connectedAccounts: Object.freeze([]),
    }),
  }) satisfies AgentSessionControlContext;
  return Object.freeze({
    context: baseContext,
    metadata: () => currentMetadata as Record<string, unknown>,
    workState,
  });
}

async function resolveNativeInvocation(params: Readonly<{
  agentId: CatalogAgentId;
  adapterParams: InactiveControlAdapterParams;
  operation: NativeInactiveOperation;
  dependencies?: NativeInactiveSessionControlDependencies;
}>): Promise<Readonly<{
  resolution: NativeInvocationResolution;
  release(): Promise<void>;
}>> {
  const runtimeRegistryLease = await (
    params.dependencies?.acquireRuntimeRegistryLease
      ?? acquireAuthoritativePluginRuntimeRegistryLease
  )();
  const operationAbort = new AbortController();
  const release = async () => {
    operationAbort.abort();
    await runtimeRegistryLease.release();
  };
  const registry = runtimeRegistryLease.registry;
  const contribution = registry.contributes.agentDefinitionsById.get(params.agentId);
  if (!contribution?.pluginId || !declaresInactiveOperation(registry, params.agentId, params.operation)) {
    return {
      resolution: { kind: 'unavailable', code: 'inactive_agent_control_unsupported' },
      release,
    };
  }

  try {
    await activateAgentRuntimeContributionOnDemand(registry, params.agentId);
    const lease = registry.agentRuntimesByAgentId.get(params.agentId);
    if (!lease || !lease.hasPrimaryRuntime) {
      return { resolution: { kind: 'unavailable', code: 'inactive_agent_runtime_unavailable' }, release };
    }
    if (!lease.isCurrent()) {
      return { resolution: { kind: 'unavailable', code: 'inactive_agent_runtime_generation_retired' }, release };
    }
    const runtime = await lease.createRuntime({ signal: operationAbort.signal });
    if (operationAbort.signal.aborted || !lease.isCurrent()) {
      return {
        resolution: {
          kind: 'unavailable',
          code: 'inactive_agent_runtime_generation_retired',
        },
        release,
      };
    }
    const factory = runtime.sessions;
    if (!factory || !hasNativeFacet(factory, params.operation)) {
      return {
        resolution: { kind: 'unavailable', code: 'inactive_agent_runtime_facet_unavailable' },
        release,
      };
    }
    const built = await buildControlContext({
      registry,
      lease,
      adapterParams: params.adapterParams,
      signal: operationAbort.signal,
    });
    const sessionCapabilities = readAgentSessionCapabilities(
      registry.contributes.agentDefinitionsById
        .get(params.agentId)
        ?.richDefinition
        ?.definition,
    );
    const goalSourceId = sessionCapabilities?.goals?.source;
    const goalSet = sessionCapabilities?.goals?.inactive?.set ?? null;
    return {
      resolution: {
        kind: 'native',
        context: built.context,
        factory,
        metadata: built.metadata,
        goalSource: goalSourceId ? built.workState.publisher(goalSourceId) : null,
        isCurrent: lease.isCurrent,
        goalSet,
      },
      release,
    };
  } catch {
    return { resolution: { kind: 'unavailable', code: 'inactive_agent_runtime_unavailable' }, release };
  }
}

async function invokeNative<T>(params: Readonly<{
  agentId: CatalogAgentId;
  adapterParams: InactiveControlAdapterParams;
  operation: NativeInactiveOperation;
  dependencies?: NativeInactiveSessionControlDependencies;
  invoke(resolution: Extract<NativeInvocationResolution, { kind: 'native' }>): Promise<T>;
  unavailable(code: string): T;
}>): Promise<T> {
  let resolved: Awaited<ReturnType<typeof resolveNativeInvocation>>;
  try {
    resolved = await resolveNativeInvocation(params);
  } catch {
    return params.unavailable('inactive_agent_runtime_unavailable');
  }
  try {
    if (resolved.resolution.kind === 'unavailable') {
      return params.unavailable(resolved.resolution.code);
    }
    const result = await params.invoke(resolved.resolution);
    return resolved.resolution.isCurrent()
      ? result
      : params.unavailable('inactive_agent_runtime_generation_retired');
  } catch {
    return params.unavailable('inactive_agent_control_unavailable');
  } finally {
    await resolved.release().catch(() => undefined);
  }
}

function goalMutation(request: Readonly<Record<string, unknown>>): AgentSessionGoalMutation | null {
  const objective = readString(request.objective) ?? undefined;
  const status = request.status === 'active' || request.status === 'paused' || request.status === 'complete'
    ? request.status
    : undefined;
  const hasTokenBudget = Object.prototype.hasOwnProperty.call(request, 'tokenBudget');
  const tokenBudget = typeof request.tokenBudget === 'number' || request.tokenBudget === null
    ? request.tokenBudget
    : undefined;
  if (objective !== undefined) {
    return {
      objective,
      ...(status ? { status } : {}),
      ...(hasTokenBudget ? { tokenBudget: tokenBudget ?? null } : {}),
    };
  }
  if (status !== undefined) {
    return { status, ...(hasTokenBudget ? { tokenBudget: tokenBudget ?? null } : {}) };
  }
  if (hasTokenBudget) return { tokenBudget: tokenBudget ?? null };
  return null;
}

function goalMutationIsDeclared(
  request: Readonly<Record<string, unknown>>,
  declaration: Extract<
    Extract<NativeInvocationResolution, { kind: 'native' }>['goalSet'],
    object
  >,
): boolean {
  const fields = declaration.fields;
  if (
    request.status !== undefined
    && request.status !== 'active'
    && request.status !== 'paused'
    && request.status !== 'complete'
  ) return false;
  if (Object.prototype.hasOwnProperty.call(request, 'objective') && !fields.includes('objective')) return false;
  if (Object.prototype.hasOwnProperty.call(request, 'status') && !fields.includes('status')) return false;
  if (Object.prototype.hasOwnProperty.call(request, 'tokenBudget') && !fields.includes('tokenBudget')) return false;
  if (
    request.status !== undefined
    && declaration.writableStatuses
    && !declaration.writableStatuses.includes(request.status as 'active' | 'paused' | 'complete')
  ) return false;
  return true;
}

export function createNativeInactiveGoalAdapter(params: Readonly<{
  agentId: CatalogAgentId;
  native: Readonly<{ get: boolean; set: boolean; clear: boolean }>;
  dependencies?: NativeInactiveSessionControlDependencies;
}>) {
  const withMetadata = (result: unknown, metadata: () => Record<string, unknown>) => ({
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }),
    metadata: metadata(),
  });
  return Object.freeze({
    ...(params.native.get ? {
      getGoal: async (input: SessionGoalControlAdapterParams) => await invokeNative<unknown>({
        agentId: params.agentId,
        adapterParams: input,
        operation: 'goal.get',
        dependencies: params.dependencies,
        invoke: async ({ factory, context, metadata, goalSource }) => withMetadata(
          await factory.goals!.get({
            ...context,
            goalSource: goalSource ?? createNativeAgentSessionWorkStateService({
              session: { sessionId: input.sessionId, async updateMetadata() {} },
              pluginId: context.plugin.id,
              contributionId: context.contribution.id,
              agentId: context.agent.id,
              generationId: 'unavailable',
              declarations: [],
              isCurrent: () => false,
            }).publisher('unavailable'),
          }, { signal: context.signal }),
          metadata,
        ),
        unavailable: unavailableGoalResult,
      }),
    } : {}),
    ...(params.native.set ? {
      setGoal: async (input: Parameters<NonNullable<SessionGoalControlAdapter['setGoal']>>[0]) => {
        const mutation = goalMutation(input.request);
        if (!mutation) return unavailableGoalResult('native_goal_mutation_unsupported');
        return await invokeNative<unknown>({
          agentId: params.agentId,
          adapterParams: input,
          operation: 'goal.set',
          dependencies: params.dependencies,
          invoke: async ({ factory, context, metadata, goalSource, goalSet }) => {
            if (!goalSet || !goalMutationIsDeclared(input.request, goalSet)) {
              return unsupportedGoalResult('inactive_agent_goal_field_unsupported');
            }
            return withMetadata(await factory.goals!.set(mutation, {
              ...context,
              goalSource: goalSource ?? createNativeAgentSessionWorkStateService({
                session: { sessionId: input.sessionId, async updateMetadata() {} },
                pluginId: context.plugin.id,
                contributionId: context.contribution.id,
                agentId: context.agent.id,
                generationId: 'unavailable',
                declarations: [],
                isCurrent: () => false,
              }).publisher('unavailable'),
            }, { signal: context.signal }), metadata);
          },
          unavailable: unavailableGoalResult,
        });
      },
    } : {}),
    ...(params.native.clear ? {
      clearGoal: async (input: SessionGoalControlAdapterParams) => await invokeNative<unknown>({
        agentId: params.agentId,
        adapterParams: input,
        operation: 'goal.clear',
        dependencies: params.dependencies,
        invoke: async ({ factory, context, metadata, goalSource }) => withMetadata(
          await factory.goals!.clear({
            ...context,
            goalSource: goalSource ?? createNativeAgentSessionWorkStateService({
              session: { sessionId: input.sessionId, async updateMetadata() {} },
              pluginId: context.plugin.id,
              contributionId: context.contribution.id,
              agentId: context.agent.id,
              generationId: 'unavailable',
              declarations: [],
              isCurrent: () => false,
            }).publisher('unavailable'),
          }, { signal: context.signal }),
          metadata,
        ),
        unavailable: unavailableGoalResult,
      }),
    } : {}),
  });
}

export function createNativeInactiveCatalogAdapter(params: Readonly<{
  agentId: CatalogAgentId;
  native: Readonly<{ vendorPlugins: boolean; skills: boolean }>;
  dependencies?: NativeInactiveSessionControlDependencies;
}>) {
  const list = async (
    operation: 'vendorPlugins' | 'skills',
    input: SessionCatalogControlAdapterParams,
  ) => await invokeNative({
    agentId: params.agentId,
    adapterParams: input,
    operation: `catalog.${operation}`,
    dependencies: params.dependencies,
    invoke: async ({ factory, context }) => {
      if (operation === 'vendorPlugins') {
        const result = await factory.catalog!.list(
          { kind: 'vendorPlugins' },
          context,
          { signal: context.signal },
        );
        if (result.status !== 'ok' || result.kind !== 'vendorPlugins') {
          return {
            unsupported: true,
            vendorPlugins: [],
            diagnostic: result.status === 'ok'
              ? 'native_vendor_plugin_catalog_kind_mismatch'
              : result.diagnostic.code,
          };
        }
        return {
          vendorPlugins: result.items.map((item) => ({
            vendorPluginRef: item.id,
            name: item.name,
            displayName: item.displayName,
            ...(item.description ? { description: item.description } : {}),
            installed: item.installed,
            enabled: item.enabled,
            mentionable: item.mentionable,
          })),
        };
      }
      const result = await factory.catalog!.list(
        { kind: 'skills' },
        context,
        { signal: context.signal },
      );
      if (result.status !== 'ok' || result.kind !== 'skills') {
        return {
          unsupported: true,
          skills: [],
          diagnostic: result.status === 'ok'
            ? 'native_skill_catalog_kind_mismatch'
            : result.diagnostic.code,
        };
      }
      return {
        skills: result.items.map((item) => ({
          v: 1 as const,
          id: item.id,
          origin: 'vendor' as const,
          backendId: params.agentId,
          agentId: params.agentId,
          name: item.name,
          displayName: item.displayName,
          ...(item.description ? { description: item.description } : {}),
          ...(item.path ? { path: item.path } : {}),
          enabled: item.enabled,
        })),
      };
    },
    unavailable: (code) => operation === 'vendorPlugins'
      ? { unsupported: true, vendorPlugins: [], diagnostic: code }
      : { unsupported: true, skills: [], diagnostic: code },
  });
  return Object.freeze({
    ...(params.native.vendorPlugins ? {
      listVendorPlugins: async (input: SessionCatalogControlAdapterParams) => await list(
        'vendorPlugins',
        input,
      ),
    } : {}),
    ...(params.native.skills ? {
      listSkills: async (input: SessionCatalogControlAdapterParams) => await list(
        'skills',
        input,
      ),
    } : {}),
  });
}

export function createNativeInactiveUsageAdapter(params: Readonly<{
  agentId: CatalogAgentId;
  backoffPolicy?: SessionUsageLimitRecoveryBackoffPolicy | null;
  native: Readonly<{ checkNow: boolean; consumeResetCredit: boolean }>;
  dependencies?: NativeInactiveSessionControlDependencies;
}>) {
  const probeNative = async (
    operation: 'checkNow' | 'consumeResetCredit',
    input: SessionUsageLimitRecoveryControlAdapterParams,
  ): Promise<SessionUsageLimitRecoveryReadinessProbeResult> => await invokeNative({
    agentId: params.agentId,
    adapterParams: input,
    operation: `usage.${operation}`,
    dependencies: params.dependencies,
    invoke: async ({ factory, context }) => toReadinessProbeResult(
      await factory.usageLimitRecovery!.execute(
        operation === 'checkNow'
          ? {
              kind: 'checkNow',
              ...(input.issueFingerprint ? { issueFingerprint: input.issueFingerprint } : {}),
              ...(input.resumePromptMode ? { resumePromptMode: input.resumePromptMode } : {}),
            }
          : { kind: 'consumeResetCredit', issueFingerprint: input.issueFingerprint ?? '' },
        context,
        { signal: context.signal },
      ),
    ),
    unavailable: (code) => ({ status: 'unavailable', errorCode: code }),
  });
  const execute = async (
    operation: 'checkNow' | 'consumeResetCredit',
    input: SessionUsageLimitRecoveryControlAdapterParams,
  ) => {
    if (operation === 'checkNow' && params.backoffPolicy) {
      const backoff = createBackoffSessionUsageLimitRecoveryControlAdapter({
        ...params.backoffPolicy,
        ...(params.native.checkNow
          ? { readinessProbe: async () => await probeNative('checkNow', input) }
          : {}),
      });
      return await backoff.checkNow!(input);
    }
    return await invokeNative({
      agentId: params.agentId,
      adapterParams: input,
      operation: `usage.${operation}`,
      dependencies: params.dependencies,
      invoke: async ({ factory, context }) => toHostUsageResult(
        await factory.usageLimitRecovery!.execute(
          operation === 'checkNow'
            ? {
                kind: 'checkNow',
                ...(input.issueFingerprint ? { issueFingerprint: input.issueFingerprint } : {}),
                ...(input.resumePromptMode ? { resumePromptMode: input.resumePromptMode } : {}),
              }
            : { kind: 'consumeResetCredit', issueFingerprint: input.issueFingerprint ?? '' },
          context,
          { signal: context.signal },
        ),
      ),
      unavailable: unavailableUsageResult,
    });
  };
  return Object.freeze({
    ...(params.native.checkNow || params.backoffPolicy ? {
      checkNow: async (input: SessionUsageLimitRecoveryControlAdapterParams) => await execute(
        'checkNow',
        input,
      ),
    } : {}),
    ...(params.native.consumeResetCredit ? {
      consumeResetCredit: async (input: SessionUsageLimitRecoveryControlAdapterParams) => await execute(
        'consumeResetCredit',
        input,
      ),
    } : {}),
  });
}
