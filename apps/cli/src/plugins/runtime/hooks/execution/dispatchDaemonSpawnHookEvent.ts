import {
  getPluginHookDefinitionV1,
  buildBackendTargetKeyV2,
  type DaemonSpawnHookEventIdV1,
  type HookEventEnvelopeV1,
} from '@happier-dev/protocol';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { matchesHookDefinitionFilters } from '@/plugins/projection/hooks/matchesHookRegistrationFilters';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';

import {
  dispatchPluginHookEvent,
  type DispatchPluginHookEventResultV1,
} from './dispatchPluginHookEvent';

type DispatchDaemonSpawnHookEventDeps = Readonly<{
  resolveContributes?: (params: Readonly<{ happyHomeDir: string }>) => Promise<ResolvedContributionRegistry>;
  resolveRuntimeRegistry?: (params: Readonly<{
    happyHomeDir: string;
    contributes?: ResolvedContributionRegistry;
    pluginIds?: readonly string[];
  }>) => Promise<ResolvedExecutablePluginRuntimeRegistry>;
  dispatchEvent?: (params: Readonly<{
    runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId'> & Partial<Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes'>>;
    event: HookEventEnvelopeV1;
    context?: unknown;
  }>) => Promise<DispatchPluginHookEventResultV1>;
  nowMs?: () => number;
  timeoutMs?: number;
}>;

export type DaemonSpawnHookDispatchEvent = Readonly<{
  eventId: DaemonSpawnHookEventIdV1;
  agentId?: string;
  backendId?: string;
  backendTarget?: BackendTargetRefV2;
  machineId?: string;
  workspaceId?: string;
  cwd?: string;
  timestampMs?: number;
  payload: Record<string, unknown>;
  context?: unknown;
}>;

function resolveDaemonSpawnHookCategory(eventId: DaemonSpawnHookEventIdV1): HookEventEnvelopeV1['category'] {
  return getPluginHookDefinitionV1(eventId)?.category ?? 'decision';
}

function resolveDaemonSpawnHookScope(eventId: DaemonSpawnHookEventIdV1): HookEventEnvelopeV1['scope'] {
  return getPluginHookDefinitionV1(eventId)?.scope ?? 'daemon';
}

class DaemonSpawnHookDispatchTimeoutError extends Error {
  public constructor(
    public readonly eventId: DaemonSpawnHookEventIdV1,
    public readonly timeoutMs: number,
  ) {
    super(`Daemon spawn hook '${eventId}' timed out after ${timeoutMs}ms.`);
    this.name = 'DaemonSpawnHookDispatchTimeoutError';
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return configuration.daemonSpawnHookDispatchTimeoutMs;
  }
  return Math.max(0, Math.trunc(value));
}

async function withDaemonSpawnHookTimeout<T>(params: Readonly<{
  eventId: DaemonSpawnHookEventIdV1;
  timeoutMs: number;
  operation: () => Promise<T>;
}>): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const operation = params.operation();
  operation.catch(() => undefined);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new DaemonSpawnHookDispatchTimeoutError(params.eventId, params.timeoutMs));
        }, params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildTimedOutHookDispatchResult(
  error: DaemonSpawnHookDispatchTimeoutError,
): DispatchPluginHookEventResultV1 {
  const hookDefinition = getPluginHookDefinitionV1(error.eventId);
  const executionKind = hookDefinition?.executionKind ?? null;
  const aggregate = executionKind
    ? {
        executionKind,
        result: Object.freeze(
          hookDefinition?.aggregation === 'mergeObject'
            ? {}
            : hookDefinition?.failureMode === 'failClosed'
              ? { decision: 'deny' }
              : [],
        ),
      }
    : undefined;
  return {
    eventId: error.eventId,
    matchedHandlerCount: 1,
    outcomes: Object.freeze([
      {
        pluginId: 'daemon.spawn-hooks',
        hookId: error.eventId,
        status: 'rejected',
        error: error.message,
      },
    ]),
    ...(aggregate ? { aggregate } : {}),
  };
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function resolveDaemonSpawnHookAgentId(params: Readonly<{
  event: DaemonSpawnHookDispatchEvent;
  contributes: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>;
}>): string | null {
  const explicitAgentId = normalizeNonEmptyString(params.event.agentId);
  if (explicitAgentId) return explicitAgentId;

  const backendId = normalizeNonEmptyString(params.event.backendId);
  if (!backendId) return null;

  return normalizeNonEmptyString(
    resolveEngineRuntimeContribution(params.contributes, backendId)?.agentId,
  );
}

function buildDaemonSpawnHookPayload(params: Readonly<{
  event: DaemonSpawnHookDispatchEvent;
  agentId: string | null;
}>): Record<string, unknown> {
  const runtimeTarget = params.event.backendTarget;
  if (!params.agentId && !runtimeTarget) return params.event.payload;
  return {
    ...params.event.payload,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(runtimeTarget ? { runtimeTarget } : {}),
  };
}

function buildDaemonSpawnHookEnvelope(params: Readonly<{
  event: DaemonSpawnHookDispatchEvent;
  agentId: string | null;
  nowMs: () => number;
}>): HookEventEnvelopeV1 {
  return {
    hookVersion: 1,
    eventId: params.event.eventId,
    category: resolveDaemonSpawnHookCategory(params.event.eventId),
    scope: resolveDaemonSpawnHookScope(params.event.eventId),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.event.backendTarget ? { backendTarget: buildBackendTargetKeyV2(params.event.backendTarget) } : {}),
    ...(params.event.machineId ? { machineId: params.event.machineId } : {}),
    ...(params.event.workspaceId ? { workspaceId: params.event.workspaceId } : {}),
    ...(params.event.cwd ? { cwd: params.event.cwd } : {}),
    timestampMs: typeof params.event.timestampMs === 'number' ? params.event.timestampMs : params.nowMs(),
    payload: buildDaemonSpawnHookPayload({
      event: params.event,
      agentId: params.agentId,
    }),
  };
}

