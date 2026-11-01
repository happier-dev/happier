import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveBuiltInContributions } from '../../projection/registry/resolveBuiltInContributions';
import { resolvePluginStorePaths } from '../../store/paths';
import { createBundledActivationSourceResolver } from '../bundledActivationSource';
import { loadPluginModule } from '../loadPluginModule';
import { attestFreshRunnerAgentBinding } from '../retainedPluginSourceAttestation';
import { bindPluginRuntimeSourceAuthority } from '../sourceAuthority';
import { createAgentSessionRunnerFactoryBinding } from './agentSessionRunnerFactoryBinding';
import { loadRetainedAgentRuntimeLeaf } from './loadRetainedAgentRuntimeLeaf';

describe('retained development source entries', () => {
    it('rejects a packaged TypeScript entry', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-selected-source-entry-'));
        try {
            const entryPath = join(root, 'index.ts');
            await writeFile(entryPath, 'export const value: string = "source-entry";');
            await expect(loadPluginModule({
                source: {
                    kind: 'file_backed', entryPath,
                    committedAuthorization: { pluginId: 'acme.packaged', immutableGenerationId: 'packaged-entry' },
                },
            })).rejects.toMatchObject({ code: 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each(['claude', 'codex'])('loads the real %s runner leaf and its development activation entry', async (agentId) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-first-party-source-entry-'));
        let leaf: Awaited<ReturnType<typeof loadRetainedAgentRuntimeLeaf>> | undefined;
        try {
            const agent = resolveBuiltInContributions().agents.find(candidate => candidate.id === agentId);
            if (!agent?.identity || !agent.daemonEntryPath) throw new Error('First-party Agent declaration unavailable');
            const source = createBundledActivationSourceResolver({
                bundledPackageNames: [agent.daemonEntryPath],
                resolveDevelopmentSourceAuthority: ({ rootPath }) => {
                    const authority = bindPluginRuntimeSourceAuthority({
                        custody: { kind: 'development', registeredRootId: rootPath },
                        resolvedRoot: rootPath,
                        observedRevision: 0,
                    });
                    return authority.kind === 'development' ? authority : null;
                },
            })({ pluginId: agent.identity.pluginId, daemonEntryPath: agent.daemonEntryPath });
            if (source?.sourceAuthority?.kind !== 'development') throw new Error('Development source unavailable');
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const runnerSnapshotIdentity = `path:${join(source.sourceAuthority.registeredRootId, '..', '..', '..', 'apps', 'cli')}`;
            const binding = await attestFreshRunnerAgentBinding({
                paths, runnerSnapshotIdentity,
                binding: createAgentSessionRunnerFactoryBinding({
                    v: 1, pluginId: agent.identity.pluginId, pluginVersion: '0.0.0',
                    agentId: agent.id, localAgentId: agent.identity.localId,
                    sourceCustody: { kind: 'development', registeredRootId: source.sourceAuthority.registeredRootId },
                    locator: { module: './agent/runtime/factory', export: agentId === 'claude' ? 'createClaudeAgentRuntime' : 'createCodexAgentRuntime', runtimeApiVersion: 1 },
                    normalizedModulePath: 'src/agent/runtime/factory.ts', loadMode: 'source-ts',
                }),
            });
            leaf = await loadRetainedAgentRuntimeLeaf({
                paths, binding,
                developmentRunnerSnapshotIdentity: runnerSnapshotIdentity,
            });
            expect(leaf.factory).toEqual(expect.any(Function));
            expect(leaf.catalogEntry?.id).toBe(agent.id);
        } finally {
            await leaf?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    // This composes the cold first-party source graph; use the CLI integration
    // lane's budget rather than the unit lane's (observed cold load: 35 seconds).
    }, 60_000);
});
