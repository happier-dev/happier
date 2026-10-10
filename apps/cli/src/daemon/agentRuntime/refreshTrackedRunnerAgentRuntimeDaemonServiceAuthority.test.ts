import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  loadRetainedAgentRuntimeLeaf,
  verifyRunnerAgentBindingAgainstGeneration,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  currentAgentBindingMatchesRetainedRunner,
  resolveRetainedBundledPluginRoot,
} from '@/plugins/runtime/retainedPluginSourceAttestation';
import { publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import type { TrackedSession } from '@/daemon/types';

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
  it('accepts the runner own published snapshot when the daemon binding names another published snapshot, but rejects a changed publication', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-snapshot-custody-'));
    const snapshotsDir = join(happyHomeDir, '.runner-snapshots');
    const publishSnapshot = async (label: string) => {
      const stagingRoot = join(snapshotsDir, `.staging-${label}`);
      const packageRoot = join(stagingRoot, 'node_modules', '@happier-dev', 'plugins-antigravity');
      await mkdir(join(stagingRoot, 'package-dist'), { recursive: true });
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'agent.mjs'), `export const marker = '${label}';\n`);
      const factoryExport = label === 'runner-a' ? 'createRunnerA' : 'createDaemonB';
      await writeFile(join(packageRoot, `agent-${label}.mjs`), [
        `export function ${factoryExport}() { return {}; }`,
        // A callable obsolete export makes selecting the wrong export a silent defect.
        'export function createRuntime() { throw new Error("Obsolete factory selected"); }',
      ].join('\n'));
      await mkdir(join(packageRoot, '.happier-plugin'), { recursive: true });
      await writeFile(join(packageRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
        createPluginManifestV2Fixture({
          id: 'happier.agent.antigravity',
          version: label === 'runner-a' ? '0.0.0' : '1.0.0',
          runtime: { apiVersion: 1, agentFactories: [{
            localAgentId: 'antigravity',
            locator: { module: `./agent-${label}.mjs`, export: factoryExport, runtimeApiVersion: 1 },
            normalizedModulePath: `agent-${label}.mjs`,
            loadMode: 'immutable-js',
          }] },
          contributes: { agents: [{
            id: 'antigravity',
            title: 'Antigravity',
            runtime: { kind: 'custom' },
            primary: 'sessions',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }] },
        }),
      ));
      const workspaceRuntimeIdentity = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
        runtimeRoot: stagingRoot,
        packageNames: ['@happier-dev/plugins-antigravity'],
      }).fingerprint;
      const snapshot = publishPinnedRunnerSnapshotFixture({
        stagingRoot,
        workspaceRuntimeIdentity,
        workspaceRuntimePackages: ['@happier-dev/plugins-antigravity'],
      });
      return { root: snapshot.snapshotRoot, snapshotId: snapshot.snapshotIdentity, workspaceRuntimeIdentity };
    };
    try {
      const runnerSnapshot = await publishSnapshot('runner-a');
      const daemonSnapshot = await publishSnapshot('daemon-b');
      const command = `node ${join(runnerSnapshot.root, 'package-dist', 'index.mjs')} codex --existing-session session-a`;
      const processCommandHash = createHash('sha256').update(command).digest('hex');
      const retainedAgent = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: 'happier.agent.antigravity',
        pluginVersion: '1.0.0',
        agentId: 'antigravity',
        localAgentId: 'antigravity',
        sourceCustody: {
          kind: 'bundled_first_party',
          packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: daemonSnapshot.snapshotId },
        },
        locator: { module: './agent-daemon-b.mjs', export: 'createDaemonB', runtimeApiVersion: 1 },
        normalizedModulePath: 'agent-daemon-b.mjs',
        loadMode: 'immutable-js',
      });
      const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir, publicReleaseRing: 'stable' });
      const tracked: TrackedSession = {
        startedBy: 'daemon', pid: 4201, sessionRunnerPid: 4202,
        happySessionId: 'session-a', processCommandHash, processStartTimeMs: 12_346,
        agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
        runnerAgentBootstrapIdentity: { agentId: 'antigravity', backendId: 'antigravity' },
      };
      let daemonHttpPort = 3210;
      const refresh = () => refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir, publicReleaseRing: 'stable', httpPort: daemonHttpPort, sessionId: 'session-a', tracked,
        resolveCurrentRetainedAgent: async () => retainedAgent,
        readProcessIdentityByPidFn: async (pid) => ({ pid, command, processStartTimeMs: 12_346 }),
        readPluginHardRevocationRevision: async () => 0,
        persistRunnerAgentSourceCustody: async () => true,
        persistRunnerManagedDependencyRetention: async () => true,
        attachRunnerRetainedPluginGenerations: async ({ attach }) => await attach(),
        bundledAttestationModuleUrl: pathToFileURL(join(daemonSnapshot.root, 'package-dist', 'daemon.mjs')).href,
      });
      const published = await refresh();
      expect(published.document.retainedAgent.sourceCustody).toEqual({
        kind: 'bundled_first_party',
        packagedRuntime: { kind: 'pinned_runner_snapshot', snapshotId: runnerSnapshot.snapshotId },
      });
      expect(published.document.retainedAgent.pluginVersion).toBe('0.0.0');
      expect(published.document.retainedAgent).toMatchObject({
        locator: { module: './agent-runner-a.mjs', export: 'createRunnerA' },
        normalizedModulePath: 'agent-runner-a.mjs',
      });
      await expect(verifyRunnerAgentBindingAgainstGeneration({
        paths: resolvePluginStorePaths({ happyHomeDir }),
        binding: published.document.retainedAgent,
        resolveBundledPluginRoot: (input) => resolveRetainedBundledPluginRoot({
          ...input,
          moduleUrl: pathToFileURL(join(daemonSnapshot.root, 'package-dist', 'daemon.mjs')).href,
        }),
      })).resolves.toMatchObject({
        rootPath: await realpath(join(runnerSnapshot.root, 'node_modules', '@happier-dev', 'plugins-antigravity')),
      });
      const leaf = await loadRetainedAgentRuntimeLeaf({
        paths: resolvePluginStorePaths({ happyHomeDir }),
        binding: published.document.retainedAgent,
        resolveBundledPluginRoot: (input) => resolveRetainedBundledPluginRoot({
          ...input,
          moduleUrl: pathToFileURL(join(daemonSnapshot.root, 'package-dist', 'daemon.mjs')).href,
        }),
      });
      expect(leaf.factory.name).toBe('createRunnerA');
      await expect(readAgentRuntimeDaemonServiceAuthority({
        happyHomeDir, publicReleaseRing: 'stable', path: authorityPath,
        sessionId: 'session-a', runner: published.document.runner,
        retainedAgent: published.document.retainedAgent,
      })).resolves.toEqual(published.document);
      expect(currentAgentBindingMatchesRetainedRunner({
        runnerSnapshotIdentity: `snapshot:${runnerSnapshot.snapshotId}`,
        currentBinding: retainedAgent,
        retainedBinding: published.document.retainedAgent,
      })).toBe(true);
      expect(currentAgentBindingMatchesRetainedRunner({
        runnerSnapshotIdentity: `snapshot:${runnerSnapshot.snapshotId}`,
        currentBinding: { ...retainedAgent, pluginVersion: '2.0.0' },
        retainedBinding: published.document.retainedAgent,
      })).toBe(true);
      const oldVersionBinding = {
        ...published.document.retainedAgent,
        sourceCustody: {
          kind: 'bundled_first_party' as const,
          packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'version-a' },
        },
      };
      expect(currentAgentBindingMatchesRetainedRunner({
        runnerSnapshotIdentity: 'version:version-a',
        currentBinding: {
          ...retainedAgent,
          sourceCustody: {
            kind: 'bundled_first_party',
            packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-b' },
          },
        },
        retainedBinding: oldVersionBinding,
      })).toBe(true);
      expect(currentAgentBindingMatchesRetainedRunner({
        runnerSnapshotIdentity: 'version:version-b',
        currentBinding: retainedAgent,
        retainedBinding: oldVersionBinding,
      })).toBe(false);
      tracked.reattachedFromDiskMarker = true;
      daemonHttpPort = 3211;
      const reattached = await refresh();
      expect(reattached.document.retainedAgent).toEqual(published.document.retainedAgent);
      expect(reattached.document.httpPort).toBe(3211);
      expect(reattached.capabilityDigest).not.toBe(published.capabilityDigest);
      await expect(readAgentRuntimeDaemonServiceAuthority({
        happyHomeDir, publicReleaseRing: 'stable', path: authorityPath,
        sessionId: 'session-a', runner: published.document.runner,
        retainedAgent: published.document.retainedAgent,
      })).resolves.toEqual(reattached.document);
      await writeFile(join(runnerSnapshot.root, '.workspace-runtime-identity'), `${'a'.repeat(64)}\n`);
      await expect(refresh()).rejects.toThrow();
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
