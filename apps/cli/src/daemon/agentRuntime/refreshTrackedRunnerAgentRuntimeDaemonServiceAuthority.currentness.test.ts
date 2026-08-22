import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  loadRetainedAgentRuntimeLeaf: vi.fn(),
  updateSessionMarkerRunnerManagedProviderAuthority: vi.fn(),
}));

vi.mock('@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf', () => ({
  loadRetainedAgentRuntimeLeaf: boundaries.loadRetainedAgentRuntimeLeaf,
}));

vi.mock('@/daemon/sessionRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/sessionRegistry')>(),
  updateSessionMarkerRunnerManagedProviderAuthority:
    boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
}));

import type { TrackedSession } from '@/daemon/types';
import type {
  updateSessionMarkerRunnerManagedDependencyRetention,
  updateSessionMarkerRunnerManagedProviderAuthority,
} from '@/daemon/sessionRegistry';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

import {
  createAgentRuntimeDaemonServiceAuthorityPath,
} from './sessionBridgeAuthorization';
import {
  refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority,
} from './refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';

function retainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.runner',
    pluginVersion: '1.0.0',
    agentId: 'codex',
    localAgentId: 'fixture',
    immutableGenerationId: 'generation-a',
    locator: {
      module: './agent/runtime/factory',
      export: 'createFixtureAgentRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'agent/runtime/factory.mjs',
    loadMode: 'immutable-js',
  });
}

