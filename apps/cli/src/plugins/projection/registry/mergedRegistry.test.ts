import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
    getResolvedContributionRegistry,
    primeResolvedContributionRegistry,
    resolveMergedContributionRegistry,
} from './createResolvedContributionRegistry';

function createTestAcpBackendEngine(): Record<string, unknown> {
    return {
        kind: 'acp',
        transport: {
            kind: 'stdio',
            launch: {
                kind: 'executable',
                command: 'acme-agent',
            },
        },
        ux: {
            title: 'Acme Agent',
        },
    };
}

function createTestAgentContribution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'acme.ohmypi',
        catalogAgentId: 'claude',
        display: {
            name: 'Acme Oh My Pi',
            tags: ['plugin'],
        },
        runtime: createTestAcpBackendEngine(),
        capabilities: {},
        ownedBackendIds: ['acme.ohmypi'],
        surfaceHandlers: [
            {
                surfaceApiVersion: 1,
                id: 'backend.terminalRuntime.launch',
                kind: 'terminalRuntime',
                operation: 'launch',
                handler: {
                    target: 'daemon',
                    exportName: 'launch',
                },
            },
        ],
        ...overrides,
    };
}

function createResolvePrerequisitesHook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        hookApiVersion: 1,
        id: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        executionKind: 'decide',
        handler: {
            target: 'plugin',
            exportName: 'resolveTranscriptBinding',
        },
        ...overrides,
    };
}

async function writePluginManifest(rootDir: string, manifestOverrides?: Record<string, unknown>): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(rootDir, 'daemon.js'), 'export async function launch() { return null; }\n', 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            createPluginManifestV2Fixture({
                schemaVersion: 2,
                id: 'acme.ohmypi',
                version: '1.0.0',
                displayName: 'Acme Oh My Pi',
                description: 'Adds Oh My Pi support',
                engines: {
                    happier: '^0.2.0',
                },
                uses: ['agents', 'actions', 'hooks'],
                entrypoints: {
                    main: './daemon.js',
                },
                permissions: {
                    required: [],
                    optional: [],
                },
                contributes: {
                    agents: [createTestAgentContribution()],
                    actions: [{
                        kind: 'action',
                        id: 'acme.ohmypi.review.start',
                        title: 'Acme Review Start',
                        description: 'Starts a plugin-defined review workflow',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        placement: 'commandPalette',
                        dangerLevel: 'safe',
                        handler: {
                            target: 'daemon',
                            exportName: 'launch',
                        },
                    }],
                    hooks: [createResolvePrerequisitesHook()],
                },
                ...(manifestOverrides ?? {}),
            }),
            null,
            2,
        ),
        'utf8',
    );
    await writeFile(
        join(rootDir, 'daemon.js'),
        [
            'export async function launch() { return null; }',
            'export async function resolveTranscriptBinding() { return null; }',
            'export default async function defaultHookHandler() { return null; }',
        ].join('\n'),
        'utf8',
    );
}

