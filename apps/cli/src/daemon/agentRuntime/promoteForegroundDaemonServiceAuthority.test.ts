import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type {
  clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned,
  updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath,
  updateSessionMarkerRunnerAgentImmutableGenerationId,
  updateSessionMarkerRunnerManagedDependencyRetention,
} from '@/daemon/sessionRegistry';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { ensurePluginStoreDirectories } from '@/plugins/store/paths';
import {
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
  persistInstallationStateRevision,
  type PluginInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import type { RunnerManagedDependencyRetentionV1 } from '@/plugins/runtime/runner/runnerManagedDependencyRetention';

import {
  promoteForegroundDaemonServiceAuthority,
} from './promoteForegroundDaemonServiceAuthority';
import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
} from './sessionBridgeAuthorization';

const runner = Object.freeze({
  pid: 4242,
  processStartTimeMs: 2_000,
  processCommandHash: 'a'.repeat(64),
  snapshotIdentity: 'snapshot-1',
});

function retainedAgent(input?: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
}>) {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: input?.pluginId ?? 'plugin.acme',
    pluginVersion: '1.0.0',
    agentId: 'codex',
    localAgentId: 'codex',
    immutableGenerationId:
      input?.immutableGenerationId ?? 'generation-1',
    locator: {
      module: './agent/runtime/factory',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'agent/runtime/factory.mjs',
    loadMode: 'immutable-js',
  });
}

async function commitHardRevision(
  happyHomeDir: string,
  revision: number,
): Promise<void> {
  const paths = await ensurePluginStoreDirectories({ happyHomeDir });
  const state: PluginInstallationStateRevision = {
    t: 'happier_plugin_installations_v1',
    schemaVersion: 1,
    revisionId: `state-${revision}`,
    createdAtMs: revision + 1,
    plugins: {},
    rollbackRetention: [],
    hardRevocationRevisions: {
      'plugin.acme': revision,
    },
    retainedRuntimeCatalog: {},
  };
  const installationState = await persistInstallationStateRevision({
    paths,
    state,
  });
  await replacePluginRegistryCommitRecord({
    paths,
    expectedCurrent: revision === 0 ? null : await readPluginRegistryCommitRecord(paths),
    next: PluginRegistryCommitRecordSchema.parse({
      t: 'happier_plugin_registry_commit_v1',
      schemaVersion: 1,
      revision,
      transactionId: `hard-${revision}`,
      baseRevision: revision === 0 ? null : revision - 1,
      installationState,
      pluginGenerations: {},
      createdAtMs: revision + 1,
      creator: { pid: 42, instanceId: 'promotion-test' },
    }),
  });
}

async function createPublishedAuthority(
  retained: ReturnType<typeof retainedAgent> = retainedAgent(),
) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-foreground-promotion-'));
  await commitHardRevision(happyHomeDir, 0);
  const authorityFilePath =
    await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir,
      publicReleaseRing: 'stable',
    });
  const published = await publishAgentRuntimeDaemonServiceAuthority({
    happyHomeDir,
    publicReleaseRing: 'stable',
    path: authorityFilePath,
    sessionId: 'canonical-session-1',
    runner,
    retainedAgent: retained,
    httpPort: 3210,
    capability: 'A'.repeat(43),
  });
  return {
    happyHomeDir,
    sessionId: 'canonical-session-1',
    runner,
    retainedAgent: retained,
    authorityFilePath,
    published,
  };
}

const attachRunnerRetainedPluginGenerations = async (
  input: Readonly<{ attach: () => Promise<boolean> }>,
) => await input.attach();

