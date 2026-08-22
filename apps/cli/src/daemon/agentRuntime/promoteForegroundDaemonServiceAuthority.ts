import type {
  RunnerAgentInvocationContext,
  TrackedSession,
} from '@/daemon/types';
import {
  clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned,
  updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath,
  updateSessionMarkerRunnerAgentImmutableGenerationId,
  updateSessionMarkerRunnerManagedDependencyRetention,
} from '@/daemon/sessionRegistry';
import {
  type AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { isReservedHappierPluginId } from '@happier-dev/protocol';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import {
  readCurrentPluginHardRevocationRevision,
  readCurrentPluginImmutableGenerationIntegrityCurrentness,
} from '@/plugins/store/registry/generationStore';
import {
  attachExactRunnerRetainedPluginGenerations,
} from '@/plugins/store/registry/generationCustodyRetirement';
import {
  mergeRunnerManagedDependencyRetentionV1,
  type RunnerManagedDependencyRetentionV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';
import { verifyPrivateBearer } from '@/daemon/privateBearerFile';
import { isDeepStrictEqual } from 'node:util';
import {
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
  type AgentRuntimeDaemonServiceAuthorityDocumentV2,
  type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';
import {
  clearTrackedRunnerAgentDaemonServiceAdmission,
} from './clearTrackedRunnerAgentDaemonServiceAdmission';

function clearPromotedAuthorityIfExact(input: Readonly<{
  tracked: TrackedSession;
  authorityFilePath: string;
  capabilityDigest: string;
}>): void {
  if (
    input.tracked.agentRuntimeDaemonServiceAuthorityFilePath
      !== input.authorityFilePath
    || input.tracked.agentRuntimeDaemonServiceCapabilityHash
      !== input.capabilityDigest
  ) {
    return;
  }
  delete input.tracked.agentRuntimeDaemonServiceAuthorityFilePath;
  delete input.tracked.agentRuntimeDaemonServiceCapabilityHash;
  clearTrackedRunnerAgentDaemonServiceAdmission(input.tracked);
}

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
          isReservedHappierPluginId(retainedAgent.pluginId)
            ? 'bundled_first_party' as const
            : 'external' as const,
      })
    : Object.freeze({
        requiredAgentSessionRunnerFactoryLocalAgentId:
          retainedAgent.localAgentId,
      });
}

