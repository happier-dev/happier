import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  updateSessionMarkerRunnerManagedProviderAuthority: vi.fn(),
}));

vi.mock('@/daemon/sessionRegistry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/sessionRegistry')>(),
  updateSessionMarkerRunnerManagedProviderAuthority:
    boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
}));

import type { TrackedSession } from '@/daemon/types';
import type {
  updateSessionMarkerRunnerAgentCustody,
  updateSessionMarkerRunnerManagedProviderAuthority,
} from '@/daemon/sessionRegistry';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
} from './sessionBridgeAuthorization';
import {
  refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority,
} from './refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

function retainedAgent() {
  return createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'acme.runner',
    pluginVersion: '1.0.0',
    agentId: 'codex',
    localAgentId: 'fixture',
    sourceCustody: {
      kind: 'managed',
      immutableGenerationId: 'generation-a',
      installSource: 'localPath',
    },
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
  it('uses the captured runner generation behind a live wrapper and permits same-generation command changes', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-refresh-reattached-'));
    try {
      const launchCommand =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --launch-wrapper';
      const runningCommand =
        '/immutable/runtime/versions/1.2.3/bin/happier fixture --existing-session session-reattached';
      const launchHash = createHash('sha256').update(launchCommand).digest('hex');
      const runningHash = createHash('sha256').update(runningCommand).digest('hex');
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
        happyHomeDir,
        publicReleaseRing: 'stable',
      });
      const retained = retainedAgent();
      await publishAgentRuntimeDaemonServiceAuthority({
        happyHomeDir,
        publicReleaseRing: 'stable',
        path: authorityPath,
        sessionId: 'session-reattached',
        runner: {
          pid: 4262,
          processStartTimeMs: 23_346,
          processCommandHash: launchHash,
          snapshotIdentity: 'version:1.2.3',
        },
        retainedAgent: retained,
        httpPort: 3210,
        readPluginHardRevocationRevision: async () => 0,
      });
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        trackingKey: legacyPidSessionTrackingKey(4261), pid: 4261,
        sessionRunnerPid: 4262,
        happySessionId: 'session-reattached',
        processStartTimeMs: 12_345,
        processCommandHash: launchHash,
        runnerProcessIdentity: {
          pid: 4262,
          processStartTimeMs: 23_346,
          processCommandHash: launchHash,
        },
        reattachedFromDiskMarker: true,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      };
      const refreshed = await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir,
        publicReleaseRing: 'stable',
        httpPort: 3210,
        sessionId: 'session-reattached',
        tracked,
        resolveCurrentRetainedAgent: async () => {
          throw new Error('Reattached runner must retain its pinned Agent');
        },
        persistRunnerAgentCustody: async () => true,
        attachRunnerRetainedPluginGenerations: async ({ attach }) => await attach(),
        readProcessIdentityByPidFn: async (pid) => ({
          pid,
          processStartTimeMs: 23_346,
          command: runningCommand,
        }),
        readPluginHardRevocationRevision: async () => 0,
        readPluginImmutableGenerationIntegrityCurrentness: async () => true,
      });

      expect(refreshed.document.runner).toMatchObject({
        pid: 4262,
        processStartTimeMs: 23_346,
        processCommandHash: runningHash,
      });
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBe(refreshed.capabilityDigest);
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

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
        trackingKey: legacyPidSessionTrackingKey(4251), pid: 4251,
        sessionRunnerPid: 4252,
        runnerProcessIdentity: { pid: 4252, processStartTimeMs: 23_345, processCommandHash },
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
              agentTargetKey: 'agent:happier.agent.codex/codex',
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
          persistRunnerAgentCustody: async () => true,
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
        trackingKey: legacyPidSessionTrackingKey(4351), pid: 4351,
        sessionRunnerPid: 4352,
        runnerProcessIdentity: { pid: 4352, processStartTimeMs: 23_445, processCommandHash },
        happySessionId: 'session-retained-p-final-currentness',
        processCommandHash,
        processStartTimeMs: 23_445,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation-p',
            installSource: 'npm',
          },
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceCustodies: [],
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
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      let retainedPRevision = 0;
      let retainedPRevocationInjected = false;
      const persistRunnerAgentCustody = vi.fn(
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
          persistRunnerAgentCustody,
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
      expect(persistRunnerAgentCustody).not.toHaveBeenCalled();
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
        trackingKey: legacyPidSessionTrackingKey(4353), pid: 4353,
        sessionRunnerPid: 4354,
        runnerProcessIdentity: { pid: 4354, processStartTimeMs: 23_446, processCommandHash },
        happySessionId: 'session-retained-p-post-attachment-currentness',
        processCommandHash,
        processStartTimeMs: 23_446,
        processCommand: command,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        agentRuntimeDaemonServiceAdmittedTurnId: 'turn-retained-p',
        agentRuntimeDaemonServiceAdmittedInputId: 'input-retained-p',
        agentRuntimeDaemonServiceAdmittedUserMessageSeq: 8,
        agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [8],
        agentRuntimeDaemonServiceNativeRealtimeAdmission: {
          admission: { admissionId: 'native-input', occurrenceId: 'native-occurrence', attemptId: 'native-attempt' },
          runner: { pid: 4354, processStartTimeMs: 23_446, processCommandHash, snapshotIdentity: 'version:1.2.3' },
          sourceCustody: retainedAgent().sourceCustody,
        },
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation-p',
            installSource: 'npm',
          },
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceCustodies: [],
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
              agentTargetKey: 'agent:happier.agent.codex/codex',
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
      const persistRunnerAgentCustody = vi.fn(async (
        input: Parameters<
          typeof updateSessionMarkerRunnerAgentCustody
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
          persistRunnerAgentCustody,
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
      expect(persistRunnerAgentCustody).toHaveBeenCalledOnce();
      expect(
        boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
      ).toHaveBeenCalledOnce();
      expect(
        boundaries.updateSessionMarkerRunnerManagedProviderAuthority,
      ).toHaveBeenCalledWith({
        pid: 4354,
        trackingKey: tracked.trackingKey,
        sessionId: 'session-retained-p-post-attachment-currentness',
        processCommandHash,
        processStartTimeMs: 23_446,
        authority: null,
        expectedAuthority: {
          pluginId: 'acme.provider',
          sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation-p',
            installSource: 'npm',
          },
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
      });
      expect(persistedRetainedP).toBe(false);
      expect(tracked.agentRuntimeDaemonServiceCapabilityHash).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceNativeRealtimeAdmission).toBeUndefined();
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
        trackingKey: legacyPidSessionTrackingKey(4355), pid: 4355,
        sessionRunnerPid: 4356,
        runnerProcessIdentity: { pid: 4356, processStartTimeMs: 23_447, processCommandHash },
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
            sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'provider-generation-p',
            installSource: 'npm',
          },
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceCustodies: [],
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
              agentTargetKey: 'agent:happier.agent.codex/codex',
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
      const persistRunnerAgentCustody = vi.fn(async (
        input: Parameters<
          typeof updateSessionMarkerRunnerAgentCustody
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
        persistRunnerAgentCustody,
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
