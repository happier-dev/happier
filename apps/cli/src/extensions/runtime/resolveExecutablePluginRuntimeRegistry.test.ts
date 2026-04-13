import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/plugins/store/pluginStateStore';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

async function writePlugin(
    rootDir: string,
    manifest: Record<string, unknown>,
    daemonSource: string,
    daemonBasename = 'daemon.mjs',
): Promise<void> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(rootDir, daemonBasename), daemonSource, 'utf8');
    await writeFile(
        join(manifestDir, 'plugin.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                id: 'acme.runtime',
                version: '1.0.0',
                displayName: 'Acme Runtime',
                description: 'Runtime hook plugin',
                engines: {
                    happier: '^0.2.0',
                },
                targets: {
                    daemon: {
                        entry: `./${daemonBasename}`,
                    },
                },
                contributions: {
                    providers: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime',
                            display: {
                                name: 'Acme Runtime',
                                tags: ['plugin'],
                            },
                            ownedBackendIds: ['acme.runtime.backend'],
                        },
                    ],
                    backends: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime.backend',
                            providerId: 'acme.runtime',
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
                            },
                        },
                    ],
                },
                ...manifest,
            },
            null,
            2,
        ),
        'utf8',
    );
}

describe('resolveExecutablePluginRuntimeRegistry', () => {
    it('loads merged plugin hook handlers from the executable runtime registry using the default export fallback', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin(
            pluginRoot,
            {},
            'export default async function bindTranscript() { return "runtime-bound"; }\n',
        );

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

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(typeof runtimeRegistry.readHookEventEnvelopeV1).toBe('function');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 1,
            hookEventId: 'session.started',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })?.eventId).toBe('session.started');
        expect(runtimeRegistry.readHookEventEnvelopeV1({
            hookVersion: 2,
            eventId: 'session.started',
            category: 'lifecycle',
            scope: 'session',
            timestampMs: 1,
            payload: {},
        })).toBe(null);

        expect(runtimeRegistry.contributions.runtimeAdaptersByBackendId.get('acme.runtime.backend')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime.backend',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            }),
        ]);
        expect(runtimeRegistry.contributions.hookRegistrations).toHaveLength(1);
        const handlers = runtimeRegistry.hookHandlersByHookId.get('backend.terminalRuntime.bindTranscript');
        expect(handlers).toHaveLength(1);
        await expect(handlers?.[0]?.handler()).resolves.toBe('runtime-bound');
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime']).toEqual([]);
    });

    it('merges contribution diagnostics with runtime hook resolution diagnostics', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-root-'));
        const store = createPluginStateStore({ happyHomeDir });

        await writePlugin(
            pluginRoot,
            {
                id: 'acme.runtime.invalid',
                displayName: 'Acme Runtime Invalid',
                description: 'Invalid runtime hook plugin',
                contributions: {
                    providers: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime.invalid',
                            display: {
                                name: 'Acme Runtime Invalid',
                                tags: ['plugin'],
                            },
                            ownedBackendIds: ['acme.runtime.invalid.backend'],
                            catalogEntry: 'not-an-object',
                        },
                    ],
                    backends: [
                        {
                            kindVersion: 1,
                            id: 'acme.runtime.invalid.backend',
                            providerId: 'acme.runtime.invalid',
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
            },
            'export const otherHandler = async () => "nope";\n',
        );

        await store.write({
            t: 'happier_plugin_state_v1',
            schemaVersion: 1,
            plugins: {
                'acme.runtime.invalid': {
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

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });

        expect(runtimeRegistry.contributions.runtimeAdaptersByBackendId.get('acme.runtime.invalid.backend')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime.invalid.backend',
            }),
        ]);
        expect(runtimeRegistry.contributions.hookRegistrations).toHaveLength(1);
        expect(runtimeRegistry.hookHandlersByHookId.get('backend.terminalRuntime.bindTranscript')).toBeUndefined();
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['acme.runtime.invalid']).toEqual([
            expect.objectContaining({
                code: 'plugin_manifest_semantic_invalid',
            }),
            expect.objectContaining({
                code: 'plugin_hook_handler_missing',
            }),
        ]);
    });
});
