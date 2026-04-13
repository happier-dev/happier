import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';

import { resolveMergedContributionRegistry } from './createResolvedContributionRegistry';

async function writePluginManifest(rootDir: string, manifestOverrides?: Record<string, unknown>): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                id: 'acme.ohmypi',
                version: '1.0.0',
                displayName: 'Acme Oh My Pi',
                description: 'Adds Oh My Pi support',
                engines: {
                    happier: '^0.2.0',
                },
                targets: {
                    daemon: {
                        entry: './daemon.js',
                    },
                },
                contributions: {
                    providers: [
                        {
                            kindVersion: 1,
                            id: 'acme.ohmypi',
                            display: {
                                name: 'Acme Oh My Pi',
                                tags: ['plugin'],
                            },
                            ownedBackendIds: ['acme.ohmypi.acp'],
                            catalogEntry: {
                                id: 'acme.ohmypi',
                                cliSubcommand: 'acme.ohmypi',
                                vendorResumeSupport: 'unsupported',
                            },
                        },
                    ],
                    backends: [
                        {
                            kindVersion: 1,
                            id: 'acme.ohmypi.acp',
                            providerId: 'acme.ohmypi',
                            runtimeKind: 'acp',
                            capabilities: {},
                            runtimeAdapters: [
                                {
                                    runtimeAdapterApiVersion: 1,
                                    id: 'backend.terminalRuntime.launch',
                                    kind: 'terminalRuntime',
                                    handler: {
                                        target: 'daemon',
                                        exportName: 'launch',
                                    },
                                },
                            ],
                        },
                    ],
                    hooks: [
                        {
                            hookApiVersion: 1,
                            id: 'backend.terminalRuntime.bindTranscript',
                            category: 'integration',
                            scope: 'backend',
                            executionKind: 'integrate',
                            handler: {
                                target: 'plugin',
                                exportName: 'bindTranscript',
                            },
                        },
                    ],
                },
                ...(manifestOverrides ?? {}),
            },
            null,
            2,
        ),
        'utf8',
    );
}

describe('resolveMergedContributionRegistry', () => {
    it('merges enabled plugin provider/backend/hook contributions without widening the built-in AGENTS facade', async () => {
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

        expect(registry.providerDefinitionsById.get('acme.ohmypi')).toMatchObject({
            id: 'acme.ohmypi',
            source: 'plugin',
            definition: {
                kindVersion: 1,
                id: 'acme.ohmypi',
                ownedBackendIds: ['acme.ohmypi.acp'],
            },
        });
        expect(registry.backendDefinitionsById.get('acme.ohmypi.acp')).toMatchObject({
            id: 'acme.ohmypi.acp',
            providerId: 'acme.ohmypi',
            source: 'plugin',
            definition: {
                kindVersion: 1,
                id: 'acme.ohmypi.acp',
                providerId: 'acme.ohmypi',
            },
            runtimeAdapters: [
                expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            ],
        });
        expect(registry.runtimeAdaptersByBackendId.get('acme.ohmypi.acp')).toEqual([
            expect.objectContaining({
                backendId: 'acme.ohmypi.acp',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            }),
        ]);
        expect(registry.hookRegistrations).toEqual([
            expect.objectContaining({
                pluginId: 'acme.ohmypi',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.bindTranscript',
                }),
            }),
        ]);
        expect(registry.catalogEntriesById.codex?.id).toBe('codex');
        expect(registry.catalogEntriesById['acme.ohmypi']).toEqual(
            expect.objectContaining({
                id: 'acme.ohmypi',
                cliSubcommand: 'acme.ohmypi',
                vendorResumeSupport: 'unsupported',
            }),
        );
        expect(registry.pluginDiagnosticsByPluginId['acme.ohmypi']).toEqual([]);
    });

    it('records a diagnostic and excludes plugin backends whose provider does not resolve', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-invalid-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.invalid',
            displayName: 'Acme Invalid',
            description: 'Invalid backend provider reference',
            contributions: {
                providers: [],
                backends: [
                    {
                        kindVersion: 1,
                        id: 'acme.invalid.backend',
                        providerId: 'acme.missing.provider',
                        runtimeKind: 'acp',
                        capabilities: {},
                        runtimeAdapters: [],
                    },
                ],
                hooks: [],
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

        expect(registry.providerDefinitionsById.get('acme.invalid')).toBeUndefined();
        expect(registry.backendDefinitionsById.get('acme.invalid.backend')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.invalid']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });

    it('records a diagnostic and excludes plugin providers whose owned backend ids do not resolve', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-orphaned-provider-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.orphaned',
            displayName: 'Acme Orphaned',
            description: 'Provider points at a missing backend',
            contributions: {
                providers: [
                    {
                        kindVersion: 1,
                        id: 'acme.orphaned',
                        display: {
                            name: 'Acme Orphaned',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.orphaned.backend'],
                    },
                ],
                backends: [],
                hooks: [],
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

        expect(registry.providerDefinitionsById.get('acme.orphaned')).toBeUndefined();
        expect(registry.pluginDiagnosticsByPluginId['acme.orphaned']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
        ]);
    });

    it('records a diagnostic and excludes plugin hooks that target plugin exports without an exportName', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-merged-registry-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-hook-export-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePluginManifest(pluginRoot, {
            id: 'acme.hook-export-missing',
            displayName: 'Acme Hook Export Missing',
            description: 'Plugin hook omits exportName',
            contributions: {
                providers: [],
                backends: [],
                hooks: [
                    {
                        hookApiVersion: 1,
                        id: 'backend.terminalRuntime.bindTranscript',
                        category: 'integration',
                        scope: 'backend',
                        executionKind: 'integrate',
                        handler: {
                            target: 'plugin',
                        },
                    },
                ],
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
                    id: 'backend.terminalRuntime.bindTranscript',
                    handler: expect.objectContaining({
                        target: 'plugin',
                    }),
                }),
            }),
        ]);
        expect(registry.pluginDiagnosticsByPluginId['acme.hook-export-missing']).toEqual([]);
    });
});
