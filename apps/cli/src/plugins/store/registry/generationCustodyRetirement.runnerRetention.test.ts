import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createAgentRuntimeDaemonServiceAuthorityPath,
  publishAgentRuntimeDaemonServiceAuthority,
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  verifySessionMarkerProcessLiveness as verifyMarkerProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
  attachExactRunnerRetainedPluginGenerations,
  readExactLiveRunnerRetainedPluginGenerationIds,
  reconcilePluginGenerationCustodyRetirement,
} from './generationCustodyRetirement';
import {
  cleanupUnreferencedPluginGenerations,
  persistInstallationStateRevision,
  type PluginInstallationStateRevision,
} from './generationStore';
import type { PluginRegistryCommitRecord } from './commitRecord';

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return Object.freeze({ promise, resolve });
}

describe('live Runner Agent generation retention', () => {
  it('retains a current-host generation while retiring an inapplicable generated generation', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-current-bundled-retention-'),
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const currentHostGenerationId = 'generation-current-host-bundled';
    const inapplicableGenerationId = 'generation-inapplicable-bundled';
    const currentHostGenerationRoot = join(
      paths.generationsDir,
      currentHostGenerationId,
    );
    const inapplicableGenerationRoot = join(
      paths.generationsDir,
      inapplicableGenerationId,
    );
    const runtimeBytes = 'export default "current-bundled";';
    const createGenerationRecord = (
      pluginId: string,
      immutableGenerationId: string,
    ) => ({
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId,
      immutableGenerationId,
      createdAtMs: 1,
      files: [{
        relativePath: 'runtime.mjs',
        byteLength: Buffer.byteLength(runtimeBytes),
      }],
      manifestRelativePath: 'runtime.mjs',
    });
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-current-bundled-retention',
      createdAtMs: 1,
      plugins: {},
      rollbackRetention: [],
    };

    try {
      for (const [generationRoot, record] of [
        [
          currentHostGenerationRoot,
          createGenerationRecord(
            'happier.agent.current-host',
            currentHostGenerationId,
          ),
        ],
        [
          inapplicableGenerationRoot,
          createGenerationRecord(
            'happier.agent.inapplicable',
            inapplicableGenerationId,
          ),
        ],
      ] as const) {
        await mkdir(generationRoot, { recursive: true });
        await writeFile(
          join(generationRoot, 'runtime.mjs'),
          runtimeBytes,
          'utf8',
        );
        await writeFile(
          join(generationRoot, 'plugin-generation.v1.json'),
          JSON.stringify(record),
          'utf8',
        );
      }
      const stateReference = await persistInstallationStateRevision({
        paths,
        state,
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'current-bundled-retention',
        baseRevision: 0,
        installationState: stateReference,
        pluginGenerations: {},
        createdAtMs: 1,
        creator: { pid: 1, instanceId: 'daemon-a' },
      };
      const retireGeneration = vi.fn(async () => undefined);

      await expect(reconcilePluginGenerationCustodyRetirement({
        paths,
        commit,
        retainedCurrentHostGenerationIds: [currentHostGenerationId],
        isCommitCurrent: async () => true,
        readRunnerRetainedGenerationIds: async () => new Set(),
        readCredentials: async () => ({
          token: 'account-token',
          encryption: null,
        }),
        retireGeneration,
      })).resolves.toMatchObject({
        status: 'reconciled',
        removed: [inapplicableGenerationId],
        failures: [],
      });
      expect(retireGeneration).toHaveBeenCalledTimes(1);
      expect(retireGeneration).toHaveBeenCalledWith({
        token: 'account-token',
        pluginId: 'happier.agent.inapplicable',
        immutableGenerationId: inapplicableGenerationId,
      });
      await expect(
        access(join(currentHostGenerationRoot, 'runtime.mjs')),
      ).resolves.toBeUndefined();
      await expect(
        access(join(inapplicableGenerationRoot, 'runtime.mjs')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('retains only exact live Agent and managed-source pins without an effect-authority document', async () => {
      const marker: DaemonSessionMarker = {
        pid: 4_201,
        happySessionId: 'session-live-runner',
        happyHomeDir: '/private/happier',
        createdAt: 1,
        updatedAt: 1,
        processCommandHash: 'a'.repeat(64),
        processStartTimeMs: 12_345,
        runnerAgentImmutableGenerationId:
          'generation-live-runner',
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.provider',
            immutableGenerationId:
              'generation-provider-live-p',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
          sourceGenerationIds: [
            'generation-managed-live-g1',
          ],
          qualifiedDependencyIds: [
            'acme.runner-retention/tool-g1',
          ],
        },
      };
      const secondRunner = {
        pid: 4_202,
        processStartTimeMs: 12_346,
        processCommandHash: 'b'.repeat(64),
      };
      const secondMarker: DaemonSessionMarker = {
        pid: secondRunner.pid,
        happySessionId: 'session-live-runner-g2',
        happyHomeDir: '/private/happier',
        createdAt: 2,
        updatedAt: 2,
        processCommandHash:
          secondRunner.processCommandHash,
        processStartTimeMs:
          secondRunner.processStartTimeMs,
        runnerAgentImmutableGenerationId:
          'generation-live-runner-g2',
        runnerManagedDependencyRetentionV1: {
          v: 1,
          sourceGenerationIds: [
            'generation-managed-live-g2',
          ],
          qualifiedDependencyIds: [
            'acme.runner-retention/tool-g2',
          ],
        },
      };

      await expect(
        readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [
            marker,
            secondMarker,
          ],
          verifySessionMarkerProcessLiveness: async (
            candidate,
          ) => ({
            status: 'verified_running',
            pid: candidate.pid,
            processStartTimeMs:
              candidate.processStartTimeMs!,
          }),
        }),
      ).resolves.toEqual(new Set([
        'generation-live-runner',
        'generation-live-runner-g2',
        'generation-managed-live-g1',
        'generation-managed-live-g2',
        'generation-provider-live-p',
      ]));

      await expect(
        readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
          happyHomeDir: '/private/happier',
          publicReleaseRing: 'stable',
          path: '/private/happier/missing-authority.json',
          sessionId: marker.happySessionId,
          runner: {
            pid: marker.pid,
            processStartTimeMs: marker.processStartTimeMs!,
            processCommandHash: marker.processCommandHash!,
          },
        }),
      ).resolves.toBeNull();
  });

  it('retains exact Agent, Provider, and dependency generations when cleanup cannot prove the last runner stopped', async () => {
    const marker: DaemonSessionMarker = {
      pid: 4_211,
      happySessionId: 'session-unknown-runner',
      happyHomeDir: '/private/happier',
      createdAt: 1,
      updatedAt: 1,
      processCommandHash: 'c'.repeat(64),
      processStartTimeMs: 21_001,
      runnerAgentImmutableGenerationId: 'generation-agent-g',
      runnerManagedDependencyRetentionV1: {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId: 'acme.provider',
          immutableGenerationId: 'generation-provider-p',
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
        sourceGenerationIds: ['generation-dependency-g'],
        qualifiedDependencyIds: ['acme.runner-retention/tool'],
      },
    };
    const sameOwnerMarker: DaemonSessionMarker = {
      ...marker,
      pid: 4_212,
      happySessionId: 'session-unknown-runner-last-owner',
      processStartTimeMs: 21_002,
    };
    const markers = [marker, sameOwnerMarker] as const;
    const retainedIds = new Set([
      'generation-agent-g',
      'generation-provider-p',
      'generation-dependency-g',
    ]);

    await expect(
      readExactLiveRunnerRetainedPluginGenerationIds({
        listSessionMarkers: async () => [marker],
        verifySessionMarkerProcessLiveness: async (candidate) =>
          await verifyMarkerProcessLiveness(candidate, {
            readRunState: async () => {
              throw Object.assign(
                new Error('operation not permitted'),
                { code: 'EPERM' },
              );
            },
          }),
      }),
    ).resolves.toEqual(retainedIds);

    await expect(
      readExactLiveRunnerRetainedPluginGenerationIds({
        listSessionMarkers: async () => [marker],
        verifySessionMarkerProcessLiveness: async () => ({
          status: 'verified_running',
          pid: marker.pid + 1,
          processStartTimeMs: marker.processStartTimeMs! + 1,
        }),
      }),
    ).resolves.toEqual(retainedIds);

    await expect(
      readExactLiveRunnerRetainedPluginGenerationIds({
        listSessionMarkers: async () => [...markers],
        verifySessionMarkerProcessLiveness: async (candidate) =>
          candidate.pid === marker.pid
            ? {
                status: 'verified_stopped',
                pid: candidate.pid,
                processStartTimeMs: candidate.processStartTimeMs,
              }
            : {
                status: 'unknown',
                pid: candidate.pid,
                processStartTimeMs: candidate.processStartTimeMs,
              },
      }),
    ).resolves.toEqual(retainedIds);

    await expect(
      readExactLiveRunnerRetainedPluginGenerationIds({
        listSessionMarkers: async () => [...markers],
        verifySessionMarkerProcessLiveness: async (candidate) => ({
          status: 'verified_stopped',
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs,
        }),
      }),
    ).resolves.toEqual(new Set());
  });

  it('releases exact pins only after an identity-consistent verified stop', async () => {
      const marker: DaemonSessionMarker = {
        pid: 4_201,
        happySessionId: 'session-live-runner',
        happyHomeDir: '/private/happier',
        createdAt: 1,
        updatedAt: 1,
        processCommandHash: 'a'.repeat(64),
        processStartTimeMs: 12_345,
        runnerAgentImmutableGenerationId:
          'generation-live-runner',
        runnerManagedDependencyRetentionV1: {
          v: 1,
          sourceGenerationIds: ['generation-managed-live'],
          qualifiedDependencyIds: ['acme.runner-retention/tool'],
        },
      };
      await expect(
        readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [marker],
          verifySessionMarkerProcessLiveness: async () => ({
            status: 'verified_stopped',
            pid: marker.pid,
            processStartTimeMs: marker.processStartTimeMs,
          }),
        }),
      ).resolves.toEqual(new Set());

      await expect(
        readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [marker],
          verifySessionMarkerProcessLiveness: async () => ({
            status: 'verified_stopped',
            pid: marker.pid + 1,
            processStartTimeMs: marker.processStartTimeMs,
          }),
        }),
      ).resolves.toEqual(new Set([
        'generation-live-runner',
        'generation-managed-live',
      ]));

      await expect(
        readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [marker],
          verifySessionMarkerProcessLiveness: async () => ({
            status: 'verified_stopped',
            pid: marker.pid,
            processStartTimeMs:
              marker.processStartTimeMs! + 1,
          }),
        }),
      ).resolves.toEqual(new Set([
        'generation-live-runner',
        'generation-managed-live',
      ]));
  });

  it('keeps exact generation bytes when runner custody attaches before the retirement fence', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-retirement-race-'),
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const attachedGenerationId = 'generation-runner-attachment-g';
    const attachedBytes = 'export default "runner-g";';
    const attachedRoot = join(
      paths.generationsDir,
      attachedGenerationId,
    );
    const attachedRecord = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.runner-attachment',
      immutableGenerationId: attachedGenerationId,
      createdAtMs: 1,
      files: [{
        relativePath: 'runtime.mjs',
        byteLength: Buffer.byteLength(attachedBytes),
      }],
      manifestRelativePath: 'runtime.mjs',
    };
    const currentGenerationId = 'generation-runner-current-h';
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-runner-retirement-race',
      createdAtMs: 1,
      plugins: {
        'acme.runner-attachment': {
          enabled: true,
          trust: {
            pluginId: 'acme.runner-attachment',
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-runner-attachment',
            },
            state: 'trusted',
            approvedAtMs: 1,
          },
          source: {
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-runner-attachment',
            },
          },
          updatePolicy: 'manual',
          optionalAccess: [],
        },
      },
      rollbackRetention: [],
    };
    const retirementReachedFence = createDeferred();
    const allowRetirementFence = createDeferred();
    const liveRunnerGenerationIds = new Set<string>();

    try {
      await mkdir(attachedRoot, { recursive: true });
      await writeFile(
        join(attachedRoot, 'runtime.mjs'),
        attachedBytes,
        'utf8',
      );
      await writeFile(
        join(attachedRoot, 'plugin-generation.v1.json'),
        JSON.stringify(attachedRecord),
        'utf8',
      );
      const stateReference = await persistInstallationStateRevision({
        paths,
        state,
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'runner-retirement-race',
        baseRevision: 0,
        installationState: stateReference,
        pluginGenerations: {
          'acme.runner-attachment': {
            immutableGenerationId: currentGenerationId,
          },
        },
        createdAtMs: 1,
        creator: { pid: 1, instanceId: 'daemon-a' },
      };

      const retirement = reconcilePluginGenerationCustodyRetirement({
        paths,
        commit,
        isCommitCurrent: async () => true,
        readRunnerRetainedGenerationIds: async () =>
          new Set(liveRunnerGenerationIds),
        withCommitFence: async <T>(operation: () => Promise<T>) => {
          retirementReachedFence.resolve();
          await allowRetirementFence.promise;
          return await operation();
        },
        readCredentials: async () => ({
          token: 'account-token',
          encryption: null,
        }),
        retireGeneration: async () => undefined,
      });

      await retirementReachedFence.promise;
      liveRunnerGenerationIds.add(attachedGenerationId);
      const attachmentSucceeded = true;
      allowRetirementFence.resolve();

      await expect(retirement).resolves.toMatchObject({
        status: 'reconciled',
        removed: [],
        failures: [],
      });
      expect(attachmentSucceeded).toBe(true);
      await expect(
        access(join(attachedRoot, 'runtime.mjs')),
      ).resolves.toBeUndefined();
    } finally {
      allowRetirementFence.resolve();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('keeps a pre-marker exact G through successor cleanup and retires it only after its authority runner stops', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-pre-marker-successor-cleanup-'),
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const retainedGenerationId = 'generation-pre-marker-g';
    const currentGenerationId = 'generation-successor-h';
    const runtimeBytes = 'export default "pre-marker-g";';
    const retainedRoot = join(paths.generationsDir, retainedGenerationId);
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-pre-marker-successor-cleanup',
      createdAtMs: 1,
      plugins: {
        'acme.pre-marker': {
          enabled: true,
          trust: {
            pluginId: 'acme.pre-marker',
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-pre-marker',
            },
            state: 'trusted',
            approvedAtMs: 1,
          },
          source: {
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-pre-marker',
            },
          },
          updatePolicy: 'manual',
          optionalAccess: [],
        },
      },
      rollbackRetention: [],
    };
    const runner = {
      pid: 4_301,
      processStartTimeMs: 43_001,
      processCommandHash: 'd'.repeat(64),
      snapshotIdentity: 'snapshot:pre-marker',
    };
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
      v: 1,
      pluginId: 'acme.pre-marker',
      pluginVersion: '1.0.0',
      agentId: 'pre-marker',
      localAgentId: 'pre-marker',
      immutableGenerationId: retainedGenerationId,
      locator: {
        module: './agent/factory.mjs',
        export: 'createRuntime',
        runtimeApiVersion: 1,
      },
      normalizedModulePath: 'agent/factory.mjs',
      loadMode: 'immutable-js',
    });

    try {
      await mkdir(retainedRoot, { recursive: true });
      await writeFile(join(retainedRoot, 'runtime.mjs'), runtimeBytes, 'utf8');
      await writeFile(join(retainedRoot, 'plugin-generation.v1.json'), JSON.stringify({
        t: 'happier_plugin_generation_v1',
        schemaVersion: 1,
        pluginId: 'acme.pre-marker',
        immutableGenerationId: retainedGenerationId,
        createdAtMs: 1,
        files: [{
          relativePath: 'runtime.mjs',
          byteLength: Buffer.byteLength(runtimeBytes),
        }],
        manifestRelativePath: 'runtime.mjs',
      }), 'utf8');
      const stateReference = await persistInstallationStateRevision({
        paths,
        state,
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'pre-marker-successor-cleanup',
        baseRevision: 0,
        installationState: stateReference,
        pluginGenerations: {
          'acme.pre-marker': {
            immutableGenerationId: currentGenerationId,
          },
        },
        createdAtMs: 1,
        creator: { pid: 1, instanceId: 'pre-marker-test' },
      };
      const authorityFilePath =
        await createAgentRuntimeDaemonServiceAuthorityPath({
          happyHomeDir,
          publicReleaseRing: 'stable',
        });
      await expect(attachExactRunnerRetainedPluginGenerations({
        paths,
        immutableGenerationIds: [retainedGenerationId],
        attach: async () => {
          await publishAgentRuntimeDaemonServiceAuthority({
            happyHomeDir,
            publicReleaseRing: 'stable',
            path: authorityFilePath,
            sessionId: 'session-pre-marker-cleanup',
            runner,
            retainedAgent,
            httpPort: 31_001,
            capability: 'A'.repeat(43),
          });
          return true;
        },
      })).resolves.toBe(true);
      const readRetainedGenerationIds = async (status: 'verified_running' | 'verified_stopped') =>
        await readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [],
          readDaemonServiceAuthorityRetainedGenerationIds: async () =>
            await readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds({
              happyHomeDir,
              publicReleaseRing: 'stable',
              verifyRunnerLiveness: async (candidate) => ({
                status,
                pid: candidate.pid,
                processStartTimeMs: candidate.processStartTimeMs,
              }),
            }),
        });

      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        readRunnerRetainedGenerationIds: async () =>
          await readRetainedGenerationIds('verified_running'),
      })).resolves.toMatchObject({
        retained: [retainedGenerationId],
        removed: [],
      });
      await expect(access(join(retainedRoot, 'runtime.mjs')))
        .resolves.toBeUndefined();

      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        readRunnerRetainedGenerationIds: async () =>
          await readRetainedGenerationIds('verified_stopped'),
      })).resolves.toMatchObject({
        retained: [],
        removed: [retainedGenerationId],
      });
      await expect(access(join(retainedRoot, 'runtime.mjs')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('keeps adopted Provider bytes until the exact live marker releases its pin', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-provider-retention-'),
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const providerGenerationId = 'generation-provider-live-p';
    const providerBytes = 'export default "provider-p";';
    const providerRoot = join(
      paths.generationsDir,
      providerGenerationId,
    );
    const providerRecord = {
      t: 'happier_plugin_generation_v1' as const,
      schemaVersion: 1 as const,
      pluginId: 'acme.provider',
      immutableGenerationId: providerGenerationId,
      createdAtMs: 1,
      files: [{
        relativePath: 'runtime.mjs',
        byteLength: Buffer.byteLength(providerBytes),
      }],
      manifestRelativePath: 'runtime.mjs',
    };
    const currentGenerationId = 'generation-current-q';
    const state: PluginInstallationStateRevision = {
      t: 'happier_plugin_installations_v1',
      schemaVersion: 1,
      revisionId: 'state-provider-retention',
      createdAtMs: 1,
      plugins: {
        'acme.provider': {
          enabled: true,
          trust: {
            pluginId: 'acme.provider',
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-provider',
            },
            state: 'trusted',
            approvedAtMs: 1,
          },
          source: {
            distribution: {
              kind: 'localPath',
              canonicalPath: '/tmp/acme-provider',
            },
          },
          updatePolicy: 'manual',
          optionalAccess: [],
        },
      },
      rollbackRetention: [],
    };
    const marker: DaemonSessionMarker = {
      pid: 4_203,
      happySessionId: 'session-provider-live-p',
      happyHomeDir,
      createdAt: 1,
      updatedAt: 1,
      processCommandHash: 'c'.repeat(64),
      processStartTimeMs: 12_347,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId: 'acme.provider',
          immutableGenerationId: providerGenerationId,
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
        sourceGenerationIds: [],
        qualifiedDependencyIds: [],
      },
    };

    try {
      await mkdir(providerRoot, { recursive: true });
      await writeFile(
        join(providerRoot, 'runtime.mjs'),
        providerBytes,
        'utf8',
      );
      await writeFile(
        join(providerRoot, 'plugin-generation.v1.json'),
        JSON.stringify(providerRecord),
        'utf8',
      );
      const stateReference = await persistInstallationStateRevision({
        paths,
        state,
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'provider-retention',
        baseRevision: 0,
        installationState: stateReference,
        pluginGenerations: {
          'acme.provider': {
            immutableGenerationId: currentGenerationId,
          },
        },
        createdAtMs: 1,
        creator: { pid: 1, instanceId: 'daemon-a' },
      };
      const readRetained = async (candidate: DaemonSessionMarker) =>
        await readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [candidate],
          verifySessionMarkerProcessLiveness: async () => ({
            status: 'verified_running',
            pid: candidate.pid,
            processStartTimeMs: candidate.processStartTimeMs!,
          }),
        });

      const retained = await cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        runnerRetainedGenerationIds: await readRetained(marker),
      });
      expect(retained).toMatchObject({
        retained: [providerGenerationId],
        removed: [],
      });
      await expect(
        access(join(providerRoot, 'runtime.mjs')),
      ).resolves.toBeUndefined();

      const releasedMarker: DaemonSessionMarker = {
        ...marker,
        runnerManagedDependencyRetentionV1: {
          v: 1,
          sourceGenerationIds: [],
          qualifiedDependencyIds: [],
        },
      };
      const released = await cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        runnerRetainedGenerationIds:
          await readRetained(releasedMarker),
      });
      expect(released).toMatchObject({
        retained: [],
        removed: [providerGenerationId],
      });
      await expect(access(providerRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
