import type {
  AgentExternalSessionsFailureCode,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import {
  AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import {
  hasConnectedServiceBindings,
  mergeConnectedServiceRuntimeSnapshots,
  readConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import {
  resolveConnectedServiceRuntimeSnapshotForExternalSession,
} from '@/daemon/connectedServices/externalSessionRuntimeSnapshotRecovery';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type {
  AgentRuntimeRegistrationLease,
} from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { mapExternalTakeoverLaunchPlanToSpawnOptions } from './mapExternalTakeoverLaunchPlanToSpawnOptions';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';

export type ExternalTakeoverOriginatingGeneration = Readonly<{
  agentId: string;
  pluginId: string;
  generation: string;
}>;

export type ResolvedExternalTakeoverSpawn = Readonly<{
  options: SpawnSessionOptions;
  origin: ExternalTakeoverOriginatingGeneration;
}>;

export type ExternalTakeoverSpawnResolution =
  | Readonly<{
      ok: true;
      value: ResolvedExternalTakeoverSpawn;
    }>
  | Readonly<{
      ok: false;
      code: AgentExternalSessionsFailureCode;
    }>;

export type ExternalTakeoverFencedSpawnResult =
  | Readonly<{
      ok: true;
      value: SpawnSessionResult;
    }>
  | Readonly<{
      ok: false;
      code: 'agent_unavailable' | 'cancelled';
    }>;

type FinalTakeoverSpawnOptions = Pick<
  SpawnSessionOptions,
  'transcriptStorage' | 'persistedTakeoverAdmission'
>;

function invocationFailure(params: Readonly<{
  error: unknown;
  signal: AbortSignal;
  isCurrent(): boolean;
}>): Extract<ExternalTakeoverSpawnResolution, { ok: false }> {
  if (params.signal.aborted) {
    return { ok: false, code: 'cancelled' };
  }
  if (!params.isCurrent()) {
    return { ok: false, code: 'unavailable' };
  }
  const message = params.error instanceof Error ? params.error.message : '';
  if (/timed out|deadline/iu.test(message)) {
    return { ok: false, code: 'timeout' };
  }
  return { ok: false, code: 'agent_error' };
}

export async function resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry(
  params: Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    linked: LoadedLinkedExternalSession;
    sessionId: string;
    signal: AbortSignal;
  }>,
): Promise<ExternalTakeoverSpawnResolution> {
  let runtimeLease: AgentRuntimeRegistrationLease | undefined;
  try {
    await activateAgentRuntimeContributionOnDemand(
      params.registry,
      params.linked.agentId,
    );
    runtimeLease = params.registry.agentRuntimesByAgentId.get(
      params.linked.agentId,
    );
    if (
      !runtimeLease?.externalSessions
      || !runtimeLease.externalSessionTakeover
      || !runtimeLease.isCurrent()
      || runtimeLease.retirementSignal.aborted
    ) {
      return { ok: false, code: 'agent_unavailable' };
    }

    const targetAgent = params.registry.contributes.agentDefinitionsById.get(
      params.linked.agentId,
    );
    if (
      !targetAgent
      || targetAgent.pluginId !== runtimeLease.pluginId
      || targetAgent.identity?.pluginId !== runtimeLease.pluginId
    ) {
      return { ok: false, code: 'agent_unavailable' };
    }

    const resolvedIdentity = await runtimeLease.externalSessions
      .resolveLinkedIdentity({
        source: params.linked.source,
        remoteSessionId: params.linked.remoteSessionId,
        linkData: params.linked.linkData ?? {},
        signal: params.signal,
        deadlineAtMs:
          Date.now() + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
        maxSerializedBytes:
          EXTERNAL_SESSIONS_INVOCATION_POLICY.resolveLinkedIdentity
            .maxSerializedBytes,
      });
    if (!resolvedIdentity.ok) {
      return {
        ok: false,
        code: resolvedIdentity.code,
      };
    }
    if (
      !runtimeLease.isCurrent()
      || runtimeLease.retirementSignal.aborted
    ) {
      return { ok: false, code: 'unavailable' };
    }

    const launch = await runtimeLease.externalSessionTakeover.resolveLaunch({
      linkedSessionId: params.sessionId,
      source: resolvedIdentity.value.source,
      remoteSessionId: resolvedIdentity.value.remoteSessionId,
      linkData: resolvedIdentity.value.linkData,
      ...(params.linked.sessionPath
        ? { linkedDirectory: params.linked.sessionPath }
        : {}),
      signal: params.signal,
      deadlineAtMs:
        Date.now()
        + AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.callbacks.resolveLaunch
          .deadlineMs,
      maxSerializedBytes:
        AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.callbacks.resolveLaunch
          .maxEnvelopeUtf8Bytes,
    });
    if (!launch.ok) {
      return {
        ok: false,
        code: launch.code,
      };
    }

    const options = mapExternalTakeoverLaunchPlanToSpawnOptions({
      plan: launch.value,
      resolvedIdentity: resolvedIdentity.value,
      linkedSessionId: params.sessionId,
      targetAgent,
    });
    if (!options) {
      return { ok: false, code: 'invalid_request' };
    }
    return {
      ok: true,
      value: {
        options,
        origin: {
          agentId: runtimeLease.agentId,
          pluginId: runtimeLease.pluginId,
          generation: runtimeLease.generation,
        },
      },
    };
  } catch (error) {
    return invocationFailure({
      error,
      signal: params.signal,
      isCurrent: () => Boolean(
        runtimeLease
        && runtimeLease.isCurrent()
        && !runtimeLease.retirementSignal.aborted
      ),
    });
  }
}

export async function resolveExternalTakeoverSpawnOptions(params: Readonly<{
  linked: LoadedLinkedExternalSession;
  sessionId: string;
  signal?: AbortSignal;
}>): Promise<ExternalTakeoverSpawnResolution> {
  const signal = params.signal ?? new AbortController().signal;
  let runtimeRegistryLease;
  try {
    runtimeRegistryLease =
      await acquireAuthoritativePluginRuntimeRegistryLease();
  } catch {
    return { ok: false, code: 'agent_unavailable' };
  }

  let resolved: ExternalTakeoverSpawnResolution;
  try {
    resolved =
      await resolveExternalTakeoverSpawnOptionsFromRuntimeRegistry({
        registry: runtimeRegistryLease.registry,
        linked: params.linked,
        sessionId: params.sessionId,
        signal,
      });
  } finally {
    await runtimeRegistryLease.release();
  }
  if (!resolved.ok) return resolved;

  const snapshot = mergeConnectedServiceRuntimeSnapshots(
    readConnectedServiceRuntimeSnapshot(params.linked.metadata),
    await resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: params.linked.agentId,
      remoteSessionId: resolved.value.options.resume
        ?? params.linked.remoteSessionId,
      directoryHint: resolved.value.options.directory,
    }),
  );
  return hasConnectedServiceBindings(snapshot)
    ? {
        ok: true,
        value: {
          ...resolved.value,
          options: {
            ...resolved.value.options,
            ...snapshot,
          },
        },
      }
    : resolved;
}

