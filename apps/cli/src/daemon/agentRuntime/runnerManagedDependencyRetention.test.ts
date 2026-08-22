import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  DaemonSessionMarker,
} from '@/daemon/sessionRegistry';
import {
  verifySessionMarkerProcessLiveness as verifyMarkerProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import {
  readExactLiveRunnerRetainedPluginGenerationIds,
} from '@/plugins/store/registry/generationCustodyRetirement';
import type {
  PluginRegistryCommitRecord,
} from '@/plugins/store/registry/commitRecord';
import {
  cleanupUnreferencedPluginGenerations,
  persistInstallationStateRevision,
  type PluginInstallationStateRevision,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import {
  readExactLiveRunnerManagedDependencyRetention,
} from './runnerManagedDependencyRetention';

type SessionMarkerProcessIdentity = Parameters<
  typeof verifyMarkerProcessLiveness
>[0];

function marker(
  overrides: Partial<DaemonSessionMarker> = {},
): DaemonSessionMarker {
  return {
    pid: 4_201,
    happySessionId: 'session-runner-retention',
    happyHomeDir: '/private/happier',
    createdAt: 1,
    updatedAt: 1,
    processCommandHash: 'a'.repeat(64),
    processStartTimeMs: 12_345,
    runnerManagedDependencyRetentionV1: {
      v: 1,
      sourceGenerationIds: ['registry:g'],
      qualifiedDependencyIds: ['acme.plugin/tool'],
    },
    ...overrides,
  };
}

describe('live Runner Agent managed-dependency retention', () => {
  it('retains exact dependency pins when cleanup cannot prove the last runner stopped', async () => {
    const firstOwner = marker();
    const lastOwner = marker({
      pid: 4_202,
      happySessionId: 'session-runner-retention-last-owner',
      processStartTimeMs: 12_346,
    });
    const expected = {
      v: 1 as const,
      sourceGenerationIds: ['registry:g'],
      qualifiedDependencyIds: ['acme.plugin/tool'],
    };

    await expect(
      readExactLiveRunnerManagedDependencyRetention({
        listSessionMarkers: async () => [firstOwner],
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
    ).resolves.toEqual(expected);

    await expect(
      readExactLiveRunnerManagedDependencyRetention({
        listSessionMarkers: async () => [firstOwner],
        verifySessionMarkerProcessLiveness: async () => ({
          status: 'verified_running',
          pid: firstOwner.pid + 1,
          processStartTimeMs: firstOwner.processStartTimeMs! + 1,
        }),
      }),
    ).resolves.toEqual(expected);

    await expect(
      readExactLiveRunnerManagedDependencyRetention({
        listSessionMarkers: async () => [firstOwner, lastOwner],
        verifySessionMarkerProcessLiveness: async (candidate) =>
          candidate.pid === firstOwner.pid
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
    ).resolves.toEqual(expected);

    await expect(
      readExactLiveRunnerManagedDependencyRetention({
        listSessionMarkers: async () => [firstOwner, lastOwner],
        verifySessionMarkerProcessLiveness: async (candidate) => ({
          status: 'verified_stopped',
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs,
        }),
      }),
    ).resolves.toEqual({
      v: 1,
      sourceGenerationIds: [],
      qualifiedDependencyIds: [],
    });
  });

  it('keeps pins after effect-authority revocation and releases them only when the exact runner exits', async () => {
    const live = marker();
    const stopped = marker({
      pid: 4_202,
      processStartTimeMs: 22_345,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        sourceGenerationIds: ['registry:stopped'],
        qualifiedDependencyIds: ['acme.plugin/stopped'],
      },
    });
    const reused = marker({
      pid: 4_203,
      processStartTimeMs: 32_345,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        sourceGenerationIds: ['registry:reused'],
        qualifiedDependencyIds: ['acme.plugin/reused'],
      },
    });

    await expect(
      readExactLiveRunnerManagedDependencyRetention({
        listSessionMarkers: async () => [
          live,
          stopped,
          reused,
        ],
        verifySessionMarkerProcessLiveness: async (
          candidate,
        ) => candidate.pid === live.pid
          ? {
              status: 'verified_running',
              pid: candidate.pid,
              processStartTimeMs:
                candidate.processStartTimeMs!,
            }
          : candidate.pid === stopped.pid
            ? {
                status: 'verified_stopped',
                pid: candidate.pid,
                processStartTimeMs:
                  candidate.processStartTimeMs!,
              }
            : {
                status: 'verified_running',
                pid: candidate.pid,
                processStartTimeMs:
                  candidate.processStartTimeMs! + 1,
              },
      }),
    ).resolves.toEqual({
      v: 1,
      sourceGenerationIds: [
        'registry:g',
        'registry:reused',
      ],
      qualifiedDependencyIds: [
        'acme.plugin/reused',
        'acme.plugin/tool',
      ],
    });
  });

  it('unions global dependency facts while exact P1 and P2 cleanup waits for each live Session owner', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-runner-multi-provider-retention-'),
    );
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const pluginId = 'acme.provider';
    const providerP1 = 'generation-provider-p1';
    const providerP2 = 'generation-provider-p2';
    const currentQ = 'generation-provider-q';
    const livePids = new Set([4_211, 4_212]);
    const markerP1 = marker({
      pid: 4_211,
      happySessionId: 'session-provider-p1',
      processStartTimeMs: 21_001,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId,
          immutableGenerationId: providerP1,
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
        sourceGenerationIds: [currentQ],
        qualifiedDependencyIds: ['acme.provider/tool-p1'],
      },
    });
    const markerP2 = marker({
      pid: 4_212,
      happySessionId: 'session-provider-p2',
      processStartTimeMs: 21_002,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        adoptedManagedProviderAuthority: {
          pluginId,
          immutableGenerationId: providerP2,
          manifestAuthority: 'external',
          hardRevocationRevisionAtAdmission: 0,
        },
        sourceGenerationIds: [currentQ],
        qualifiedDependencyIds: ['acme.provider/tool-p2'],
      },
    });
    const markers = [markerP1, markerP2] as const;
    const verifySessionMarkerProcessLiveness = async (
      candidate: SessionMarkerProcessIdentity,
    ) => livePids.has(candidate.pid)
      ? {
          status: 'verified_running' as const,
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs!,
        }
      : {
          status: 'verified_stopped' as const,
          pid: candidate.pid,
          processStartTimeMs: candidate.processStartTimeMs!,
        };

    const writeGeneration = async (generationId: string) => {
      const root = join(paths.generationsDir, generationId);
      const runtime = `export default ${JSON.stringify(generationId)};`;
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'runtime.mjs'), runtime, 'utf8');
      await writeFile(
        join(root, 'plugin-generation.v1.json'),
        JSON.stringify({
          t: 'happier_plugin_generation_v1',
          schemaVersion: 1,
          pluginId,
          immutableGenerationId: generationId,
          createdAtMs: 1,
          files: [{
            relativePath: 'runtime.mjs',
            byteLength: Buffer.byteLength(runtime),
          }],
          manifestRelativePath: 'runtime.mjs',
        }),
        'utf8',
      );
      return root;
    };

    try {
      const roots = new Map(await Promise.all(
        [providerP1, providerP2, currentQ].map(async (generationId) => [
          generationId,
          await writeGeneration(generationId),
        ] as const),
      ));
      const state: PluginInstallationStateRevision = {
        t: 'happier_plugin_installations_v1',
        schemaVersion: 1,
        revisionId: 'state-multi-provider-retention',
        createdAtMs: 1,
        plugins: {
          [pluginId]: {
            enabled: true,
            trust: {
              pluginId,
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
      const installationState = await persistInstallationStateRevision({
        paths,
        state,
      });
      const commit: PluginRegistryCommitRecord = {
        t: 'happier_plugin_registry_commit_v1',
        schemaVersion: 1,
        revision: 1,
        transactionId: 'multi-provider-retention',
        baseRevision: 0,
        installationState,
        pluginGenerations: {
          [pluginId]: {
            immutableGenerationId: currentQ,
          },
        },
        createdAtMs: 1,
        creator: { pid: 1, instanceId: 'daemon-q' },
      };
      const readExactRetainedGenerationIds = async () =>
        await readExactLiveRunnerRetainedPluginGenerationIds({
          listSessionMarkers: async () => [...markers],
          verifySessionMarkerProcessLiveness,
        });

      await expect(
        readExactLiveRunnerManagedDependencyRetention({
          listSessionMarkers: async () => markers,
          verifySessionMarkerProcessLiveness,
        }),
      ).resolves.toEqual({
        v: 1,
        sourceGenerationIds: [currentQ],
        qualifiedDependencyIds: [
          'acme.provider/tool-p1',
          'acme.provider/tool-p2',
        ],
      });

      expect(await readExactRetainedGenerationIds()).toEqual(new Set([
        providerP1,
        providerP2,
        currentQ,
      ]));
      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        runnerRetainedGenerationIds:
          await readExactRetainedGenerationIds(),
      })).resolves.toMatchObject({
        retained: [providerP1, providerP2],
        removed: [],
      });

      livePids.delete(markerP1.pid);
      expect(await readExactRetainedGenerationIds()).toEqual(new Set([
        providerP2,
        currentQ,
      ]));
      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        runnerRetainedGenerationIds:
          await readExactRetainedGenerationIds(),
      })).resolves.toMatchObject({
        retained: [providerP2],
        removed: [providerP1],
      });
      await expect(access(roots.get(providerP1)!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(roots.get(providerP2)!)).resolves.toBeUndefined();
      await expect(access(roots.get(currentQ)!)).resolves.toBeUndefined();

      livePids.delete(markerP2.pid);
      expect(await readExactRetainedGenerationIds()).toEqual(new Set());
      await expect(cleanupUnreferencedPluginGenerations({
        paths,
        commit,
        state,
        runnerRetainedGenerationIds:
          await readExactRetainedGenerationIds(),
      })).resolves.toMatchObject({
        retained: [],
        removed: [providerP2],
      });
      await expect(access(roots.get(providerP2)!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(roots.get(currentQ)!)).resolves.toBeUndefined();
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
