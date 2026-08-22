import { randomUUID } from 'node:crypto';

import { configuration } from '@/configuration';
import {
  readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { verifySessionMarkerProcessLiveness } from '@/daemon/processLivenessVerifier';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { retireSessionSubagentCustodyGeneration } from '@/session/transport/http/sessionSubagentCustodyHttp';

import type { PluginStorePaths } from '../paths';
import {
  pluginRegistryCommitRecordsEqual,
  readPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import { withPluginRegistryCommitFence } from './commitCoordinator';
import {
  cleanupUnreferencedPluginGenerations,
  readPreparedImmutablePluginGeneration,
  readPluginRegistryCommitInstallationAuthority,
} from './generationStore';

export type PluginGenerationCustodyRetirementResult =
  | Readonly<{ status: 'authentication-unavailable' }>
  | Readonly<{
      status: 'reconciled';
      removed: readonly string[];
      failures: readonly Readonly<{ generationId: string | null; message: string }>[];
    }>;

export type PluginGenerationCustodyRetirementRemoteDependencies = Readonly<{
  readCredentials?: () => Promise<StoredCredentials | null>;
  retireGeneration?: (params: Readonly<{
    token: string;
    pluginId: string;
    immutableGenerationId: string;
  }>) => Promise<void>;
  readRunnerRetainedGenerationIds?: () => Promise<ReadonlySet<string>>;
}>;

const generationCustodyFenceOwner = Object.freeze({
  pid: process.pid,
  instanceId: `generation-custody-${randomUUID()}`,
});

export async function attachExactRunnerRetainedPluginGenerations(
  params: Readonly<{
    paths: PluginStorePaths;
    immutableGenerationIds: readonly string[];
    attach: () => Promise<boolean>;
    withCommitFence?: <T>(operation: () => Promise<T>) => Promise<T>;
  }>,
): Promise<boolean> {
  const immutableGenerationIds = [...new Set(
    params.immutableGenerationIds,
  )].sort();
  const withCommitFence = params.withCommitFence
    ?? (async <T>(operation: () => Promise<T>) =>
      await withPluginRegistryCommitFence({
        paths: params.paths,
        owner: generationCustodyFenceOwner,
        operation,
      }));
  return await withCommitFence(async () => {
    try {
      for (const immutableGenerationId of immutableGenerationIds) {
        await readPreparedImmutablePluginGeneration({
          paths: params.paths,
          immutableGenerationId,
        });
      }
    } catch {
      return false;
    }
    return await params.attach();
  });
}

export async function readExactLiveRunnerRetainedPluginGenerationIds(
  dependencies?: Readonly<{
    listSessionMarkers?: typeof listSessionMarkers;
    verifySessionMarkerProcessLiveness?:
      typeof verifySessionMarkerProcessLiveness;
    readDaemonServiceAuthorityRetainedGenerationIds?:
      () => Promise<ReadonlySet<string>>;
  }>,
): Promise<ReadonlySet<string>> {
  // This projection can block destructive cleanup only. Ambiguous process
  // evidence must retain bytes, but it never authorizes runner effects.
  const retained = new Set<string>();
  for (
    const marker of await (
      dependencies?.listSessionMarkers ?? listSessionMarkers
    )()
  ) {
    const liveness = await (
      dependencies?.verifySessionMarkerProcessLiveness
      ?? verifySessionMarkerProcessLiveness
    )(marker);
    if (
      marker.processCommandHash
      && marker.processStartTimeMs !== undefined
      && liveness.status === 'verified_stopped'
      && liveness.pid === marker.pid
      && liveness.processStartTimeMs
        === marker.processStartTimeMs
    ) {
      continue;
    }
    if (marker.runnerAgentImmutableGenerationId) {
      retained.add(marker.runnerAgentImmutableGenerationId);
    }
    for (const generationId of (
      marker.runnerManagedDependencyRetentionV1
        ?.sourceGenerationIds ?? []
    )) {
      retained.add(generationId);
    }
    const adoptedProviderGenerationId =
      marker.runnerManagedDependencyRetentionV1
        ?.adoptedManagedProviderAuthority
        ?.immutableGenerationId;
    if (adoptedProviderGenerationId) {
      retained.add(adoptedProviderGenerationId);
    }
  }
  // The authority document is published under the same commit fence as its
  // exact-G verification before the runner's marker can exist. Consult it on
  // every cleanup read so a successor cannot rename G in that handoff gap.
  for (const generationId of await (
    dependencies?.readDaemonServiceAuthorityRetainedGenerationIds
    ?? (async () =>
      await readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
      }))
  )()) {
    retained.add(generationId);
  }
  return retained;
}

/**
 * Reconciles the exact durable commit's obsolete immutable generations with
 * server custody. Bytes move out of the rollback-addressable namespace before
 * the authenticated retirement request, so response loss is retryable without
 * allowing a retired generation to become current again.
 */
export async function reconcilePluginGenerationCustodyRetirement(params: Readonly<{
  paths: PluginStorePaths;
  commit: PluginRegistryCommitRecord;
  retainedCurrentHostGenerationIds?: readonly string[];
  isCommitCurrent?: () => Promise<boolean>;
  withCommitFence?: <T>(operation: () => Promise<T>) => Promise<T>;
  flushDirectory?: (path: string) => Promise<void>;
}> & PluginGenerationCustodyRetirementRemoteDependencies): Promise<PluginGenerationCustodyRetirementResult> {
  const isCommitCurrent = params.isCommitCurrent ?? (async () => (
    pluginRegistryCommitRecordsEqual(
      await readPluginRegistryCommitRecord(params.paths),
      params.commit,
    )
  ));
  let credentialsPromise: Promise<StoredCredentials | null> | null = null;
  let authenticationUnavailable = false;
  const state = await readPluginRegistryCommitInstallationAuthority(params.paths, params.commit);
  if (!state) throw new Error('Plugin generation custody retirement requires an installation authority');
  const readRunnerRetainedGenerationIds =
    params.readRunnerRetainedGenerationIds
    ?? readExactLiveRunnerRetainedPluginGenerationIds;
  const readRetainedGenerationIds = async (): Promise<ReadonlySet<string>> =>
    new Set([
      ...(params.retainedCurrentHostGenerationIds ?? []),
      ...await readRunnerRetainedGenerationIds(),
    ]);
  const result = await cleanupUnreferencedPluginGenerations({
    paths: params.paths,
    commit: params.commit,
    state,
    readRunnerRetainedGenerationIds: readRetainedGenerationIds,
    isCommitCurrent,
    ...(params.flushDirectory ? { flushDirectory: params.flushDirectory } : {}),
    withCommitFence: params.withCommitFence ?? (async (operation) => await withPluginRegistryCommitFence({
      paths: params.paths,
      owner: generationCustodyFenceOwner,
      operation,
    })),
    retireGeneration: async ({ pluginId, immutableGenerationId }) => {
      credentialsPromise ??= (params.readCredentials ?? readStoredCredentials)();
      const credentials = await credentialsPromise;
      if (!credentials) {
        authenticationUnavailable = true;
        throw new Error('Authenticated generation custody retirement is unavailable');
      }
      await (params.retireGeneration ?? retireSessionSubagentCustodyGeneration)({
        token: credentials.token,
        pluginId,
        immutableGenerationId,
      });
    },
  });
  if (authenticationUnavailable) return { status: 'authentication-unavailable' };
  return {
    status: 'reconciled',
    removed: result.removed,
    failures: result.failures,
  };
}
