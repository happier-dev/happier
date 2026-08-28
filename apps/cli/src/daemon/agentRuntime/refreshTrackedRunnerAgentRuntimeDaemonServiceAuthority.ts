import type {
  AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { loadRetainedAgentRuntimeLeaf } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import {
  readCurrentPluginHardRevocationRevision,
  readCurrentPluginImmutableGenerationIntegrityCurrentness,
  resolveBundledImmutablePluginArtifact,
} from '@/plugins/store/registry/generationStore';
import {
  attachExactRunnerRetainedPluginGenerations,
} from '@/plugins/store/registry/generationCustodyRetirement';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import {
  resolveTrackedSessionCatalogAgentId,
} from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import {
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import type { TrackedSession } from '@/daemon/types';
import {
  readSessionMarkerForPid,
  updateSessionMarkerRunnerAgentImmutableGenerationId,
  updateSessionMarkerRunnerManagedDependencyRetention,
  updateSessionMarkerRunnerManagedProviderAuthority,
} from '@/daemon/sessionRegistry';
import {
  mergeRunnerManagedDependencyRetentionV1,
  type RunnerManagedDependencyRetentionV1,
  withRunnerManagedProviderAuthorityRetention,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';

import {
  publishAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
  type AgentRuntimeDaemonServiceAuthorityDocumentV2,
  type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';
import {
  clearTrackedRunnerAgentDaemonServiceAdmission,
} from './clearTrackedRunnerAgentDaemonServiceAdmission';

type ResolveCurrentRetainedAgent = (
  input: Readonly<{
    agentId: string;
  }>,
) => AgentSessionRunnerBindingV1 | Promise<AgentSessionRunnerBindingV1>;

function resolveRetainedAgentCurrentnessProof(
  retainedAgent: AgentSessionRunnerBindingV1,
): Readonly<{
  requiredAgentSessionRunnerFactoryLocalAgentId?: string;
  retainedManifestAuthority?: 'external' | 'bundled_first_party';
}> {
  return 'kind' in retainedAgent
    && retainedAgent.kind === 'host_declarative_acp_v1'
    ? Object.freeze({
        retainedManifestAuthority:
          resolveBundledImmutablePluginArtifact({
            bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
            pluginId: retainedAgent.pluginId,
            immutableGenerationId: retainedAgent.immutableGenerationId,
          })
            ? 'bundled_first_party' as const
            : 'external' as const,
      })
    : Object.freeze({
        requiredAgentSessionRunnerFactoryLocalAgentId:
          retainedAgent.localAgentId,
      });
}

async function resolveTrackedRunnerIdentity(input: Readonly<{
  tracked: TrackedSession;
  readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
}>): Promise<AgentRuntimeDaemonServiceAuthorityRunnerIdentity> {
  const runnerPid =
    input.tracked.sessionRunnerPid ?? input.tracked.pid;
  const identity = await (
    input.readProcessIdentityByPidFn ?? readProcessIdentityByPid
  )(runnerPid);
  const processStartTimeMs = identity?.processStartTimeMs;
  if (
    !identity
    || identity.pid !== runnerPid
    || typeof processStartTimeMs !== 'number'
  ) {
    throw new Error(
      'Runner Agent daemon-service authority process identity is unavailable',
    );
  }
  const processCommandHash = hashProcessCommand(identity.command);
  if (
    (
      input.tracked.processCommandHash !== undefined
      && input.tracked.processCommandHash !== processCommandHash
    )
    || (
      input.tracked.processStartTimeMs !== undefined
      && input.tracked.processStartTimeMs !== processStartTimeMs
    )
  ) {
    throw new Error(
      'Runner Agent daemon-service authority process identity changed',
    );
  }
  const snapshot =
    resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      identity.command,
    );
  if (snapshot.status !== 'known') {
    throw new Error(
      'Runner Agent daemon-service authority snapshot identity is unavailable',
    );
  }
  return Object.freeze({
    pid: runnerPid,
    processStartTimeMs,
    processCommandHash,
    snapshotIdentity: snapshot.comparableId,
  });
}

function resolveTrackedRunnerAgentId(input: Readonly<{
  tracked: TrackedSession;
}>): string | null {
  const bootstrapIdentity = input.tracked.runnerAgentBootstrapIdentity;
  if (bootstrapIdentity !== undefined) {
    const agentId = typeof bootstrapIdentity.agentId === 'string'
      ? bootstrapIdentity.agentId.trim()
      : '';
    const backendId = typeof bootstrapIdentity.backendId === 'string'
      ? bootstrapIdentity.backendId.trim()
      : '';
    if (!agentId || !backendId) {
      return null;
    }
    return agentId;
  }
  const catalogAgentId =
    resolveTrackedSessionCatalogAgentId(input.tracked);
  if (catalogAgentId) return catalogAgentId;
  return null;
}

async function readReusableExistingAuthority(input: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: Parameters<
    typeof readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker
  >[0]['publicReleaseRing'];
  path: string;
  sessionId: string;
  runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  readPluginHardRevocationRevision: (
    pluginId: string,
  ) => Promise<number>;
  readPluginImmutableGenerationIntegrityCurrentness: (
    pluginId: string,
    immutableGenerationId: string,
    requiredAgentSessionRunnerFactoryLocalAgentId?: string,
    retainedManifestAuthority?: 'external' | 'bundled_first_party',
  ) => Promise<boolean>;
}>): Promise<Readonly<{
  status: 'reusable';
  retainedAgent: AgentSessionRunnerBindingV1;
  pluginHardRevocationRevision: number;
}> | Readonly<{ status: 'hardRevoked' }> | Readonly<{
  status: 'integrityFailure';
  pluginId: string;
  immutableGenerationId: string;
}> | Readonly<{ status: 'unavailable' }> | null> {
  const authority =
    await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: input.publicReleaseRing,
      path: input.path,
      sessionId: input.sessionId,
      runner: input.runner,
    });
  if (
    !authority
    || authority.runner.snapshotIdentity
      !== input.runner.snapshotIdentity
  ) {
    return null;
  }
  const retainedAgent = authority.retainedAgent;
  const pluginId = retainedAgent.pluginId;
  const currentHardRevocationRevision =
    await input.readPluginHardRevocationRevision(pluginId);
  if (
    authority.pluginHardRevocationRevision
      !== currentHardRevocationRevision
  ) {
    return Object.freeze({ status: 'hardRevoked' });
  }
  const currentnessProof =
    resolveRetainedAgentCurrentnessProof(retainedAgent);
  if (!await input.readPluginImmutableGenerationIntegrityCurrentness(
    pluginId,
    retainedAgent.immutableGenerationId,
    currentnessProof.requiredAgentSessionRunnerFactoryLocalAgentId,
    currentnessProof.retainedManifestAuthority,
  )) {
    return Object.freeze({
      status: 'integrityFailure',
      pluginId,
      immutableGenerationId: retainedAgent.immutableGenerationId,
    });
  }
  try {
    await loadRetainedAgentRuntimeLeaf({
      paths: resolvePluginStorePaths({
        happyHomeDir: input.happyHomeDir,
      }),
      binding: retainedAgent,
    });
  } catch {
    // A generation can remain exactly current while its runtime is temporarily
    // unavailable, incompatible with this host, or missing an optional export.
    // Only the explicit immutable-currentness owner above proves custody or
    // integrity failure and may trigger hard revocation.
    return Object.freeze({ status: 'unavailable' });
  }
  return Object.freeze({
    status: 'reusable',
    retainedAgent,
    pluginHardRevocationRevision:
      currentHardRevocationRevision,
  });
}

