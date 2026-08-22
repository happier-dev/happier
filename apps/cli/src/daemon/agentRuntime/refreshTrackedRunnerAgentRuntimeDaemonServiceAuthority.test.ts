import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type { TrackedSession } from '@/daemon/types';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';

import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthority,
} from './sessionBridgeAuthorization';
import {
  refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority,
} from './refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';

const attachRunnerRetainedPluginGenerations = async (
  input: Readonly<{ attach: () => Promise<boolean> }>,
) => await input.attach();

describe('refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority', () => {
  it('publishes a generated bundled direct retained-Agent authority from a configured ACP target\'s exact bootstrap identity', async () => {
    const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-runner-authority-`);
    try {
      const bundledArtifact =
        BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.find(
          (artifact) => artifact.record.pluginId === 'happier.agent.antigravity',
        );
      if (!bundledArtifact) {
        throw new Error('Expected generated bundled Antigravity artifact');
      }
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier codex --existing-session session-a';
      const commandHash = createHash('sha256').update(command).digest('hex');
      const authorityFilePath =
        await createAgentRuntimeDaemonServiceAuthorityPath({
          happyHomeDir,
          publicReleaseRing: 'stable',
        });
      const tracked: TrackedSession = {
        startedBy: 'daemon' as const,
        pid: 4101,
        sessionRunnerPid: 4102,
        happySessionId: 'session-a',
        processCommandHash: commandHash,
        processStartTimeMs: 12_345,
        processCommand: command,
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'happier.provider.fixture',
            immutableGenerationId: 'provider-generation-p',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 7,
          },
          sourceGenerationIds: ['managed-source-stale'],
          qualifiedDependencyIds: ['acme.plugin/tool-stale'],
        },
        agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
        runnerAgentBootstrapIdentity: {
          agentId: 'antigravity',
          backendId: 'antigravity',
        },
        spawnOptions: {
          directory: '/repo',
          backendTarget: {
            kind: 'backend' as const,
            backendId: 'antigravity' as const,
            configuredBackendId: 'antigravity' as const,
            sourceKind: 'configured' as const,
          },
          modelSelection: {
            v: 1 as const,
            ref: {
              agentTargetKey: 'backend:antigravity:configured:antigravity',
              providerConnectionId: null,
              modelId: 'native',
            },
            updatedAt: 1,
          },
        },
      };
      const binding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: 'happier.agent.antigravity',
        pluginVersion: '1.0.0',
        agentId: 'antigravity',
        localAgentId: 'antigravity',
        immutableGenerationId:
          bundledArtifact.record.immutableGenerationId,
        locator: {
          module: './agent/runtime/factory',
          export: 'createAntigravityAgentRuntime',
          runtimeApiVersion: 1,
        },
        normalizedModulePath: 'agent/runtime/factory.mjs',
        loadMode: 'immutable-js',
      });
      const resolveCurrentRetainedAgent = vi.fn((input: Readonly<{
        agentId: string;
      }>) => {
        if (input.agentId !== 'antigravity') {
          throw new Error('Unexpected retained Agent id');
        }
        return binding;
      });
      let persistedRetention: unknown;
      const persistRunnerManagedDependencyRetention =
        vi.fn(async (input) => {
          persistedRetention = input.retention;
          return true;
        });
      let pinnedRunnerAgentImmutableGenerationId: string | undefined;
      const persistRunnerAgentImmutableGenerationId =
        vi.fn(async (input: Readonly<{
          immutableGenerationId: string;
        }>) => {
          if (
            pinnedRunnerAgentImmutableGenerationId !== undefined
            && pinnedRunnerAgentImmutableGenerationId
              !== input.immutableGenerationId
          ) {
            return false;
          }
          pinnedRunnerAgentImmutableGenerationId =
            input.immutableGenerationId;
          return true;
        });
      const exactCurrentRetention = {
        v: 1 as const,
        adoptedManagedProviderAuthority: {
          pluginId: 'happier.provider.fixture',
          immutableGenerationId: 'provider-generation-p',
          manifestAuthority: 'external' as const,
          hardRevocationRevisionAtAdmission: 7,
        },
        sourceGenerationIds: ['managed-source-g'],
        qualifiedDependencyIds: ['acme.plugin/tool-g'],
      };
      const reserveManagedDependencyRetention =
        vi.fn((retainedAgent: typeof binding) => {
          if (
            retainedAgent.immutableGenerationId
              !== bundledArtifact.record.immutableGenerationId
          ) {
            throw new Error('Unexpected managed-dependency generation');
          }
          return {
            retention: exactCurrentRetention,
            release: vi.fn(() => {
              expect(persistedRetention).toEqual(
                exactCurrentRetention,
              );
            }),
          };
        });
      const readPluginImmutableGenerationIntegrityCurrentness = vi.fn(
        async (
          _pluginId: string,
          _immutableGenerationId: string,
          _requiredAgentSessionRunnerFactoryLocalAgentId?: string,
          _retainedManifestAuthority?: 'external' | 'bundled_first_party',
        ) => true,
      );
      const refreshed =
        await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          httpPort: 3210,
          sessionId: 'session-a',
          tracked,
          resolveCurrentRetainedAgent,
          reserveManagedDependencyRetention,
          persistRunnerAgentImmutableGenerationId,
          persistRunnerManagedDependencyRetention,
          attachRunnerRetainedPluginGenerations,
          readPluginHardRevocationRevision: vi.fn(async (pluginId) => (
            pluginId === 'happier.provider.fixture' ? 7 : 0
          )),
          readPluginImmutableGenerationIntegrityCurrentness,
          readProcessIdentityByPidFn: async (pid) => ({
            pid,
            command,
            processStartTimeMs: 12_345,
          }),
        });

      expect(resolveCurrentRetainedAgent).toHaveBeenCalledWith({
        agentId: 'antigravity',
      });
      expect(
        persistRunnerAgentImmutableGenerationId,
      ).toHaveBeenCalledWith({
        pid: 4102,
        sessionId: 'session-a',
        processCommandHash: commandHash,
        processStartTimeMs: 12_345,
        immutableGenerationId:
          bundledArtifact.record.immutableGenerationId,
      });
      expect(tracked).toMatchObject({
        agentRuntimeDaemonServiceCapabilityHash:
          refreshed.capabilityDigest,
        runnerAgentImmutableGenerationId:
          bundledArtifact.record.immutableGenerationId,
        runnerManagedDependencyRetentionV1:
          exactCurrentRetention,
      });
      expect(tracked.runnerAgentBootstrapIdentity).toBeUndefined();
      expect(
        readPluginImmutableGenerationIntegrityCurrentness,
      ).toHaveBeenCalledWith(
        'happier.provider.fixture',
        'provider-generation-p',
        undefined,
        'external',
      );
      await expect(readAgentRuntimeDaemonServiceAuthority({
        happyHomeDir,
        publicReleaseRing: 'stable',
        path: authorityFilePath,
        sessionId: 'session-a',
        runner: refreshed.document.runner,
        retainedAgent: refreshed.document.retainedAgent,
      })).resolves.toEqual(refreshed.document);

    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed bootstrap identity before resolving a retained Agent', async () => {
    const happyHomeDir = await mkdtemp(`${tmpdir()}/happier-runner-authority-`);
    try {
      const command =
        '/immutable/runtime/versions/1.2.3/bin/happier codex --existing-session session-mismatch';
      const commandHash = createHash('sha256').update(command).digest('hex');
      const authorityFilePath =
        await createAgentRuntimeDaemonServiceAuthorityPath({
          happyHomeDir,
          publicReleaseRing: 'stable',
        });
      const resolveCurrentRetainedAgent = vi.fn(async () => {
        throw new Error(
          'Mismatched bootstrap identity must not resolve a retained Agent',
        );
      });

      await expect(
        refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir,
          publicReleaseRing: 'stable',
          httpPort: 3210,
          sessionId: 'session-mismatch',
          tracked: {
            startedBy: 'daemon',
            pid: 4201,
            sessionRunnerPid: 4202,
            happySessionId: 'session-mismatch',
            processCommandHash: commandHash,
            processStartTimeMs: 12_346,
            agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
            runnerAgentBootstrapIdentity: {
              agentId: 'antigravity',
              backendId: '',
            },
            spawnOptions: {
              directory: '/repo',
              backendTarget: {
                kind: 'backend',
                backendId: 'antigravity',
                configuredBackendId: 'antigravity',
                sourceKind: 'configured',
              },
            },
          },
          resolveCurrentRetainedAgent,
          readProcessIdentityByPidFn: async (pid) => ({
            pid,
            command,
            processStartTimeMs: 12_346,
          }),
        }),
      ).rejects.toThrow('Runner Agent daemon-service authority Agent identity is unavailable');

      expect(resolveCurrentRetainedAgent).not.toHaveBeenCalled();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
