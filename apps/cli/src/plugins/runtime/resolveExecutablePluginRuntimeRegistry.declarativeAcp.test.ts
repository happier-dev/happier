import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type {
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import {
    buildQualifiedPluginContributionKey,
    type PluginAgentContributionV2,
} from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { loadRetainedAgentRuntimeLeaf } from './runner/loadRetainedAgentRuntimeLeaf';

describe('resolveExecutablePluginRuntimeRegistry declarative ACP admission', () => {
    it.each([
        {
            label: 'installed external',
            pluginId: 'acme.declarative-acp-installed',
            provenance: 'external' as const,
            sourceKind: 'package' as const,
            sourceSpec: {
                kind: 'package' as const,
                locator: '@acme/declarative-acp-installed',
                trustPolicy: 'prompt' as const,
                installPolicy: 'copy' as const,
                resolvedVersion: '1.0.0',
            },
        },
        {
            label: 'local development',
            pluginId: 'acme.declarative-acp-local',
            provenance: 'external' as const,
            sourceKind: 'path' as const,
            sourceSpec: {
                kind: 'path' as const,
                locator: '/plugins/acme.declarative-acp-local',
                trustPolicy: 'local_trusted' as const,
                installPolicy: 'link' as const,
                resolvedVersion: '1.0.0',
                devWatch: true,
            },
        },
    ])('retains an immutable host ACP runner binding for $label without activation or a plugin factory', async ({
        pluginId,
        provenance,
        sourceKind,
        sourceSpec,
    }) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declarative-runner-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-declarative-runner-plugin-'));
        const localAgentId = 'declarative-agent';
        const agentId = provenance === 'first_party'
            ? localAgentId
            : buildQualifiedPluginContributionKey({
                pluginId,
                localId: localAgentId,
            });
        let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
            const agentDefinition = {
                id: localAgentId,
                title: 'Declarative Agent',
                runtime: {
                    kind: 'acp',
                    transport: {
                        kind: 'tcp',
                        host: '127.0.0.1',
                        port: 4242,
                    },
                    definition: {
                        modelConfigOptionId: 'model',
                        stderrRules: {
                            suppress: [{
                                includes: ['known harmless ACP notification'],
                            }],
                        },
                        mcp: { policy: 'pass_through' },
                    },
                },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            } satisfies PluginAgentContributionV2;
            const manifest = createPluginManifestV2Fixture({
                id: pluginId,
                entrypoints: undefined,
                contributes: {
                    agents: [agentDefinition],
                },
            });
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(
                join(pluginRoot, '.happier-plugin', 'plugin.json'),
                JSON.stringify(manifest),
                'utf8',
            );
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const record = await createImmutablePluginGenerationRecordFromSource({
                pluginId,
                sourceRootPath: pluginRoot,
                manifestRelativePath: '.happier-plugin/plugin.json',
                distribution: {
                    kind: 'localPath',
                    canonicalPath: pluginRoot,
                },
                updatePolicy: 'manual',
                createdAtMs: 1,
                immutableGenerationId: `declarative-${sourceKind}-generation`,
            });
            const prepared = await prepareImmutablePluginGeneration({
                paths,
                sourceRootPath: pluginRoot,
                record,
            });
            const contributes = createResolvedContributionRegistry({
                agents: [{
                    id: agentId,
                    identity: { pluginId, localId: localAgentId },
                    provenance,
                    source: { kind: sourceKind },
                    definition: {
                        kindVersion: 1,
                        id: agentId,
                        ownedBackendIds: [],
                    },
                    richDefinition: {
                        provenance,
                        definition: agentDefinition,
                    },
                    pluginId,
                    hostAccess: { required: [], optional: [] },
                    sourceSpec,
                }],
                activationTargets: [],
            });
            runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes,
                generation: 1,
                generationAuthority: {
                    commit: null,
                    generations: new Map([[pluginId, {
                        pluginId,
                        immutableGenerationId: record.immutableGenerationId,
                        rootPath: prepared.rootPath,
                        record,
                    }]]),
                    rejectedGenerations: new Map(),
                    unavailableBundledPackageNames: new Set(),
                    isCurrent: async () => true,
                },
            });

            const lease = runtimeRegistry.agentRuntimesByAgentId.get(agentId);
            const binding = lease?.sessionRunnerFactoryBinding;
            if (!binding) {
                throw new Error('Expected a retained declarative ACP runner binding');
            }
            expect(binding).toMatchObject({
                kind: 'host_declarative_acp_v1',
                pluginId,
                pluginVersion: '1.0.0',
                agentId,
                qualifiedAgentId: `${pluginId}/agents/${localAgentId}`,
                localAgentId,
                immutableGenerationId: record.immutableGenerationId,
            });
            expect(binding).not.toHaveProperty('manifestDigest');
            expect(binding).not.toHaveProperty('runtimeBindingDigest');
            const counters = {
                activation: 0,
                module: 0,
                pluginFactory: 0,
                composer: 0,
            };
            const leaf = await loadRetainedAgentRuntimeLeaf({
                paths,
                binding,
            });
            const runtime = await leaf.factory({
                plugin: { id: pluginId, version: '1.0.0' },
                agent: { id: agentId },
                signal: new AbortController().signal,
            });
            const session = await runtime.sessions?.open(
                {
                    kind: 'create',
                    sessionId: `host-${sourceKind}`,
                    cwd: pluginRoot,
                },
                {
                    protocols: {
                        acp: {
                            open: async (
                                _request: Parameters<
                                    AgentSessionRuntimeContext[
                                        'protocols'
                                    ]['acp']['open']
                                >[0],
                                options: Parameters<
                                    AgentSessionRuntimeContext[
                                        'protocols'
                                    ]['acp']['open']
                                >[1],
                            ) => {
                                counters.composer += 1;
                                expect(options).toEqual({
                                    transport: {
                                        kind: 'tcp',
                                        host: '127.0.0.1',
                                        port: 4242,
                                    },
                                    definition: {
                                        modelConfigOptionId: 'model',
                                        stderrRules: {
                                            suppress: [{
                                                includes: ['known harmless ACP notification'],
                                            }],
                                        },
                                        mcp: { policy: 'pass_through' },
                                    },
                                });
                                return {
                                    send: async () => ({
                                        status: 'admitted' as const,
                                    }),
                                    watch: () => ({ dispose() {} }),
                                    dispose() {},
                                };
                            },
                        },
                    },
                } as unknown as AgentSessionRuntimeContext,
            );

            expect(session).toBeDefined();
            expect(counters).toEqual({
                activation: 0,
                module: 0,
                pluginFactory: 0,
                composer: 1,
            });
            expect(record.files.map((file) => file.relativePath)).toEqual([
                '.happier-plugin/plugin.json',
            ]);
            if (sourceKind === 'package') {
                if (!('kind' in binding)) {
                    throw new Error('Expected a host declarative ACP binding');
                }
                const hostBinding = binding;
                const mutations: readonly (readonly [string, unknown])[] = [
                    ['plugin id', {
                        ...hostBinding,
                        pluginId: 'acme.substituted',
                    }],
                    ['plugin version', {
                        ...hostBinding,
                        pluginVersion: '9.9.9',
                    }],
                    ['Agent id', {
                        ...hostBinding,
                        agentId: 'substituted-agent',
                    }],
                    ['qualified Agent id', {
                        ...hostBinding,
                        qualifiedAgentId:
                            'acme.substituted/agents/declarative-agent',
                    }],
                    ['local Agent id', {
                        ...hostBinding,
                        localAgentId: 'substituted-agent',
                    }],
                    ['immutable generation', {
                        ...hostBinding,
                        immutableGenerationId: 'substituted-generation',
                    }],
                    ['adapter ABI', {
                        ...hostBinding,
                        kind: 'host_declarative_acp_v2',
                    }],
                ];
                for (const [_label, mutation] of mutations) {
                    await expect(loadRetainedAgentRuntimeLeaf({
                        paths,
                        binding: mutation,
                    })).rejects.toThrow();
                    expect(counters.composer).toBe(1);
                }
            }
        } finally {
            await runtimeRegistry?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });

    it('admits invocation services for an entrypoint-free Agent from the normalized catalog', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declarative-agent-services-home-'));
        const agentId = 'novel-declarative-acp-agent';
        const pluginId = 'acme.declarative-acp-proof';
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                agents: [{
                    id: agentId,
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: { kindVersion: 1, id: agentId, ownedBackendIds: [] },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            id: agentId,
                            title: 'Novel Declarative ACP Agent',
                            runtime: {
                                kind: 'acp',
                                transport: {
                                    kind: 'stdio',
                                    executable: { kind: 'systemTool', id: 'fixture-acp' },
                                },
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                            },
                        },
                    },
                    pluginId,
                    hostAccess: {
                        required: [{
                            id: 'agent-process',
                            capability: 'process',
                            reason: 'Run the declared Agent executable',
                            scope: { executables: [{ kind: 'systemTool', id: 'fixture-acp' }] },
                        }],
                        optional: [],
                    },
                    sourceSpec: {
                        kind: 'path',
                        locator: '/plugins/acme.declarative-acp-proof',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedVersion: '1.0.0',
                    },
                }],
                activationTargets: [],
            }),
            generation: 17,
            generationAuthority: {
                commit: null,
                generations: new Map(),
                rejectedGenerations: new Map(),
                unavailableBundledPackageNames: new Set(),
                isCurrent: async () => true,
            },
        });

        try {
            const lease = runtimeRegistry.agentRuntimesByAgentId.get(agentId);
            expect(lease).toMatchObject({ pluginId, agentId, generation: '17' });
            const services = await runtimeRegistry.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId,
                generation: '17',
                correlationId: 'declarative-agent-services',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(services.storage.daemon.set('proof', 'catalog-owned')).resolves.toBeUndefined();
            await expect(services.storage.daemon.get('proof')).resolves.toBe('catalog-owned');
        } finally {
            await runtimeRegistry.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