export async function refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority(
  input: Readonly<{
    happyHomeDir: string;
    publicReleaseRing: Parameters<
      typeof publishAgentRuntimeDaemonServiceAuthority
    >[0]['publicReleaseRing'];
    httpPort: number;
    sessionId: string;
    tracked: TrackedSession;
    resolveCurrentRetainedAgent: ResolveCurrentRetainedAgent;
    reserveManagedDependencyRetention?(
      retainedAgent: AgentSessionRunnerBindingV1,
    ): Readonly<{
      retention: RunnerManagedDependencyRetentionV1;
      release(): void;
    }> | Promise<Readonly<{
      retention: RunnerManagedDependencyRetentionV1;
      release(): void;
    }>>;
    persistRunnerManagedDependencyRetention?:
      typeof updateSessionMarkerRunnerManagedDependencyRetention;
    persistRunnerAgentImmutableGenerationId?:
      typeof updateSessionMarkerRunnerAgentImmutableGenerationId;
    attachRunnerRetainedPluginGenerations?:
      typeof attachExactRunnerRetainedPluginGenerations;
    readProcessIdentityByPidFn?: typeof readProcessIdentityByPid;
    readPluginHardRevocationRevision?: (
      pluginId: string,
    ) => Promise<number>;
    readPluginImmutableGenerationIntegrityCurrentness?: (
      pluginId: string,
      immutableGenerationId: string,
      requiredAgentSessionRunnerFactoryLocalAgentId?: string,
      retainedManifestAuthority?: 'external' | 'bundled_first_party',
    ) => Promise<boolean>;
    hardRevokeRunningSessionsForGenerationIntegrityFailure?: (
      input: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
      }>,
    ) => Promise<void>;
  }>,
): Promise<Readonly<{
  path: string;
  capabilityDigest: string;
  document: AgentRuntimeDaemonServiceAuthorityDocumentV2;
}>> {
  const sessionId = input.sessionId.trim();
  const authorityPath =
    input.tracked.agentRuntimeDaemonServiceAuthorityFilePath;
  if (!sessionId || !authorityPath) {
    throw new Error(
      'Runner Agent daemon-service authority path is unavailable',
    );
  }
  if (
    typeof input.tracked.happySessionId === 'string'
    && input.tracked.happySessionId.trim() !== sessionId
  ) {
    throw new Error(
      'Runner Agent daemon-service authority session identity changed',
    );
  }
  const runner = await resolveTrackedRunnerIdentity({
    tracked: input.tracked,
    ...(input.readProcessIdentityByPidFn
      ? {
          readProcessIdentityByPidFn:
            input.readProcessIdentityByPidFn,
        }
      : {}),
  });
  const paths = resolvePluginStorePaths({
    happyHomeDir: input.happyHomeDir,
  });
  const readPluginHardRevocationRevision =
    input.readPluginHardRevocationRevision
    ?? (async (pluginId: string) =>
      await readCurrentPluginHardRevocationRevision({ paths, pluginId }));
  const readPluginImmutableGenerationIntegrityCurrentness =
    input.readPluginImmutableGenerationIntegrityCurrentness
    ?? (async (
      pluginId: string,
      immutableGenerationId: string,
      requiredAgentSessionRunnerFactoryLocalAgentId?: string,
      retainedManifestAuthority?: 'external' | 'bundled_first_party',
    ) =>
      await readCurrentPluginImmutableGenerationIntegrityCurrentness({
        paths,
        pluginId,
        immutableGenerationId,
        bundledArtifacts:
          BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
        ...(requiredAgentSessionRunnerFactoryLocalAgentId
          ? { requiredAgentSessionRunnerFactoryLocalAgentId }
          : {}),
        ...(retainedManifestAuthority
          ? { retainedManifestAuthority }
          : {}),
      }));
  const trackedManagedProviderCleanupAuthority =
    input.tracked.runnerManagedDependencyRetentionV1
      ?.adoptedManagedProviderAuthority;
  const persistedMarker = await readSessionMarkerForPid(runner.pid);
  const persistedMarkerIsExact = Boolean(
    persistedMarker
    && persistedMarker.happySessionId === sessionId
    && persistedMarker.processCommandHash
      === runner.processCommandHash
    && persistedMarker.processStartTimeMs
      === runner.processStartTimeMs,
  );
  const persistedManagedDependencyRetention =
    persistedMarkerIsExact
      ? persistedMarker?.runnerManagedDependencyRetentionV1
      : input.tracked.runnerManagedDependencyRetentionV1;
  const adoptedManagedProviderAuthority =
    persistedManagedDependencyRetention
      ?.adoptedManagedProviderAuthority;
  if (adoptedManagedProviderAuthority) {
    let currentHardRevocationRevision: number;
    try {
      currentHardRevocationRevision =
        await readPluginHardRevocationRevision(
          adoptedManagedProviderAuthority.pluginId,
        );
    } catch {
      throw new Error(
        'Reattached Runner Agent retained Provider authority currentness is unavailable',
      );
    }
    if (
      currentHardRevocationRevision
      !== adoptedManagedProviderAuthority
        .hardRevocationRevisionAtAdmission
      || !await readPluginImmutableGenerationIntegrityCurrentness(
        adoptedManagedProviderAuthority.pluginId,
        adoptedManagedProviderAuthority.immutableGenerationId,
        undefined,
        adoptedManagedProviderAuthority.manifestAuthority,
      )
      || await readPluginHardRevocationRevision(
        adoptedManagedProviderAuthority.pluginId,
      )
        !== adoptedManagedProviderAuthority
          .hardRevocationRevisionAtAdmission
    ) {
      throw new Error(
        'Reattached Runner Agent retained Provider authority is hard-revoked',
      );
    }
  }
  const reusableAuthority = await readReusableExistingAuthority({
    happyHomeDir: input.happyHomeDir,
    publicReleaseRing: input.publicReleaseRing,
    path: authorityPath,
    sessionId,
    runner,
    readPluginHardRevocationRevision,
    readPluginImmutableGenerationIntegrityCurrentness,
  });
  if (reusableAuthority?.status === 'hardRevoked') {
    throw new Error(
      'Reattached Runner Agent daemon-service authority is hard-revoked',
    );
  }
  if (reusableAuthority?.status === 'integrityFailure') {
    if (!input.hardRevokeRunningSessionsForGenerationIntegrityFailure) {
      throw new Error(
        'Reattached Runner Agent daemon-service authority is hard-revoked because generation integrity currentness is unavailable',
      );
    }
    await input.hardRevokeRunningSessionsForGenerationIntegrityFailure({
      pluginId: reusableAuthority.pluginId,
      immutableGenerationId:
        reusableAuthority.immutableGenerationId,
    });
    throw new Error(
      'Reattached Runner Agent daemon-service authority is hard-revoked after immutable generation integrity failure',
    );
  }
  const reusable = reusableAuthority?.status === 'reusable'
    ? reusableAuthority
    : null;
  if (!reusable && input.tracked.reattachedFromDiskMarker) {
    throw new Error(
      'Reattached Runner Agent daemon-service authority is unavailable',
    );
  }
  const retainedAgent = reusable?.retainedAgent ?? await (async () => {
    const agentId = resolveTrackedRunnerAgentId({
      tracked: input.tracked,
    });
    if (!agentId) {
      throw new Error(
        'Runner Agent daemon-service authority Agent identity is unavailable',
      );
    }
    return await input.resolveCurrentRetainedAgent({
      agentId,
    });
  })();
  const retainedAgentCurrentnessProof =
    resolveRetainedAgentCurrentnessProof(retainedAgent);
  if (!await readPluginImmutableGenerationIntegrityCurrentness(
    retainedAgent.pluginId,
    retainedAgent.immutableGenerationId,
    retainedAgentCurrentnessProof
      .requiredAgentSessionRunnerFactoryLocalAgentId,
    retainedAgentCurrentnessProof.retainedManifestAuthority,
  )) {
    throw new Error(
      'Runner Agent daemon-service authority immutable generation is hard-revoked',
    );
  }
  const expectedPluginHardRevocationRevision =
    reusable?.pluginHardRevocationRevision
    ?? await readPluginHardRevocationRevision(
      retainedAgent.pluginId,
    );
  const managedDependencyReservation =
    reusable
      ? null
      : await input.reserveManagedDependencyRetention?.(retainedAgent);
  const runnerManagedDependencyRetentionV1 =
    withRunnerManagedProviderAuthorityRetention(
      reusable
        ? mergeRunnerManagedDependencyRetentionV1(
            persistedManagedDependencyRetention,
          )
        : mergeRunnerManagedDependencyRetentionV1(
            managedDependencyReservation?.retention,
          ),
      adoptedManagedProviderAuthority ?? null,
  );
  try {
    const custodyPersisted = await (
      input.attachRunnerRetainedPluginGenerations
      ?? attachExactRunnerRetainedPluginGenerations
    )({
      paths,
      immutableGenerationIds: [
        retainedAgent.immutableGenerationId,
        ...runnerManagedDependencyRetentionV1.sourceGenerationIds,
        ...(runnerManagedDependencyRetentionV1
          .adoptedManagedProviderAuthority
          ? [runnerManagedDependencyRetentionV1
            .adoptedManagedProviderAuthority.immutableGenerationId]
          : []),
      ],
      attach: async () => {
        if (
          !await (
            input.persistRunnerAgentImmutableGenerationId
            ?? updateSessionMarkerRunnerAgentImmutableGenerationId
          )({
            pid: runner.pid,
            sessionId,
            processCommandHash: runner.processCommandHash,
            processStartTimeMs: runner.processStartTimeMs,
            immutableGenerationId:
              retainedAgent.immutableGenerationId,
          })
        ) {
          throw new Error(
            'Runner Agent immutable generation retention attachment is unavailable',
          );
        }
        if (
          !await (
            input.persistRunnerManagedDependencyRetention
            ?? updateSessionMarkerRunnerManagedDependencyRetention
          )({
            pid: runner.pid,
            sessionId,
            processCommandHash: runner.processCommandHash,
            processStartTimeMs: runner.processStartTimeMs,
            retention: runnerManagedDependencyRetentionV1,
          })
        ) {
          throw new Error(
            'Runner Agent managed-dependency retention attachment is unavailable',
          );
        }
        return true;
      },
    });
    if (!custodyPersisted) {
      throw new Error(
        'Runner Agent generation custody attachment is unavailable',
      );
    }
  } finally {
    managedDependencyReservation?.release();
  }
  const published =
    await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: input.publicReleaseRing,
      path: authorityPath,
      sessionId,
      runner,
      retainedAgent,
      expectedPluginHardRevocationRevision,
      readPluginHardRevocationRevision,
      httpPort: input.httpPort,
    });
  input.tracked.agentRuntimeDaemonServiceCapabilityHash =
    published.capabilityDigest;
  input.tracked.runnerAgentImmutableGenerationId =
    retainedAgent.immutableGenerationId;
  input.tracked.runnerManagedDependencyRetentionV1 =
    withRunnerManagedProviderAuthorityRetention(
      runnerManagedDependencyRetentionV1,
      adoptedManagedProviderAuthority
        ?? trackedManagedProviderCleanupAuthority
        ?? null,
    );
  const retainedAgentCurrent =
    await readPluginImmutableGenerationIntegrityCurrentness(
      retainedAgent.pluginId,
      retainedAgent.immutableGenerationId,
      retainedAgentCurrentnessProof
        .requiredAgentSessionRunnerFactoryLocalAgentId,
      retainedAgentCurrentnessProof.retainedManifestAuthority,
    )
    // Hard revocation is the final async fence: an advance while immutable
    // currentness awaits must not leave the just-published authority installed.
    && await readPluginHardRevocationRevision(
      retainedAgent.pluginId,
    ) === expectedPluginHardRevocationRevision;
  let retainedProviderCurrent = true;
  if (adoptedManagedProviderAuthority && retainedAgentCurrent) {
    try {
      retainedProviderCurrent =
        await readPluginHardRevocationRevision(
          adoptedManagedProviderAuthority.pluginId,
        ) === adoptedManagedProviderAuthority
          .hardRevocationRevisionAtAdmission;
    } catch {
      retainedProviderCurrent = false;
    }
  }
  if (!retainedAgentCurrent || !retainedProviderCurrent) {
    if (
      input.tracked.agentRuntimeDaemonServiceCapabilityHash
        === published.capabilityDigest
    ) {
      delete input.tracked.agentRuntimeDaemonServiceCapabilityHash;
      clearTrackedRunnerAgentDaemonServiceAdmission(input.tracked);
    }
    if (adoptedManagedProviderAuthority && !retainedProviderCurrent) {
      await updateSessionMarkerRunnerManagedProviderAuthority({
        pid: runner.pid,
        sessionId,
        processCommandHash: runner.processCommandHash,
        processStartTimeMs: runner.processStartTimeMs,
        authority: null,
        expectedAuthority: adoptedManagedProviderAuthority,
      }).catch(() => false);
      input.tracked.runnerManagedDependencyRetentionV1 =
        withRunnerManagedProviderAuthorityRetention(
          input.tracked.runnerManagedDependencyRetentionV1,
          null,
        );
    }
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: input.publicReleaseRing,
      path: published.path,
      capabilityDigest: published.capabilityDigest,
    }).catch(() => false);
    throw new Error(
      'Runner Agent daemon-service authority was hard-revoked before tracked authority installation completed',
    );
  }
  delete input.tracked.runnerAgentBootstrapIdentity;
  return published;
}