export async function promoteForegroundDaemonServiceAuthority(input: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: Parameters<
    typeof readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker
  >[0]['publicReleaseRing'];
  trackedSessions: ReadonlyMap<number, TrackedSession>;
  canonicalSessionId: string;
  foregroundPid: number;
  authorityFilePath: string;
  retainedAgent: AgentSessionRunnerBindingV1;
  runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
  runnerManagedDependencyRetentionV1?:
    RunnerManagedDependencyRetentionV1;
  capabilityDigest: string;
  invocationContext: RunnerAgentInvocationContext;
  persistAuthorityPath?: typeof updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath;
  persistRunnerAgentImmutableGenerationId?:
    typeof updateSessionMarkerRunnerAgentImmutableGenerationId;
  persistRunnerManagedDependencyRetention?:
    typeof updateSessionMarkerRunnerManagedDependencyRetention;
  attachRunnerRetainedPluginGenerations?:
    typeof attachExactRunnerRetainedPluginGenerations;
  clearPersistedPromotion?:
    typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned;
  readPluginImmutableGenerationIntegrityCurrentness?: (
    pluginId: string,
    immutableGenerationId: string,
    requiredAgentSessionRunnerFactoryLocalAgentId?: string,
    retainedManifestAuthority?: 'external' | 'bundled_first_party',
  ) => Promise<boolean>;
}>): Promise<boolean> {
  const tracked =
    input.trackedSessions.get(input.foregroundPid)
    ?? [...input.trackedSessions.values()].find((candidate) =>
      candidate.happySessionId === input.canonicalSessionId
      && (
        candidate.pid === input.foregroundPid
        || candidate.sessionRunnerPid === input.foregroundPid
      )
    );
  const runner = input.runner;
  if (
    !tracked
    || tracked.startedBy === 'daemon'
    || tracked.happySessionId !== input.canonicalSessionId
    || runner.pid !== input.foregroundPid
    || (
      tracked.processStartTimeMs !== undefined
      && tracked.processStartTimeMs !== runner.processStartTimeMs
    )
    || (
      tracked.processCommandHash !== undefined
      && tracked.processCommandHash !== runner.processCommandHash
    )
  ) {
    return false;
  }

  const paths = resolvePluginStorePaths({
    happyHomeDir: input.happyHomeDir,
  });
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
  const generationCurrentnessProof =
    resolveRetainedAgentCurrentnessProof(input.retainedAgent);
  const runnerManagedDependencyRetentionV1 =
    mergeRunnerManagedDependencyRetentionV1(
      input.runnerManagedDependencyRetentionV1,
    );
  const readExactCurrentAuthority = async (
    expectedDocument?: AgentRuntimeDaemonServiceAuthorityDocumentV2,
  ): Promise<AgentRuntimeDaemonServiceAuthorityDocumentV2 | null> => {
    const document =
      await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
        happyHomeDir: input.happyHomeDir,
        publicReleaseRing: input.publicReleaseRing,
        path: input.authorityFilePath,
        sessionId: input.canonicalSessionId,
        runner,
      });
    if (
      !document
      || !isDeepStrictEqual(
        document.retainedAgent,
        input.retainedAgent,
      )
      || !verifyPrivateBearer({
        provided: document.capability,
        expectedHash: input.capabilityDigest,
      })
      || (
        expectedDocument
        && JSON.stringify(document) !== JSON.stringify(expectedDocument)
      )
      || !await readPluginImmutableGenerationIntegrityCurrentness(
        input.retainedAgent.pluginId,
        input.retainedAgent.immutableGenerationId,
        generationCurrentnessProof
          .requiredAgentSessionRunnerFactoryLocalAgentId,
        generationCurrentnessProof.retainedManifestAuthority,
      )
      || await readCurrentPluginHardRevocationRevision({
        paths,
        pluginId: input.retainedAgent.pluginId,
      }) !== document.pluginHardRevocationRevision
    ) {
      return null;
    }
    return document;
  };
  const removeStaleAuthority = async (): Promise<void> => {
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: input.publicReleaseRing,
      path: input.authorityFilePath,
      capabilityDigest: input.capabilityDigest,
    }).catch(() => false);
  };
  const clearPersistedPromotion = async (includeCustody: boolean): Promise<void> => {
    await (
      input.clearPersistedPromotion
      ?? clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
    )({
      pid: input.foregroundPid,
      sessionId: input.canonicalSessionId,
      processCommandHash: runner.processCommandHash,
      processStartTimeMs: runner.processStartTimeMs,
      authorityFilePath: input.authorityFilePath,
      ...(includeCustody
        ? {
            immutableGenerationId: input.retainedAgent.immutableGenerationId,
            retention: runnerManagedDependencyRetentionV1,
          }
        : {}),
    }).catch(() => false);
  };
  const expectedAuthority = await readExactCurrentAuthority();
  if (!expectedAuthority) {
    await removeStaleAuthority();
    return false;
  }

  if (
    tracked.sessionMarkerPersistence
    && !await tracked.sessionMarkerPersistence
  ) {
    await removeStaleAuthority();
    return false;
  }

  // Marker persistence can wait behind foreground-session startup. A hard
  // revocation that wins during that wait must prevent every later durable
  // marker/custody write, rather than being discovered only after one exists.
  if (!await readExactCurrentAuthority(expectedAuthority)) {
    await removeStaleAuthority();
    return false;
  }

  const persisted = await (
    input.persistAuthorityPath
    ?? updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath
  )({
    pid: input.foregroundPid,
    sessionId: input.canonicalSessionId,
    processCommandHash: runner.processCommandHash,
    processStartTimeMs: runner.processStartTimeMs,
    authorityFilePath: input.authorityFilePath,
  });
  if (!persisted) {
    await removeStaleAuthority();
    return false;
  }

  // Currentness can change while the authority-path write holds the marker
  // lock. Remove that candidate-owned path before it can acquire generation
  // custody or make a stale marker survive the failed promotion.
  if (!await readExactCurrentAuthority(expectedAuthority)) {
    await clearPersistedPromotion(false);
    await removeStaleAuthority();
    return false;
  }
  const custodyPersisted = await (
    input.attachRunnerRetainedPluginGenerations
    ?? attachExactRunnerRetainedPluginGenerations
  )({
    paths,
      immutableGenerationIds: [
      input.retainedAgent.immutableGenerationId,
      ...runnerManagedDependencyRetentionV1.sourceGenerationIds,
      ...(runnerManagedDependencyRetentionV1
        .adoptedManagedProviderAuthority
        ? [runnerManagedDependencyRetentionV1
          .adoptedManagedProviderAuthority.immutableGenerationId]
        : []),
    ],
    attach: async () => {
      const generationPersisted = await (
        input.persistRunnerAgentImmutableGenerationId
        ?? updateSessionMarkerRunnerAgentImmutableGenerationId
      )({
        pid: input.foregroundPid,
        sessionId: input.canonicalSessionId,
        processCommandHash: runner.processCommandHash,
        processStartTimeMs: runner.processStartTimeMs,
        immutableGenerationId:
          input.retainedAgent.immutableGenerationId,
      });
      if (!generationPersisted) return false;
      return await (
        input.persistRunnerManagedDependencyRetention
        ?? updateSessionMarkerRunnerManagedDependencyRetention
      )({
        pid: input.foregroundPid,
        sessionId: input.canonicalSessionId,
        processCommandHash: runner.processCommandHash,
        processStartTimeMs: runner.processStartTimeMs,
        retention: runnerManagedDependencyRetentionV1,
      });
    },
  });
  if (!custodyPersisted) {
    await clearPersistedPromotion(false);
    await removeStaleAuthority();
    return false;
  }

  if (!await readExactCurrentAuthority(expectedAuthority)) {
    await clearPersistedPromotion(true);
    await removeStaleAuthority();
    return false;
  }

  tracked.processStartTimeMs = runner.processStartTimeMs;
  tracked.processCommandHash = runner.processCommandHash;
  tracked.agentRuntimeDaemonServiceAuthorityFilePath =
    input.authorityFilePath;
  tracked.agentRuntimeDaemonServiceCapabilityHash =
    input.capabilityDigest;
  tracked.runnerAgentImmutableGenerationId =
    input.retainedAgent.immutableGenerationId;
  tracked.runnerManagedDependencyRetentionV1 =
    runnerManagedDependencyRetentionV1;
  tracked.runnerAgentInvocationContext = Object.freeze({
    cwd: input.invocationContext.cwd,
    environment: Object.freeze({}),
    providerBindingActive: false,
  });
  delete tracked.agentRuntimeRunnerRestartDisposition;
  if (!await readExactCurrentAuthority(expectedAuthority)) {
    clearPromotedAuthorityIfExact({
      tracked,
      authorityFilePath: input.authorityFilePath,
      capabilityDigest: input.capabilityDigest,
    });
    await clearPersistedPromotion(true);
    await removeStaleAuthority();
    return false;
  }
  return true;
}
