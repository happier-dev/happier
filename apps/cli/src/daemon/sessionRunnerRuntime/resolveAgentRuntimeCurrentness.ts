import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import type { AgentRuntimeRegistrationLease } from '@/plugins/runtime/lifecycle/contributions/targetAgents';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  resolveProviderConnectionForMachine,
  resolveProviderContributionRegistryView,
  type ProviderContributionRegistryView,
} from '@/providers/registry';

import type {
  SessionRunnerRestartDisabledReason,
  SessionRunnerVersionState,
} from './types';

export type SessionRunnerAgentRuntimeCurrentness = Readonly<{
  versionState: SessionRunnerVersionState;
  restartUnavailableReason: SessionRunnerRestartDisabledReason | null;
}>;

type ProviderResolutionContext = Readonly<{
  machineId: string;
  accountSettings: unknown;
  registry: ProviderContributionRegistryView;
}>;

const UNKNOWN_AGENT_RUNTIME_CURRENTNESS: SessionRunnerAgentRuntimeCurrentness =
  Object.freeze({
    versionState: 'unknown',
    restartUnavailableReason: null,
  });

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function resolveTrackedRunnerAgentRuntimeCurrentness(input: Readonly<{
  tracked: TrackedSession | null | undefined;
  agentRuntimesByAgentId: ReadonlyMap<string, AgentRuntimeRegistrationLease>;
  providerResolution?: ProviderResolutionContext;
}>): SessionRunnerAgentRuntimeCurrentness {
  const tracked = input.tracked ?? null;
  if (!tracked) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  if (
    tracked.agentRuntimeRunnerRestartDisposition
      === 'runner_authority_unavailable'
  ) {
    return {
      versionState: 'unknown',
      restartUnavailableReason: 'unsupported_backend',
    };
  }

  const pinnedGeneration = readNonEmptyString(
    tracked.runnerAgentImmutableGenerationId,
  );
  const agentId = resolveTrackedSessionCatalogAgentId(tracked);
  if (!pinnedGeneration || !agentId) {
    return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;
  }

  const registration = input.agentRuntimesByAgentId.get(agentId);
  if (!registration || !registration.hasPrimaryRuntime) {
    return {
      versionState: 'stale',
      restartUnavailableReason: 'unsupported_backend',
    };
  }

  let isCurrent = false;
  try {
    isCurrent = registration.isCurrent() === true;
  } catch {
    return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;
  }
  if (!isCurrent) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  const currentGeneration = readNonEmptyString(
    registration.immutableGenerationId,
  );
  if (!currentGeneration) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  const agentRuntimeCurrentness: SessionRunnerAgentRuntimeCurrentness = {
    versionState:
      currentGeneration === pinnedGeneration ? 'current' : 'stale',
    restartUnavailableReason: null,
  };

  const selectedProviderConnectionId =
    tracked.spawnOptions?.modelSelection?.ref.providerConnectionId;
  if (selectedProviderConnectionId === null || selectedProviderConnectionId === undefined) {
    return agentRuntimeCurrentness;
  }
  if (!input.providerResolution) {
    return {
      versionState:
        agentRuntimeCurrentness.versionState === 'stale'
          ? 'stale'
          : 'unknown',
      restartUnavailableReason: 'unsupported_backend',
    };
  }

  const providerResolution = resolveProviderConnectionForMachine({
    connectionId: selectedProviderConnectionId,
    machineId: input.providerResolution.machineId,
    accountSettings: input.providerResolution.accountSettings,
    registry: input.providerResolution.registry,
    dnsEvidenceByEndpointUrl: new Map(),
  });
  if (
    providerResolution.status === 'resolved'
    || providerResolution.status === 'endpoint_unresolved'
  ) {
    return agentRuntimeCurrentness;
  }

  return {
    versionState: 'stale',
    restartUnavailableReason: 'unsupported_backend',
  };
}

export async function resolveAuthoritativeTrackedRunnerAgentRuntimeCurrentness(
  tracked: TrackedSession | null | undefined,
  providerResolution: Readonly<{
    machineId: string;
    accountSettings: unknown;
  }>,
): Promise<SessionRunnerAgentRuntimeCurrentness> {
  if (!tracked) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  let lease: Awaited<
    ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
  > | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    return resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked,
      agentRuntimesByAgentId: lease.registry.agentRuntimesByAgentId,
      providerResolution: {
        ...providerResolution,
        registry: resolveProviderContributionRegistryView(
          lease.registry.contributes,
        ),
      },
    });
  } catch {
    return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;
  } finally {
    try {
      await lease?.release();
    } catch {
      // Currentness is advisory status evidence; lease cleanup failure must not
      // make the daemon status/restart RPC itself unavailable.
    }
  }
}