describe('resolveMergedContributionRegistry', () => {
    it('merges enabled plugin provider/backend/hook contributes without widening the built-in AGENTS facade', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-merged-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot);

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme.ohmypi')).toMatchObject({
            id: 'acme.ohmypi',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.ohmypi',
                ownedBackendIds: ['acme.ohmypi'],
            },
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi')).toMatchObject({
            id: 'acme.ohmypi',
            agentId: 'acme.ohmypi',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.ohmypi',
                agentId: 'acme.ohmypi',
            },
            surfaceHandlers: [
                expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            ],
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi')?.getRuntimeCore).toEqual(expect.any(Function));
        expect(registry.surfaceHandlersByBackendId.get('acme.ohmypi')).toEqual([
            expect.objectContaining({
                backendId: 'acme.ohmypi',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            }),
        ]);
        expect(registry.actions).toHaveLength(1);
        expect(registry.actions[0]).toMatchObject({
            pluginId: 'acme.ohmypi',
            definition: expect.objectContaining({
                id: 'acme.ohmypi.review.start',
            }),
        });
        expect(registry.hookRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.ohmypi',
                definition: expect.objectContaining({
                    id: 'agent.resolvePrerequisites',
                }),
            }),
        ]);
        expect(registry.catalogEntriesById.codex?.id).toBe('codex');
        expect(registry.catalogEntriesById['acme.ohmypi']).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual([]);
    });

    it('retains rich built-in and plugin definitions needed by merged projection consumers', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-rich-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-rich-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme.ohmypi',
                    catalogAgentId: 'claude',
                    display: {
                        name: 'Acme Oh My Pi',
                        subtitle: 'Plugin provider',
                        tags: ['plugin'],
                    },
                    install: {
                        docsUrl: 'https://example.com/plugins/acme.ohmypi',
                        managedInstallBehavior: 'manual',
                        sourcePreference: 'system-first',
                    },
                    auth: {
                        machineLoginSupport: 'status_only',
                        connectedServiceCompatibility: ['anthropic'],
                    },
                    ownedBackendIds: ['acme.ohmypi'],
                    capabilities: {
                        terminalRuntime: true,
                    },
                    probe: {
                        models: {
                            strategy: 'best_effort',
                        },
                    },
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('codex')).toMatchObject({
            id: 'codex',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'codex',
                ownedBackendIds: ['codex'],
            },
            runtimeSpec: expect.objectContaining({
                id: 'codex',
                binaryName: 'codex',
            }),
            catalogEntry: expect.objectContaining({
                id: 'codex',
                cliSubcommand: 'codex',
            }),
            pluginId: 'happier.agent.codex',
        });
        expect(registry.agentDefinitionsById.get('codex')).not.toHaveProperty('richDefinition');
        expect(registry.agentRuntimeDefinitionsById.get('codex')).toMatchObject({
            id: 'codex',
            agentId: 'codex',
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: 'codex',
                agentId: 'codex',
            },
            runtimeKind: 'appServer',
            pluginId: 'happier.agent.codex',
        });
        expect(registry.agentRuntimeDefinitionsById.get('codex')).not.toHaveProperty('richDefinition');
        expect(registry.agentRuntimeDefinitionsById.get('codex')).not.toHaveProperty('getRuntimeCore');
        expect(registry.agentDefinitionsById.get('acme.ohmypi')).toMatchObject({
            richDefinition: {
                provenance: 'external',
                definition: expect.objectContaining({
                    display: expect.objectContaining({
                        name: 'Acme Oh My Pi',
                        subtitle: 'Plugin provider',
                    }),
                    install: expect.objectContaining({
                        docsUrl: 'https://example.com/plugins/acme.ohmypi',
                    }),
                    auth: expect.objectContaining({
                        machineLoginSupport: 'status_only',
                    }),
                }),
            },
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi')).toMatchObject({
            richDefinition: {
                provenance: 'external',
                definition: expect.objectContaining({
                    runtimeKind: 'acp',
                    capabilities: expect.objectContaining({
                        executionRun: expect.objectContaining({
                            supported: true,
                        }),
                    }),
                    surfaceHandlers: expect.arrayContaining([
                        expect.objectContaining({
                            kind: 'terminalRuntime',
                            operation: 'launch',
                        }),
                    ]),
                    install: expect.objectContaining({
                        sourcePreference: 'system-first',
                    }),
                    probe: expect.objectContaining({
                        models: expect.objectContaining({
                            strategy: 'best_effort',
                        }),
                    }),
                }),
            },
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi')?.getRuntimeCore).toEqual(expect.any(Function));
    });

    it('promotes a primed merged registry snapshot to the active contribution registry cache', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-prime-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-merged-prime-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot);
        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        expect(getResolvedContributionRegistry().catalogEntriesById['acme.ohmypi']).toBeUndefined();

        const mergedRegistry = await primeResolvedContributionRegistry({ happyHomeDir });
        expect(mergedRegistry.catalogEntriesById['acme.ohmypi']).toBeUndefined();

        const activeRegistry = getResolvedContributionRegistry();
        expect(activeRegistry.catalogEntriesById['acme.ohmypi']).toBeUndefined();
    });

    it('records a diagnostic and excludes plugin agents whose declared runtime does not resolve', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-invalid-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.invalid',
            displayName: 'Acme Invalid',
            description: 'Invalid agent runtime reference',
            contributes: {
                agents: [
                    createTestAgentContribution({
                        id: 'acme.invalid',
                        display: {
                            name: 'Acme Invalid',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.missing.runtime'],
                        surfaceHandlers: [],
                    }),
                ],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.invalid': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme.invalid')).toBeUndefined();
        expect(registry.agentRuntimeDefinitionsById.get('acme.invalid')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.invalid']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]));
    });

    it('projects review-only execution-run agents without creating catalog entries', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-review-backend-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-review-backend-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.review.coderabbit',
            displayName: 'CodeRabbit Review',
            description: 'Review-only CodeRabbit engine',
            uses: ['agents', 'executionRunProfiles'],
            contributes: {
                agents: [
                    createTestAgentContribution({
                        id: 'acme-review',
                        catalogAgentId: undefined,
                        ownedBackendIds: ['acme-review'],
                        display: {
                            name: 'Acme Review',
                            tags: ['review'],
                        },
                        runtime: { kind: 'custom' },
                        capabilities: {
                            session: { supported: false },
                            executionRun: {
                                supported: true,
                                review: {
                                    intents: ['review'],
                                    modes: ['change_scoped_review'],
                                    directCommentWrite: false,
                                },
                            },
                        },
                        surfaceHandlers: [],
                    }),
                ],
                executionRunProfiles: [
                    {
                        id: 'acme.review',
                        kind: 'executionRun.profile',
                        version: '1',
                        intent: 'review',
                        displayKey: 'plugins.coderabbit.executionRuns.review.label',
                    },
                ],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.review.coderabbit': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme-review')).toMatchObject({
            id: 'acme-review',
            pluginId: 'acme.review.coderabbit',
            runtimeSpec: null,
        });
        expect(registry.catalogEntriesById['acme-review']).toBeUndefined();
        expect(registry.agentRuntimeDefinitionsById.get('acme-review')).toMatchObject({
            id: 'acme-review',
            agentId: 'acme-review',
            pluginId: 'acme.review.coderabbit',
            capabilities: {
                session: expect.objectContaining({ supported: false }),
                executionRun: expect.objectContaining({
                    supported: true,
                    review: expect.objectContaining({
                        directCommentWrite: false,
                    }),
                }),
            },
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme-review')).not.toHaveProperty('getRuntimeCore');
        expect(registry.executionRunProfilesById?.get('acme.review')).toMatchObject({
            pluginId: 'acme.review.coderabbit',
            definition: expect.objectContaining({
                id: 'acme.review',
                intent: 'review',
            }),
        });
        expect(registry.pluginDiagnosticsByPluginId['acme.review.coderabbit']).toEqual([]);
    });

    it('records a diagnostic and excludes plugin agents whose owned runtime ids do not resolve', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-orphaned-provider-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.orphaned',
            displayName: 'Acme Orphaned',
            description: 'Agent points at a missing runtime',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme.orphaned',
                    display: {
                        name: 'Acme Orphaned',
                        tags: ['plugin'],
                    },
                    ownedBackendIds: ['acme.orphaned.backend'],
                    surfaceHandlers: [],
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.orphaned': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme.orphaned')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.orphaned']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]));
    });

    it('records a diagnostic and excludes plugin hooks that target plugin exports without an exportName', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-export-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.hook-export-missing',
            displayName: 'Acme Hook Export Missing',
            description: 'Plugin hook omits exportName',
            uses: ['hooks'],
            contributes: {
                hooks: [createResolvePrerequisitesHook({
                    handler: {
                        target: 'plugin',
                    },
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.hook-export-missing': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.hookRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.hook-export-missing',
                definition: expect.objectContaining({
                    id: 'agent.resolvePrerequisites',
                    handler: expect.objectContaining({
                        target: 'plugin',
                    }),
                }),
            }),
        ]);
        expect(registry.pluginDiagnosticsByPluginId['acme.hook-export-missing']).toEqual([]);
    });

    it('rejects retired flat backend contributions instead of normalizing owner aliases', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-backend-owner-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-backend-owner-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: [
                {
                    kind: 'backend',
                    kindVersion: 1,
                    id: 'acme.ohmypi.acp',
                    agentId: 'codex',
                    engine: createTestAcpBackendEngine(),
                    capabilities: {},
                    surfaceHandlers: [],
                },
            ],
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi.acp')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_invalid',
            }),
        ]);
    });

    it('records diagnostics and strips alias-shaped built-in compatibility ids from plugin contributes while preserving agent entries', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-compat-ids-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-compat-ids-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme.ohmypi',
                    display: {
                        name: 'Acme Oh My Pi',
                        tags: ['plugin'],
                    },
                    ownedBackendIds: ['acme.ohmypi'],
                    catalogAgentId: 'gpt',
                    iconAgentId: 'open-code',
                    capabilities: {},
                    surfaceHandlers: [],
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.ohmypi': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentDefinitionsById.get('acme.ohmypi')).toMatchObject({
            richDefinition: {
                provenance: 'external',
                definition: expect.not.objectContaining({
                    catalogAgentId: expect.anything(),
                    iconAgentId: expect.anything(),
                }),
            },
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.ohmypi')).toMatchObject({
            richDefinition: {
                provenance: 'external',
                definition: expect.not.objectContaining({
                    catalogAgentId: expect.anything(),
                    iconAgentId: expect.anything(),
                }),
            },
        });
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
                message: expect.stringMatching(/catalogAgentId/i),
            }),
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
                message: expect.stringMatching(/iconAgentId/i),
            }),
        ]));
    });

    it('keeps plugin agent runtimes visible for projection while withholding live runtime when no exact built-in compatibility carrier exists', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-runtime-gating-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-gating-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.runtime',
            displayName: 'Acme Runtime',
            description: 'Runtime without an exact built-in compatibility carrier',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme.runtime',
                    catalogAgentId: undefined,
                    display: {
                        name: 'Acme Runtime',
                        tags: ['plugin'],
                    },
                    ownedBackendIds: ['acme.runtime'],
                    capabilities: {},
                    surfaceHandlers: [
                        {
                            surfaceApiVersion: 1,
                            id: 'launch-adapter',
                            kind: 'terminalRuntime',
                            operation: 'launch',
                            handler: {
                                target: 'daemon',
                                exportName: 'launch',
                            },
                        },
                    ],
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });

        expect(registry.agentRuntimeDefinitionsById.get('acme.runtime')).toMatchObject({
            id: 'acme.runtime',
            agentId: 'acme.runtime',
        });
        expect(registry.agentRuntimeDefinitionsById.get('acme.runtime')).not.toHaveProperty('getRuntimeCore');
        expect(registry.surfaceHandlersByBackendId.get('acme.runtime')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime',
                definition: expect.objectContaining({
                    kind: 'terminalRuntime',
                    operation: 'launch',
                }),
            }),
        ]);
        expect(registry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]));
    });

    it('projects external agent CLI runtime facts from final agent vocabulary', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-agent-cli-runtime-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-agent-cli-runtime-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.runtime',
            displayName: 'Acme Runtime',
            description: 'Runtime with plugin-authored agent CLI facts',
            contributes: {
                agents: [createTestAgentContribution({
                    id: 'acme.runtime',
                    display: {
                        name: 'Acme Runtime',
                        tags: ['plugin'],
                    },
                    agentCliRuntime: {
                        id: 'acme.runtime',
                        title: 'Acme Runtime',
                        binaryName: 'acme-runtime',
                        sourcePreferenceDefault: 'system-first',
                        managedInstall: null,
                        manualInstallKind: 'command',
                        manualInstallRecipes: null,
                        acceptsJavaScriptFileOverride: false,
                    },
                    ownedBackendIds: [],
                    surfaceHandlers: [],
                })],
            },
        });

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime': {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: {
                        status: 'unknown',
                        diagnostics: [],
                    },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        manifestDigest: null,
                        installedPath: null,
                    },
                    state: {
                        enabled: true,
                    },
                },
            },
        });

        const registry = await resolveMergedContributionRegistry({ happyHomeDir });
        const provider = registry.agentDefinitionsById.get('acme.runtime');

        expect(provider).toBeDefined();
        if (!provider) {
            throw new Error('Expected acme.runtime provider contribution to be registered');
        }
        expect(provider.richDefinition).toBeDefined();
        if (!provider.richDefinition) {
            throw new Error('Expected acme.runtime provider contribution to keep its rich definition');
        }

        expect(provider.runtimeSpec).toEqual(expect.objectContaining({
            id: 'acme.runtime',
            title: 'Acme Runtime',
            binaryName: 'acme-runtime',
        }));
        expect(provider.richDefinition.definition).toEqual(expect.objectContaining({
            agentCliRuntime: expect.objectContaining({
                id: 'acme.runtime',
                title: 'Acme Runtime',
                binaryName: 'acme-runtime',
            }),
        }));
        expect(provider.richDefinition.definition).not.toHaveProperty('providerCliRuntime');
    });
});
