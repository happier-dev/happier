import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type {
  clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned,
  updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath,
  updateSessionMarkerRunnerAgentCustody,
} from '@/daemon/sessionRegistry';
import {
  createAgentSessionRunnerFactoryBinding,
  createHostDeclarativeAcpRunnerBinding,
  type AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
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
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

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
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId:
        input?.immutableGenerationId ?? 'generation-1',
      installSource: 'localPath',
    },
    locator: {
      module: './agent/runtime/factory',
      export: 'createRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'agent/runtime/factory.mjs',
    loadMode: 'immutable-js',
  });
}

function retainedHostDeclarativeAgent(input: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
}>) {
  return createHostDeclarativeAcpRunnerBinding({
    kind: 'host_declarative_acp_v1',
    v: 1,
    pluginId: input.pluginId,
    pluginVersion: '1.0.0',
    agentId: 'codex',
    qualifiedAgentId: `${input.pluginId}/agents/codex`,
    localAgentId: 'codex',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: input.immutableGenerationId,
      installSource: 'localPath',
    },
  });
}

function retainedManagedGeneration(
  retained: AgentSessionRunnerBindingV1,
): string {
  if (retained.sourceCustody.kind !== 'managed') {
    throw new Error('Expected managed retained Agent custody');
  }
  return retained.sourceCustody.immutableGenerationId;
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
      pluginOccurrenceIds: {},
      createdAtMs: revision + 1,
      creator: { pid: 42, instanceId: 'promotion-test' },
    }),
  });
}