describe('promoteForegroundDaemonServiceAuthority', () => {
  it('does not promote authority published before a durable hard revocation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-foreground-hard-promotion-'));
    try {
      await commitHardRevision(happyHomeDir, 0);
      const retained = retainedAgent();
      const authorityFilePath =
        await createAgentRuntimeDaemonServiceAuthorityPath({
          happyHomeDir,
          publicReleaseRing: 'stable',
        });
      const published =
        await publishAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          path: authorityFilePath,
          sessionId: 'canonical-session-1',
          runner,
          retainedAgent: retained,
          httpPort: 3210,
          capability: 'A'.repeat(43),
        });
      await commitHardRevision(happyHomeDir, 1);
      const tracked: TrackedSession = {
        pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy:
          'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const persistAuthorityPath = vi.fn(async () => true);
      const persistRunnerAgentImmutableGenerationId =
        vi.fn(async () => true);
      const persistRunnerManagedDependencyRetention =
        vi.fn(async () => true);
      type CurrentnessAwarePromotionInput = Parameters<
        typeof promoteForegroundDaemonServiceAuthority
      >[0] & Readonly<{
        happyHomeDir: string;
        publicReleaseRing: 'stable';
      }>;
      const promote =
        promoteForegroundDaemonServiceAuthority as unknown as (
          input: CurrentnessAwarePromotionInput,
        ) => ReturnType<
          typeof promoteForegroundDaemonServiceAuthority
        >;

      await expect(promote({
        happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: 'canonical-session-1',
        foregroundPid: tracked.pid,
        authorityFilePath,
        retainedAgent: retained,
        runner,
        capabilityDigest: published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath,
        persistRunnerAgentImmutableGenerationId,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      })).resolves.toBe(false);

      expect(persistAuthorityPath).not.toHaveBeenCalled();
      expect(persistRunnerAgentImmutableGenerationId)
        .not.toHaveBeenCalled();
      expect(persistRunnerManagedDependencyRetention)
        .not.toHaveBeenCalled();
      expect(tracked).not.toHaveProperty(
        'agentRuntimeDaemonServiceCapabilityHash',
      );
      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir,
          publicReleaseRing: 'stable',
          path: authorityFilePath,
          sessionId: 'canonical-session-1',
          runner,
        }),
      ).resolves.toBeNull();
      await expect(access(authorityFilePath))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('does not persist marker or custody when hard revocation wins while promotion waits', async () => {
    const fixture = await createPublishedAuthority();
    try {
      const tracked: TrackedSession = {
        pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      let releaseMarkerPersistence!: (persisted: boolean) => void;
      tracked.sessionMarkerPersistence = new Promise<boolean>((resolve) => {
        releaseMarkerPersistence = resolve;
      });
      const persistAuthorityPath = vi.fn(async () => true);
      const persistRunnerAgentImmutableGenerationId = vi.fn(async () => true);
      const persistRunnerManagedDependencyRetention = vi.fn(async () => true);
      const readPluginImmutableGenerationIntegrityCurrentness = vi.fn(async () => true);

      const promotion = promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: fixture.sessionId,
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: fixture.retainedAgent,
        runner: fixture.runner,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath,
        persistRunnerAgentImmutableGenerationId,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness,
      });

      await vi.waitFor(() => {
        expect(readPluginImmutableGenerationIntegrityCurrentness).toHaveBeenCalledOnce();
      });
      await commitHardRevision(fixture.happyHomeDir, 1);
      releaseMarkerPersistence(true);

      await expect(promotion).resolves.toBe(false);
      expect(persistAuthorityPath).not.toHaveBeenCalled();
      expect(persistRunnerAgentImmutableGenerationId).not.toHaveBeenCalled();
      expect(persistRunnerManagedDependencyRetention).not.toHaveBeenCalled();
      expect(tracked).not.toHaveProperty(
        'agentRuntimeDaemonServiceCapabilityHash',
      );
      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir: fixture.happyHomeDir,
          publicReleaseRing: 'stable',
          path: fixture.authorityFilePath,
          sessionId: fixture.sessionId,
          runner: fixture.runner,
        }),
      ).resolves.toBeNull();
      await expect(access(fixture.authorityFilePath))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

  it('clears the marker path before custody when hard revocation wins during its write', async () => {
    const fixture = await createPublishedAuthority();
    try {
      const tracked: TrackedSession = {
        pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      let releaseAuthorityWrite!: () => void;
      const authorityWrite = new Promise<void>((resolve) => {
        releaseAuthorityWrite = resolve;
      });
      let persistedAuthorityPath: string | undefined;
      const persistAuthorityPath = vi.fn(async ({
        authorityFilePath,
      }: Parameters<
        typeof updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath
      >[0]) => {
        persistedAuthorityPath = authorityFilePath;
        await authorityWrite;
        return true;
      });
      const clearPersistedPromotion = vi.fn(async ({
        authorityFilePath,
        immutableGenerationId,
        retention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          immutableGenerationId !== undefined
          || retention !== undefined
          || persistedAuthorityPath !== authorityFilePath
        ) {
          return false;
        }
        persistedAuthorityPath = undefined;
        return true;
      });
      const persistRunnerAgentImmutableGenerationId = vi.fn(async () => true);
      const persistRunnerManagedDependencyRetention = vi.fn(async () => true);

      const promotion = promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: fixture.sessionId,
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: fixture.retainedAgent,
        runner: fixture.runner,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath,
        persistRunnerAgentImmutableGenerationId,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        clearPersistedPromotion,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      });

      await vi.waitFor(() => {
        expect(persistAuthorityPath).toHaveBeenCalledOnce();
      });
      await commitHardRevision(fixture.happyHomeDir, 1);
      releaseAuthorityWrite();

      await expect(promotion).resolves.toBe(false);
      expect(clearPersistedPromotion).toHaveBeenCalledWith({
        pid: tracked.pid,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
      });
      expect(persistedAuthorityPath).toBeUndefined();
      expect(persistRunnerAgentImmutableGenerationId).not.toHaveBeenCalled();
      expect(persistRunnerManagedDependencyRetention).not.toHaveBeenCalled();
      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir: fixture.happyHomeDir,
          publicReleaseRing: 'stable',
          path: fixture.authorityFilePath,
          sessionId: fixture.sessionId,
          runner,
        }),
      ).resolves.toBeNull();
      await expect(access(fixture.authorityFilePath))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

  it('clears marker custody and the authority document when hard revocation wins during attachment', async () => {
    const fixture = await createPublishedAuthority();
    try {
      const tracked: TrackedSession = {
        pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const retention: RunnerManagedDependencyRetentionV1 = {
        v: 1 as const,
        sourceGenerationIds: [],
        qualifiedDependencyIds: [],
      };
      const persisted = {
        authorityFilePath: undefined as string | undefined,
        immutableGenerationId: undefined as string | undefined,
        retention: undefined as typeof retention | undefined,
      };
      let releaseCustodyAttachment!: () => void;
      const custodyAttachment = new Promise<void>((resolve) => {
        releaseCustodyAttachment = resolve;
      });
      const persistAuthorityPath = vi.fn(async ({
        authorityFilePath,
      }: Parameters<
        typeof updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath
      >[0]) => {
        persisted.authorityFilePath = authorityFilePath;
        return true;
      });
      const persistRunnerAgentImmutableGenerationId = vi.fn(async ({
        immutableGenerationId,
      }: Parameters<
        typeof updateSessionMarkerRunnerAgentImmutableGenerationId
      >[0]) => {
        persisted.immutableGenerationId = immutableGenerationId;
        return true;
      });
      const persistRunnerManagedDependencyRetention = vi.fn(async ({
        retention: nextRetention,
      }: Parameters<
        typeof updateSessionMarkerRunnerManagedDependencyRetention
      >[0]) => {
        persisted.retention = nextRetention;
        return true;
      });
      const clearPersistedPromotion = vi.fn(async ({
        authorityFilePath,
        immutableGenerationId,
        retention: expectedRetention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          persisted.authorityFilePath !== authorityFilePath
          || persisted.immutableGenerationId !== immutableGenerationId
          || JSON.stringify(persisted.retention)
            !== JSON.stringify(expectedRetention)
        ) {
          return false;
        }
        persisted.authorityFilePath = undefined;
        persisted.immutableGenerationId = undefined;
        persisted.retention = undefined;
        return true;
      });
      const attachRunnerRetainedPluginGenerations = vi.fn(async (
        input: Readonly<{ attach: () => Promise<boolean> }>,
      ) => {
        if (!await input.attach()) return false;
        await custodyAttachment;
        return true;
      });

      const promotion = promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: fixture.sessionId,
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: fixture.retainedAgent,
        runner: fixture.runner,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath,
        persistRunnerAgentImmutableGenerationId,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        clearPersistedPromotion,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      });

      await vi.waitFor(() => {
        expect(persistRunnerManagedDependencyRetention).toHaveBeenCalledOnce();
      });
      expect(persisted).toEqual({
        authorityFilePath: fixture.authorityFilePath,
        immutableGenerationId: fixture.retainedAgent.immutableGenerationId,
        retention,
      });
      await commitHardRevision(fixture.happyHomeDir, 1);
      releaseCustodyAttachment();

      await expect(promotion).resolves.toBe(false);
      expect(clearPersistedPromotion).toHaveBeenCalledWith({
        pid: tracked.pid,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
        immutableGenerationId: fixture.retainedAgent.immutableGenerationId,
        retention,
      });
      expect(persisted).toEqual({
        authorityFilePath: undefined,
        immutableGenerationId: undefined,
        retention: undefined,
      });
      expect(tracked).not.toHaveProperty(
        'agentRuntimeDaemonServiceCapabilityHash',
      );
      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir: fixture.happyHomeDir,
          publicReleaseRing: 'stable',
          path: fixture.authorityFilePath,
          sessionId: fixture.sessionId,
          runner,
        }),
      ).resolves.toBeNull();
      await expect(access(fixture.authorityFilePath))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

  it('clears the tracked and durable promotion when hard revocation wins during its final currentness read', async () => {
    const fixture = await createPublishedAuthority();
    try {
      const tracked: TrackedSession = {
        pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const retention: RunnerManagedDependencyRetentionV1 = {
        v: 1 as const,
        sourceGenerationIds: [],
        qualifiedDependencyIds: [],
      };
      const persisted = {
        authorityFilePath: undefined as string | undefined,
        immutableGenerationId: undefined as string | undefined,
        retention: undefined as typeof retention | undefined,
      };
      const persistAuthorityPath = vi.fn(async ({
        authorityFilePath,
      }: Parameters<
        typeof updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath
      >[0]) => {
        persisted.authorityFilePath = authorityFilePath;
        return true;
      });
      const persistRunnerAgentImmutableGenerationId = vi.fn(async ({
        immutableGenerationId,
      }: Parameters<
        typeof updateSessionMarkerRunnerAgentImmutableGenerationId
      >[0]) => {
        persisted.immutableGenerationId = immutableGenerationId;
        return true;
      });
      const persistRunnerManagedDependencyRetention = vi.fn(async ({
        retention: nextRetention,
      }: Parameters<
        typeof updateSessionMarkerRunnerManagedDependencyRetention
      >[0]) => {
        persisted.retention = nextRetention;
        return true;
      });
      const clearPersistedPromotion = vi.fn(async ({
        authorityFilePath,
        immutableGenerationId,
        retention: expectedRetention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          persisted.authorityFilePath !== authorityFilePath
          || persisted.immutableGenerationId !== immutableGenerationId
          || JSON.stringify(persisted.retention)
            !== JSON.stringify(expectedRetention)
        ) {
          return false;
        }
        persisted.authorityFilePath = undefined;
        persisted.immutableGenerationId = undefined;
        persisted.retention = undefined;
        return true;
      });
      let hardRevocationInjected = false;

      await expect(promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: fixture.sessionId,
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: fixture.retainedAgent,
        runner: fixture.runner,
        runnerManagedDependencyRetentionV1: retention,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath,
        persistRunnerAgentImmutableGenerationId,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        clearPersistedPromotion,
        readPluginImmutableGenerationIntegrityCurrentness: async () => {
          if (
            !hardRevocationInjected
            && tracked.agentRuntimeDaemonServiceCapabilityHash
              === fixture.published.capabilityDigest
          ) {
            hardRevocationInjected = true;
            await commitHardRevision(fixture.happyHomeDir, 1);
          }
          return true;
        },
      })).resolves.toBe(false);

      expect(hardRevocationInjected).toBe(true);
      expect(clearPersistedPromotion).toHaveBeenCalledWith({
        pid: tracked.pid,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
        immutableGenerationId: fixture.retainedAgent.immutableGenerationId,
        retention,
      });
      expect(persisted).toEqual({
        authorityFilePath: undefined,
        immutableGenerationId: undefined,
        retention: undefined,
      });
      expect(tracked).not.toHaveProperty(
        'agentRuntimeDaemonServiceCapabilityHash',
      );
      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir: fixture.happyHomeDir,
          publicReleaseRing: 'stable',
          path: fixture.authorityFilePath,
          sessionId: fixture.sessionId,
          runner,
        }),
      ).resolves.toBeNull();
      await expect(access(fixture.authorityFilePath))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

  it('persists the exact marker path before promoting the real terminal-started tracked owner', async () => {
    const bundledArtifact =
      BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
        (artifact) => artifact.record.pluginId === 'happier.agent.codex',
      );
    if (!bundledArtifact) {
      throw new Error('Expected generated bundled Codex artifact');
    }
    const fixture = await createPublishedAuthority(retainedAgent({
      pluginId: bundledArtifact.record.pluginId,
      immutableGenerationId:
        bundledArtifact.record.immutableGenerationId,
    }));
    try {
    const tracked: TrackedSession = {
      pid: 4242,
      happySessionId: 'canonical-session-1',
      startedBy: 'happy directly - likely by user from terminal',
      processStartTimeMs: 2_000,
      processCommandHash: 'a'.repeat(64),
      agentRuntimeRunnerRestartDisposition:
        'runner_authority_unavailable',
    };
    let releaseMarkerPersistence!: (persisted: boolean) => void;
    tracked.sessionMarkerPersistence = new Promise<boolean>((resolve) => {
      releaseMarkerPersistence = resolve;
    });
    const persistAuthorityPath = vi.fn(async () => true);
    const persistRunnerAgentImmutableGenerationId =
      vi.fn(async () => true);
    const persistRunnerManagedDependencyRetention =
      vi.fn(async () => true);

    const promotion = promoteForegroundDaemonServiceAuthority({
      happyHomeDir: fixture.happyHomeDir,
      publicReleaseRing: 'stable',
      trackedSessions: new Map([[tracked.pid, tracked]]),
      canonicalSessionId: 'canonical-session-1',
      foregroundPid: tracked.pid,
      authorityFilePath: fixture.authorityFilePath,
      retainedAgent: fixture.retainedAgent,
      runner: fixture.runner,
      capabilityDigest: fixture.published.capabilityDigest,
      invocationContext: {
        cwd: '/workspace',
        environment: {
          PROVIDER_SECRET: 'secret-value',
        },
        providerBindingActive: true,
      },
      persistAuthorityPath,
      persistRunnerAgentImmutableGenerationId,
      persistRunnerManagedDependencyRetention,
      attachRunnerRetainedPluginGenerations,
    });

    await Promise.resolve();
    expect(persistAuthorityPath).not.toHaveBeenCalled();
    expect(
      tracked.agentRuntimeDaemonServiceAuthorityFilePath,
    ).toBeUndefined();

    releaseMarkerPersistence(true);
    await expect(promotion).resolves.toBe(true);

    expect(persistAuthorityPath).toHaveBeenCalledWith({
      pid: 4242,
      sessionId: 'canonical-session-1',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 2_000,
      authorityFilePath: fixture.authorityFilePath,
    });
    expect(
      persistRunnerAgentImmutableGenerationId,
    ).toHaveBeenCalledWith({
      pid: 4242,
      sessionId: 'canonical-session-1',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 2_000,
      immutableGenerationId:
        bundledArtifact.record.immutableGenerationId,
    });
    expect(
      persistRunnerManagedDependencyRetention,
    ).toHaveBeenCalledWith({
      pid: 4242,
      sessionId: 'canonical-session-1',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 2_000,
      retention: {
        v: 1,
        sourceGenerationIds: [],
        qualifiedDependencyIds: [],
      },
    });
    expect(tracked).toMatchObject({
      agentRuntimeDaemonServiceAuthorityFilePath:
        fixture.authorityFilePath,
      agentRuntimeDaemonServiceCapabilityHash:
        fixture.published.capabilityDigest,
      runnerAgentImmutableGenerationId:
        bundledArtifact.record.immutableGenerationId,
      runnerAgentInvocationContext: {
        cwd: '/workspace',
        environment: {},
        providerBindingActive: false,
      },
    });
    expect(tracked.agentRuntimeRunnerRestartDisposition).toBeUndefined();
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

  it('does not install tracked authority when the exact generation pin cannot attach', async () => {
    const fixture = await createPublishedAuthority();
    try {
    const tracked: TrackedSession = {
      pid: 4242,
      happySessionId: 'canonical-session-1',
      startedBy: 'happy directly - likely by user from terminal',
      processStartTimeMs: 2_000,
      processCommandHash: 'a'.repeat(64),
    };
    const persistRunnerManagedDependencyRetention =
      vi.fn(async () => true);

    await expect(
      promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.pid, tracked]]),
        canonicalSessionId: 'canonical-session-1',
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: fixture.retainedAgent,
        runner: fixture.runner,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          environment: {},
          providerBindingActive: false,
        },
        persistAuthorityPath: async () => true,
        persistRunnerAgentImmutableGenerationId:
          async () => false,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      }),
    ).resolves.toBe(false);

    expect(
      persistRunnerManagedDependencyRetention,
    ).not.toHaveBeenCalled();
    expect(tracked).not.toHaveProperty(
      'agentRuntimeDaemonServiceCapabilityHash',
    );
    expect(tracked).not.toHaveProperty(
      'runnerAgentImmutableGenerationId',
    );
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });
});
