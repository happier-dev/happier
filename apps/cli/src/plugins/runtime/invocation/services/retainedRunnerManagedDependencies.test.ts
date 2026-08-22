import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';

import { createRetainedRunnerManagedDependenciesHost } from './retainedRunnerManagedDependencies';

function managedWheelSource() {
    return {
        kind: 'managedPypiWheelAsset' as const,
        installId: 'dep.shared.retained-wheel' as const,
        distribution: 'shared-retained-wheel',
        versionSpecifier: '>=1,<3',
        assetPathByPlatform: {
            'darwin-arm64': 'shared/bin/tool',
            'linux-arm64': 'shared/bin/tool',
            'linux-x64': 'shared/bin/tool',
            'win32-arm64': 'shared/bin/tool.exe',
            'win32-x64': 'shared/bin/tool.exe',
        },
        executable: true as const,
        installConsent: 'host_managed_required' as const,
        autoUpdateMode: 'notify' as const,
    };
}

function manifest(input: Readonly<{
    pluginId: string;
    definition: Readonly<Record<string, unknown>>;
}>) {
    return {
        schemaVersion: 2,
        id: input.pluginId,
        version: '1.0.0',
        displayName: input.pluginId,
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        contributes: {
            managedDependencies: [input.definition],
        },
    };
}

async function prepareGeneration(input: Readonly<{
    paths: ReturnType<typeof resolvePluginStorePaths>;
    sourceParent: string;
    pluginId: string;
    immutableGenerationId: string;
    definition: Readonly<Record<string, unknown>>;
}>): Promise<void> {
    const sourceRootPath = join(input.sourceParent, input.pluginId);
    const manifestPath = join(
        sourceRootPath,
        '.happier-plugin',
        'plugin.json',
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify(manifest({
            pluginId: input.pluginId,
            definition: input.definition,
        })),
        'utf8',
    );
    const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: input.pluginId,
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: {
            kind: 'localPath',
            canonicalPath: sourceRootPath,
        },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: input.immutableGenerationId,
    });
    await prepareImmutablePluginGeneration({
        paths: input.paths,
        sourceRootPath,
        record,
    });
}

function retainedRunnerInputs() {
    const binding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: 'acme.agent',
        pluginVersion: '1.0.0',
        agentId: 'runner',
        localAgentId: 'runner',
        immutableGenerationId: 'immutable-agent-g',
        locator: {
            module: './runtime.mjs',
            export: 'createRuntime',
            runtimeApiVersion: 1,
        },
        normalizedModulePath: 'runtime.mjs',
        loadMode: 'immutable-js',
    });
    const hostAccessRequests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[] = [{
                required: true,
                request: {
                    id: 'runner-process',
                    capability: 'process',
                    reason: 'Exercise exact retained managed dependencies',
                    scope: {
                        executables: [{
                            kind: 'managedDependency',
                            id: {
                                pluginId: 'acme.control',
                                localId: 'tool',
                            },
                        }, {
                            kind: 'managedDependency',
                            id: {
                                pluginId: 'acme.loser',
                                localId: 'tool',
                            },
                        }],
                    },
                },
            }];
    return Object.freeze({ binding, hostAccessRequests });
}

describe('retained Runner managed dependencies', () => {
    it('keeps the exact bundled collision winner while preserving a non-conflicting external control', async () => {
        const happyHomeDir = await mkdtemp(join(
            tmpdir(),
            'happier-retained-managed-home-',
        ));
        const sourceParent = await mkdtemp(join(
            tmpdir(),
            'happier-retained-managed-source-',
        ));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const systemExecutable = basename(process.execPath);
        const sharedDefinition = {
            id: 'tool',
            title: 'Shared retained wheel',
            description: 'Exact collision candidate',
            sources: [managedWheelSource()],
            executable: 'tool',
        };
        const controlDefinition = {
            id: 'tool',
            title: 'External retained control',
            sources: [{
                kind: 'system' as const,
                executableNames: [systemExecutable],
            }],
            executable: systemExecutable,
        };
        try {
            await Promise.all([
                prepareGeneration({
                    paths,
                    sourceParent,
                    pluginId: 'acme.control',
                    immutableGenerationId: 'generation-control',
                    definition: controlDefinition,
                }),
                prepareGeneration({
                    paths,
                    sourceParent,
                    pluginId: 'acme.loser',
                    immutableGenerationId: 'generation-loser',
                    definition: sharedDefinition,
                }),
                prepareGeneration({
                    paths,
                    sourceParent,
                    pluginId: 'happier.winner',
                    immutableGenerationId: 'generation-winner',
                    definition: sharedDefinition,
                }),
            ]);
            const retainedAgent = retainedRunnerInputs();
            const host = await createRetainedRunnerManagedDependenciesHost({
                paths,
                binding: retainedAgent.binding,
                hostAccessRequests: retainedAgent.hostAccessRequests,
                retention: {
                    v: 1,
                    sourceGenerationIds: [
                        'generation-control',
                        'generation-loser',
                        'generation-winner',
                    ],
                    qualifiedDependencyIds: [
                        'acme.control/tool',
                        'acme.loser/tool',
                    ],
                    sourceCandidates: [{
                        qualifiedDependencyId: 'acme.control/tool',
                        immutableGenerationId: 'generation-control',
                        manifestAuthority: 'external',
                    }, {
                        qualifiedDependencyId: 'acme.loser/tool',
                        immutableGenerationId: 'generation-loser',
                        manifestAuthority: 'external',
                    }, {
                        qualifiedDependencyId: 'happier.winner/tool',
                        immutableGenerationId: 'generation-winner',
                        manifestAuthority: 'bundled_first_party',
                    }],
                },
                agentManifestAuthority: 'external',
                env: {
                    ...process.env,
                    PATH: dirname(process.execPath),
                },
            });

            await expect(host.resolveExecutable({
                kind: 'managedDependency',
                id: {
                    pluginId: 'acme.loser',
                    localId: 'tool',
                },
            }, 'acme.agent')).rejects.toMatchObject({
                code: 'plugin_managed_dependency_source_conflict',
            });
            const control = await host.resolveExecutable({
                kind: 'managedDependency',
                id: {
                    pluginId: 'acme.control',
                    localId: 'tool',
                },
            }, 'acme.agent');
            expect(basename(control.command)).toBe(systemExecutable);
            control.release();
        } finally {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(sourceParent, { recursive: true, force: true });
        }
    });
});