function resolveDaemonSpawnHookPluginIds(params: Readonly<{
  event: DaemonSpawnHookDispatchEvent;
  envelope: HookEventEnvelopeV1;
  contributes: Pick<
    ResolvedContributionRegistry,
    'agentDefinitionsById' | 'activationTargets'
  >;
}>): readonly string[] {
  const pluginIds = new Set<string>();
  const backendId = normalizeNonEmptyString(params.event.backendId);
  const backendOwnerPluginId = backendId
    ? normalizeNonEmptyString(
      resolveEngineRuntimeContribution(params.contributes, backendId)?.pluginId,
    )
    : null;
  if (backendOwnerPluginId) {
    pluginIds.add(backendOwnerPluginId);
  }

  for (const target of params.contributes.activationTargets) {
    for (const declaration of target.manifest.contributes.hooks) {
      if (
        declaration.on === params.event.eventId
        && matchesHookDefinitionFilters(params.envelope, declaration)
      ) {
        const pluginId = normalizeNonEmptyString(target.pluginId);
        if (pluginId) {
          pluginIds.add(pluginId);
        }
      }
    }
  }

  return Object.freeze([...pluginIds].sort());
}

export async function dispatchDaemonSpawnHookEvent(
  params: Readonly<{
    happyHomeDir: string;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry;
    event: DaemonSpawnHookDispatchEvent;
  }>,
  deps: DispatchDaemonSpawnHookEventDeps = {},
): Promise<DispatchPluginHookEventResultV1> {
  const resolveContributes = deps.resolveContributes
    ?? (async ({ happyHomeDir }: Readonly<{ happyHomeDir: string }>) => {
      const { resolveMergedContributionRegistry } = await import(
        '@/plugins/projection/registry/createResolvedContributionRegistry'
      );
      return await resolveMergedContributionRegistry({ happyHomeDir });
    });
  const dispatchEvent = deps.dispatchEvent ?? dispatchPluginHookEvent;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timeoutMs = normalizeTimeoutMs(deps.timeoutMs);

  let lease: PluginRuntimeRegistryLease | null = null;
  let event: HookEventEnvelopeV1 | null = null;

  try {
    const acceptedRuntimeRegistry = params.runtimeRegistry;
    if (acceptedRuntimeRegistry) {
      const agentId = resolveDaemonSpawnHookAgentId({
        event: params.event,
        contributes: acceptedRuntimeRegistry.contributes,
      });
      const acceptedEvent = buildDaemonSpawnHookEnvelope({
        event: params.event,
        agentId,
        nowMs,
      });
      return await withDaemonSpawnHookTimeout({
        eventId: params.event.eventId,
        timeoutMs,
        operation: async () => await dispatchEvent({
          runtimeRegistry: acceptedRuntimeRegistry,
          event: acceptedEvent,
          ...(params.event.context === undefined ? {} : { context: params.event.context }),
        }),
      });
    }

    lease = await withDaemonSpawnHookTimeout({
      eventId: params.event.eventId,
      timeoutMs,
      operation: async () => {
        if (deps.resolveRuntimeRegistry) {
          const contributes = await resolveContributes({ happyHomeDir: params.happyHomeDir });
          const agentId = resolveDaemonSpawnHookAgentId({
            event: params.event,
            contributes,
          });
          event = buildDaemonSpawnHookEnvelope({
            event: params.event,
            agentId,
            nowMs,
          });
          const pluginIds = resolveDaemonSpawnHookPluginIds({
            event: params.event,
            envelope: event,
            contributes,
          });
          if (pluginIds.length > 0) {
            const registry = await deps.resolveRuntimeRegistry({
              happyHomeDir: params.happyHomeDir,
              contributes,
              pluginIds,
            });
            const { createEphemeralPluginRuntimeRegistryLease } = await import(
              '@/plugins/runtime/reload/runtimeLease'
            );
            return createEphemeralPluginRuntimeRegistryLease(registry);
          }
        }

        const { acquireAuthoritativePluginRuntimeRegistryLease } = await import(
          '@/plugins/runtime/reload/runtimeLease'
        );
        const authoritativeLease = await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: params.happyHomeDir,
        });
        if (!event) {
          const agentId = resolveDaemonSpawnHookAgentId({
            event: params.event,
            contributes: authoritativeLease.registry.contributes,
          });
          event = buildDaemonSpawnHookEnvelope({
            event: params.event,
            agentId,
            nowMs,
          });
        }
        return authoritativeLease;
      },
    });
    const activeLease = lease;
    const hookEvent = event;
    if (!hookEvent) {
      throw new Error(`Failed to build daemon spawn hook event '${params.event.eventId}'.`);
    }

    const dispatched = await withDaemonSpawnHookTimeout({
      eventId: params.event.eventId,
      timeoutMs,
      operation: async () => await dispatchEvent({
        runtimeRegistry: activeLease.registry,
        event: hookEvent,
        ...(params.event.context === undefined ? {} : { context: params.event.context }),
      }),
    });
    return dispatched;
  } catch (error) {
    if (error instanceof DaemonSpawnHookDispatchTimeoutError) {
      return buildTimedOutHookDispatchResult(error);
    }
    throw error;
  } finally {
    if (lease) {
      await lease.release();
    }
  }
}