describe('refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority currentness', () => {
  it('removes the published authority when hard revocation wins during the final immutable-currentness check', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-refresh-final-currentness-',
    ));
    try {
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-final-currentness';
      const processCommandHash = createHash('sha256')
        .update(command)
        .digest('hex');
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      });
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        pid: 4251,
        sessionRunnerPid: 4252,
        happySessionId: 'session-final-currentness',
        processCommandHash,
        processStartTimeMs: 23_345,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        spawnOptions: {
          directory: '/repo',
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          modelSelection: {
            v: 1,
            ref: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      let hardRevocationRevision = 0;
      let hardRevocationInjected = false;

      await expect(
        refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          httpPort: 3210,
          sessionId: 'session-final-currentness',
          tracked,
          resolveCurrentRetainedAgent: async () => retainedAgent(),
          persistRunnerAgentImmutableGenerationId: async () => true,
          persistRunnerManagedDependencyRetention: async () => true,
          attachRunnerRetainedPluginGenerations: async ({ attach }) =>
            await attach(),
          readProcessIdentityByPidFn: async (pid) => ({
            pid,
            command,
            processStartTimeMs: 23_345,
          }),
          readPluginHardRevocationRevision: async () =>
            hardRevocationRevision,
          readPluginImmutableGenerationIntegrityCurrentness: async () => {
            if (
              !hardRevocationInjected
              && tracked.agentRuntimeDaemonServiceCapabilityHash
            ) {
              hardRevocationInjected = true;
              hardRevocationRevision = 1;
            }
            return true;
          },
        }),
      ).rejects.toThrow(/hard-revoked/i);

      expect(hardRevocationInjected).toBe(true);
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
      await expect(access(authorityPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('rejects retained P before attaching or publishing when its hard revocation advances during integrity currentness', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-refresh-retained-p-final-currentness-',
    ));
    try {
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-retained-p-final-currentness';
      const processCommandHash = createHash('sha256')
        .update(command)
        .digest('hex');
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      });
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        pid: 4351,
        sessionRunnerPid: 4352,
        happySessionId: 'session-retained-p-final-currentness',
        processCommandHash,
        processStartTimeMs: 23_445,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            immutableGenerationId: 'provider-generation-p',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceGenerationIds: [],
          qualifiedDependencyIds: [],
        },
        spawnOptions: {
          directory: '/repo',
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          modelSelection: {
            v: 1,
            ref: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      let retainedPRevision = 0;
      let retainedPRevocationInjected = false;
      const persistRunnerManagedDependencyRetention = vi.fn(
        async () => true,
      );

      await expect(
        refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          httpPort: 3210,
          sessionId: 'session-retained-p-final-currentness',
          tracked,
          resolveCurrentRetainedAgent: async () => retainedAgent(),
          persistRunnerAgentImmutableGenerationId: async () => true,
          persistRunnerManagedDependencyRetention,
          attachRunnerRetainedPluginGenerations: async ({ attach }) =>
            await attach(),
          readProcessIdentityByPidFn: async (pid) => ({
            pid,
            command,
            processStartTimeMs: 23_445,
          }),
          readPluginHardRevocationRevision: async (pluginId) =>
            pluginId === 'acme.provider' ? retainedPRevision : 0,
          readPluginImmutableGenerationIntegrityCurrentness: async (
            pluginId,
          ) => {
            if (
              pluginId === 'acme.provider'
              && !retainedPRevocationInjected
            ) {
              await Promise.resolve();
              retainedPRevocationInjected = true;
              retainedPRevision = 1;
            }
            return true;
          },
        }),
      ).rejects.toThrow(/retained Provider authority is hard-revoked/i);

      expect(retainedPRevocationInjected).toBe(true);
      expect(persistRunnerManagedDependencyRetention).not.toHaveBeenCalled();
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
      await expect(access(authorityPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('removes published P when its hard revocation advances while attaching retained generations', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-refresh-retained-p-post-attachment-currentness-',
    ));
    try {
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-retained-p-post-attachment-currentness';
      const processCommandHash = createHash('sha256')
        .update(command)
        .digest('hex');
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      });
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        pid: 4353,
        sessionRunnerPid: 4354,
        happySessionId: 'session-retained-p-post-attachment-currentness',
        processCommandHash,
        processStartTimeMs: 23_446,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        agentRuntimeDaemonServiceAdmittedTurnId: 'turn-retained-p',
        agentRuntimeDaemonServiceAdmittedInputId: 'input-retained-p',
        agentRuntimeDaemonServiceAdmittedUserMessageSeq: 8,
        agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [8],
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            immutableGenerationId: 'provider-generation-p',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceGenerationIds: [],
          qualifiedDependencyIds: [],
        },
        spawnOptions: {
          directory: '/repo',
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          modelSelection: {
            v: 1,
            ref: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      let retainedPRevision = 0;
      let retainedPRevocationInjected = false;
      let persistedRetainedP = false;
      const persistRunnerManagedDependencyRetention = vi.fn(async (
        input: Parameters<
          typeof updateSessionMarkerRunnerManagedDependencyRetention
        >[0],
      ) => {
        persistedRetainedP = input.retention
          .adoptedManagedProviderAuthority?.pluginId === 'acme.provider';
        await Promise.resolve();
        retainedPRevocationInjected = true;
        retainedPRevision = 1;
        return true;
      });
      boundaries.updateSessionMarkerRunnerManagedProviderAuthority
        .mockReset()
        .mockImplementation(async (
          input: Parameters<
            typeof updateSessionMarkerRunnerManagedProviderAuthority
          >[0],
        ) => {
          if (input.authority !== null) return false;
          persistedRetainedP = false;
          return true;
        });

      await expect(
        refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          httpPort: 3210,
          sessionId: 'session-retained-p-post-attachment-currentness',
          tracked,
          resolveCurrentRetainedAgent: async () => retainedAgent(),
          persistRunnerAgentImmutableGenerationId: async () => true,
          persistRunnerManagedDependencyRetention,
          attachRunnerRetainedPluginGenerations: async ({ attach }) =>
            await attach(),
          readProcessIdentityByPidFn: async (pid) => ({
            pid,
            command,
            processStartTimeMs: 23_446,
          }),
          readPluginHardRevocationRevision: async (pluginId) =>
            pluginId === 'acme.provider' ? retainedPRevision : 0,
          readPluginImmutableGenerationIntegrityCurrentness: async () => true,
        }),
      ).rejects.toThrow(/hard-revoked/i);

      expect(retainedPRevocationInjected).toBe(true);
      expect(persistRunnerManagedDependencyRetention).toHaveBeenCalledOnce();
      expect(
        boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
      ).toHaveBeenCalledOnce();
      expect(
        boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
      ).toHaveBeenCalledWith({
        pid: 4354,
        sessionId: 'session-retained-p-post-attachment-currentness',
        processCommandHash,
        processStartTimeMs: 23_446,
        authority: null,
        expectedAuthority: {
          pluginId: 'acme.provider',
          immutableGenerationId: 'provider-generation-p',
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
      });
      expect(persistedRetainedP).toBe(false);
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedInputId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq)
        .toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs)
        .toBeUndefined();
      expect(
        tracked.runnerManagedDependencyRetentionV1
          ?.adoptedManagedProviderAuthority,
      ).toBeUndefined();
      await expect(access(authorityPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('cleans published P when its final hard-revocation read is unavailable after retention persists', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-refresh-retained-p-final-read-unavailable-',
    ));
    try {
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-retained-p-final-read-unavailable';
      const processCommandHash = createHash('sha256')
        .update(command)
        .digest('hex');
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      });
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        pid: 4355,
        sessionRunnerPid: 4356,
        happySessionId: 'session-retained-p-final-read-unavailable',
        processCommandHash,
        processStartTimeMs: 23_447,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        agentRuntimeDaemonServiceAdmittedTurnId: 'turn-retained-p',
        agentRuntimeDaemonServiceAdmittedInputId: 'input-retained-p',
        agentRuntimeDaemonServiceAdmittedUserMessageSeq: 9,
        agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [9],
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            immutableGenerationId: 'provider-generation-p',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceGenerationIds: [],
          qualifiedDependencyIds: [],
        },
        spawnOptions: {
          directory: '/repo',
          backendTarget: {
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          },
          modelSelection: {
            v: 1,
            ref: {
              agentTargetKey: 'backend:codex',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      let retainedPRevisionReads = 0;
      let retentionPersisted = false;
      let persistedRetainedP = false;
      const persistRunnerManagedDependencyRetention = vi.fn(async (
        input: Parameters<
          typeof updateSessionMarkerRunnerManagedDependencyRetention
        >[0],
      ) => {
        persistedRetainedP = input.retention
          .adoptedManagedProviderAuthority?.pluginId === 'acme.provider';
        await Promise.resolve();
        retentionPersisted = true;
        return true;
      });
      boundaries.updateSessionMarkerRunnerManagedProviderAuthority
        .mockReset()
        .mockImplementation(async (
          input: Parameters<
            typeof updateSessionMarkerRunnerManagedProviderAuthority
          >[0],
        ) => {
          if (input.authority !== null) return false;
          persistedRetainedP = false;
          return true;
        });

      const error = await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir,
        publicReleaseRing: 'stable',
        httpPort: 3210,
        sessionId: 'session-retained-p-final-read-unavailable',
        tracked,
        resolveCurrentRetainedAgent: async () => retainedAgent(),
        persistRunnerAgentImmutableGenerationId: async () => true,
        persistRunnerManagedDependencyRetention,
        attachRunnerRetainedPluginGenerations: async ({ attach }) =>
          await attach(),
        readProcessIdentityByPidFn: async (pid) => ({
          pid,
          command,
          processStartTimeMs: 23_447,
        }),
        readPluginHardRevocationRevision: async (pluginId) => {
          if (pluginId !== 'acme.provider') return 0;
          retainedPRevisionReads += 1;
          if (retentionPersisted) {
            throw new Error('final retained P revision read failed');
          }
          return 0;
        },
        readPluginImmutableGenerationIntegrityCurrentness: async () => true,
      }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect(retentionPersisted).toBe(true);
      expect(retainedPRevisionReads).toBe(3);
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedTurnId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedInputId).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq)
        .toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs)
        .toBeUndefined();
      expect(
        tracked.runnerManagedDependencyRetentionV1
          ?.adoptedManagedProviderAuthority,
      ).toBeUndefined();
      expect(
        boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
      ).toHaveBeenCalledOnce();
      expect(persistedRetainedP).toBe(false);
      await expect(access(authorityPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((error as Error).message).toMatch(/hard-revoked/i);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
