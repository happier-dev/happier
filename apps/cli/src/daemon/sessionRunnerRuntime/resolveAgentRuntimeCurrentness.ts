import type { TrackedSession } from '@/daemon/types';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
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
  providerSettings: ProviderSettingsV1;
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

/**
 * The Session retains an exact managed Provider generation alongside its
 * retained Agent. An ordinary Provider-only update leaves P running and must
 * therefore report the same optional staleness the retained Agent already
 * reports, so the existing explicit restart path stays reachable.
 */
function isRetainedManagedProviderStale(input: Readonly<{
  tracked: TrackedSession;
  registry: ProviderContributionRegistryView | undefined;
}>): boolean {
  const retained = input.tracked
    .runnerManagedDependencyRetentionV1
    ?.adoptedManagedProviderAuthority;
  const registry = input.registry;
  if (!retained || !registry) return false;
  for (const contribution of registry.providersByContributionKey.values()) {
    const managedRuntime = contribution.managedRuntime;
    if (
      !managedRuntime
      || contribution.pluginId !== retained.pluginId
    ) continue;
    let isCurrent = false;
    try {
      isCurrent = managedRuntime.isCurrent() === true;
    } catch {
      isCurrent = false;
    }
    if (!isCurrent) continue;
    if (!pluginSourceCustodyV1Equal(
      managedRuntime.sourceCustody,
      retained.sourceCustody,
    )) return true;
  }
  return false;
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

  const retainedSourceCustody = tracked.runnerAgentSourceCustodyV1;
  const agentId = resolveTrackedSessionCatalogAgentId(tracked);
  if (!retainedSourceCustody || !agentId) {
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

  const currentSourceCustody = registration.sourceCustody;
  if (!currentSourceCustody) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  const retainedProviderStale = isRetainedManagedProviderStale({
    tracked,
    registry: input.providerResolution?.registry,
  });
  const agentRuntimeCurrentness: SessionRunnerAgentRuntimeCurrentness = {
    versionState:
      pluginSourceCustodyV1Equal(
        currentSourceCustody,
        retainedSourceCustody,
      ) && !retainedProviderStale
        ? 'current'
        : 'stale',
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
    providerSettings: input.providerResolution.providerSettings,
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
    accountSnapshot: ActiveAccountSettingsSnapshot | null;
  }>,
): Promise<SessionRunnerAgentRuntimeCurrentness> {
  if (!tracked) return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;

  let lease: Awaited<
    ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
  > | null = null;
  try {
    const captured = providerResolution.accountSnapshot;
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    let providerSettings: ProviderSettingsV1 | undefined;
    if (tracked.spawnOptions?.modelSelection?.ref.providerConnectionId && captured?.scopeKey) {
      const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: captured.scopeKey });
      const snapshot = getActiveAccountSettingsSnapshot();
      if (catalog.status === 'ready' && snapshot?.scopeKey === captured.scopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken) providerSettings = readProviderSettingsForCli(snapshot).settings;
    }
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    if (typeof lease.registry.generation !== 'number') {
      return UNKNOWN_AGENT_RUNTIME_CURRENTNESS;
    }
    return resolveTrackedRunnerAgentRuntimeCurrentness({
      tracked,
      agentRuntimesByAgentId: lease.registry.agentRuntimesByAgentId,
      ...(providerSettings ? { providerResolution: {
        machineId: providerResolution.machineId,
        providerSettings,
        registry: resolveProviderContributionRegistryView(
          lease.registry.contributes,
          lease.registry.generation,
          lease.registry.readPluginOccurrenceId,
        ),
      } } : {}),
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