export async function isExternalTakeoverLaunchAvailable(
  agentId: string,
): Promise<boolean> {
  let runtimeRegistryLease;
  try {
    runtimeRegistryLease =
      await acquireAuthoritativePluginRuntimeRegistryLease();
  } catch {
    return false;
  }
  try {
    await activateAgentRuntimeContributionOnDemand(
      runtimeRegistryLease.registry,
      agentId,
    );
    const runtimeLease =
      runtimeRegistryLease.registry.agentRuntimesByAgentId.get(agentId);
    return Boolean(
      runtimeLease?.hasPrimaryRuntime
      && runtimeLease.externalSessions
      && runtimeLease.externalSessionTakeover
      && runtimeLease.isCurrent()
      && !runtimeLease.retirementSignal.aborted
    );
  } catch {
    return false;
  } finally {
    await runtimeRegistryLease.release();
  }
}

export async function spawnResolvedExternalTakeoverSessionFromRuntimeRegistry(
  params: Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    resolved: ResolvedExternalTakeoverSpawn;
    options: FinalTakeoverSpawnOptions;
    signal: AbortSignal;
    spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  }>,
): Promise<ExternalTakeoverFencedSpawnResult> {
  if (params.signal.aborted) {
    return { ok: false, code: 'cancelled' };
  }
  const runtimeLease = params.registry.agentRuntimesByAgentId.get(
    params.resolved.origin.agentId,
  );
  if (
    !runtimeLease?.hasPrimaryRuntime
    || !runtimeLease.externalSessionTakeover
    || runtimeLease.pluginId !== params.resolved.origin.pluginId
    || runtimeLease.generation !== params.resolved.origin.generation
    || !runtimeLease.isCurrent()
    || runtimeLease.retirementSignal.aborted
  ) {
    return { ok: false, code: 'agent_unavailable' };
  }

  // Deliberately keep this invocation synchronous with the final currentness
  // read: no awaited work may enter between the fence and the spawn effect.
  const spawn = params.spawnSession({
    ...params.resolved.options,
    ...params.options,
  });
  return {
    ok: true,
    value: await spawn,
  };
}

export async function spawnResolvedExternalTakeoverSession(
  params: Readonly<{
    resolved: ResolvedExternalTakeoverSpawn;
    options: FinalTakeoverSpawnOptions;
    signal?: AbortSignal;
    spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  }>,
): Promise<ExternalTakeoverFencedSpawnResult> {
  const signal = params.signal ?? new AbortController().signal;
  let runtimeRegistryLease;
  try {
    runtimeRegistryLease =
      await acquireAuthoritativePluginRuntimeRegistryLease();
  } catch {
    return { ok: false, code: 'agent_unavailable' };
  }
  try {
    return await spawnResolvedExternalTakeoverSessionFromRuntimeRegistry({
      registry: runtimeRegistryLease.registry,
      resolved: params.resolved,
      options: params.options,
      signal,
      spawnSession: params.spawnSession,
    });
  } finally {
    await runtimeRegistryLease.release();
  }
}