async function createPublishedAuthority(
  retained: AgentSessionRunnerBindingV1 = retainedAgent(),
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
  it.each([
    ['reserved local/development', 'happier.agent.codex'],
    ['external', 'acme.agent.codex'],
  ] as const)('leaves %s host-declarative bindings to exact generation custody', async (
    _kind,
    pluginId,
  ) => {
    const retained = retainedHostDeclarativeAgent({
      pluginId,
      immutableGenerationId: 'generation-codex',
    });
    const fixture = await createPublishedAuthority(retained);
    try {
      const tracked: TrackedSession = {
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
        happySessionId: fixture.sessionId,
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const readPluginImmutableGenerationIntegrityCurrentness =
        vi.fn(async () => true);

      await expect(promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
        canonicalSessionId: fixture.sessionId,
        foregroundPid: tracked.pid,
        authorityFilePath: fixture.authorityFilePath,
        retainedAgent: retained,
        runner: fixture.runner,
        capabilityDigest: fixture.published.capabilityDigest,
        invocationContext: {
          cwd: '/workspace',
          profileId: 'original-profile',
          secretReferenceOverlay: { v: 1, bindings: { TOKEN: { ref: 'original-secret' } } },
          environment: { TOKEN: 'not-retained' },
          providerBindingActive: false,
        },
        persistAuthorityPath: async () => true,
        persistRunnerAgentCustody: async () => true,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness,
      })).resolves.toBe(true);

      expect(tracked.runnerAgentInvocationContext).toEqual({
        cwd: '/workspace', profileId: 'original-profile', secretReferenceOverlay: { v: 1, bindings: { TOKEN: { ref: 'original-secret' } } },
        environment: {}, providerBindingActive: false,
      });
      expect(readPluginImmutableGenerationIntegrityCurrentness)
        .toHaveBeenCalledWith(
          retained.pluginId,
          retainedManagedGeneration(retained),
          undefined,
          undefined,
        );
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });

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
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy:
          'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const persistAuthorityPath = vi.fn(async () => true);
      const persistRunnerAgentCustody =
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
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      })).resolves.toBe(false);

      expect(persistAuthorityPath).not.toHaveBeenCalled();
      expect(persistRunnerAgentCustody)
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
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
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
      const persistRunnerAgentCustody = vi.fn(async () => true);
      const readPluginImmutableGenerationIntegrityCurrentness = vi.fn(async () => true);

      const promotion = promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
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
      expect(persistRunnerAgentCustody).not.toHaveBeenCalled();
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
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
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
        sourceCustody,
        retention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          sourceCustody !== undefined
          || retention !== undefined
          || persistedAuthorityPath !== authorityFilePath
        ) {
          return false;
        }
        persistedAuthorityPath = undefined;
        return true;
      });
      const persistRunnerAgentCustody = vi.fn(async () => true);

      const promotion = promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
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
        trackingKey: tracked.trackingKey,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
      });
      expect(persistedAuthorityPath).toBeUndefined();
      expect(persistRunnerAgentCustody).not.toHaveBeenCalled();
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
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const retention: RunnerManagedDependencyRetentionV1 = {
        v: 1 as const,
        sourceCustodies: [],
        qualifiedDependencyIds: [],
      };
      const persisted = {
        authorityFilePath: undefined as string | undefined,
        sourceCustody: undefined as Parameters<
          typeof updateSessionMarkerRunnerAgentCustody
        >[0]['sourceCustody'] | undefined,
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
      const persistRunnerAgentCustody = vi.fn(async ({
        sourceCustody,
        retention: nextRetention,
      }: Parameters<
        typeof updateSessionMarkerRunnerAgentCustody
      >[0]) => {
        persisted.sourceCustody = sourceCustody;
        persisted.retention = nextRetention;
        return true;
      });
      const clearPersistedPromotion = vi.fn(async ({
        authorityFilePath,
        sourceCustody,
        retention: expectedRetention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          persisted.authorityFilePath !== authorityFilePath
          || JSON.stringify(persisted.sourceCustody)
            !== JSON.stringify(sourceCustody)
          || JSON.stringify(persisted.retention)
            !== JSON.stringify(expectedRetention)
        ) {
          return false;
        }
        persisted.authorityFilePath = undefined;
        persisted.sourceCustody = undefined;
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
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
        attachRunnerRetainedPluginGenerations,
        clearPersistedPromotion,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      });

      await vi.waitFor(() => {
        expect(persistRunnerAgentCustody).toHaveBeenCalledOnce();
      });
      expect(persisted).toEqual({
        authorityFilePath: fixture.authorityFilePath,
        sourceCustody: fixture.retainedAgent.sourceCustody,
        retention,
      });
      await commitHardRevision(fixture.happyHomeDir, 1);
      releaseCustodyAttachment();

      await expect(promotion).resolves.toBe(false);
      expect(clearPersistedPromotion).toHaveBeenCalledWith({
        pid: tracked.pid,
        trackingKey: tracked.trackingKey,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
        sourceCustody: fixture.retainedAgent.sourceCustody,
        retention,
      });
      expect(persisted).toEqual({
        authorityFilePath: undefined,
        sourceCustody: undefined,
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
        trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
        happySessionId: 'canonical-session-1',
        startedBy: 'happy directly - likely by user from terminal',
        processStartTimeMs: 2_000,
        processCommandHash: 'a'.repeat(64),
      };
      const retention: RunnerManagedDependencyRetentionV1 = {
        v: 1 as const,
        sourceCustodies: [],
        qualifiedDependencyIds: [],
      };
      const persisted = {
        authorityFilePath: undefined as string | undefined,
        sourceCustody: undefined as Parameters<
          typeof updateSessionMarkerRunnerAgentCustody
        >[0]['sourceCustody'] | undefined,
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
      const persistRunnerAgentCustody = vi.fn(async ({
        sourceCustody,
        retention: nextRetention,
      }: Parameters<
        typeof updateSessionMarkerRunnerAgentCustody
      >[0]) => {
        persisted.sourceCustody = sourceCustody;
        persisted.retention = nextRetention;
        return true;
      });
      const clearPersistedPromotion = vi.fn(async ({
        authorityFilePath,
        sourceCustody,
        retention: expectedRetention,
      }: Parameters<
        typeof clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned
      >[0]) => {
        if (
          persisted.authorityFilePath !== authorityFilePath
          || JSON.stringify(persisted.sourceCustody)
            !== JSON.stringify(sourceCustody)
          || JSON.stringify(persisted.retention)
            !== JSON.stringify(expectedRetention)
        ) {
          return false;
        }
        persisted.authorityFilePath = undefined;
        persisted.sourceCustody = undefined;
        persisted.retention = undefined;
        return true;
      });
      let hardRevocationInjected = false;

      await expect(promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
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
        trackingKey: tracked.trackingKey,
        sessionId: fixture.sessionId,
        processCommandHash: fixture.runner.processCommandHash,
        processStartTimeMs: fixture.runner.processStartTimeMs,
        authorityFilePath: fixture.authorityFilePath,
        sourceCustody: fixture.retainedAgent.sourceCustody,
        retention,
      });
      expect(persisted).toEqual({
        authorityFilePath: undefined,
        sourceCustody: undefined,
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

  it('does not install tracked authority when the exact generation pin cannot attach', async () => {
    const fixture = await createPublishedAuthority();
    try {
    const tracked: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(4242), pid: 4242,
      happySessionId: 'canonical-session-1',
      startedBy: 'happy directly - likely by user from terminal',
      processStartTimeMs: 2_000,
      processCommandHash: 'a'.repeat(64),
    };
    const persistRunnerAgentCustody = vi.fn(async () => false);

    await expect(
      promoteForegroundDaemonServiceAuthority({
        happyHomeDir: fixture.happyHomeDir,
        publicReleaseRing: 'stable',
        trackedSessions: new Map([[tracked.trackingKey, tracked]]),
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
        persistRunnerAgentCustody,
        attachRunnerRetainedPluginGenerations,
        readPluginImmutableGenerationIntegrityCurrentness:
          async () => true,
      }),
    ).resolves.toBe(false);

    expect(
      persistRunnerAgentCustody,
    ).toHaveBeenCalledOnce();
    expect(tracked).not.toHaveProperty(
      'agentRuntimeDaemonServiceCapabilityHash',
    );
    expect(tracked).not.toHaveProperty(
      'runnerAgentSourceCustodyV1',
    );
    } finally {
      await rm(fixture.happyHomeDir, { recursive: true, force: true });
    }
  });
});
