import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { writePluginReloadStateSnapshot } from '@/plugins/runtime/reload/state';
import { createPluginStateStore } from '@/plugins/store/state';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';

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
                schemaVersion: 2,
                id: 'acme.runtime',
                version: '1.0.0',
                displayName: 'Acme Runtime',
                description: 'Runtime hook plugin',
                engines: {
                    happier: '^0.2.0',
                },
                runtime: {
                    apiVersion: 1,
                    capabilities: ['agents', 'backends', 'hooks'],
                },
                targets: {
                    daemon: {
                        entry: `./${daemonBasename}`,
                    },
                },
                capabilities: { permissions: [] },
                contributes: {
                    agents: [{
                        kindVersion: 1,
                        id: 'acme.runtime',
                        catalogAgentId: 'claude',
                        display: {
                            name: 'Acme Runtime',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime.backend'],
                    }],
                    backends: [{
                        kindVersion: 1,
                        id: 'acme.runtime.backend',
                        agentId: 'acme.runtime',
                        engine: {
                            kind: 'custom',
                        },
                        capabilities: {},
                        runtimeCoreHooks: [
                            {
                                runtimeCoreHookApiVersion: 1,
                                id: 'backend.terminalRuntime.launch',
                                kind: 'terminalRuntime',
                                operation: 'launch',
                                handler: {
                                    target: 'daemon',
                                    exportName: 'launch',
                                },
                            },
                        ],
                    }],
                    hooks: [{
                        hookApiVersion: 1,
                        id: 'backend.terminalRuntime.bindTranscript',
                        category: 'integration',
                        scope: 'backend',
                        executionKind: 'integrate',
                        handler: {
                            target: 'plugin',
                        },
                    }],
                },
                ...manifest,
            },
            null,
            2,
        ),
        'utf8',
    );
}

async function writeActivationManifest(
    rootDir: string,
    params: Readonly<{
        id: string;
        runtimeCapabilities: readonly string[];
        permissions: readonly string[];
        contributes?: Record<string, unknown>;
    }>,
): Promise<string> {
    const manifestDir = join(rootDir, '.happier-plugin');
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = join(manifestDir, 'plugin.json');
    await writeFile(
        manifestPath,
        JSON.stringify({
            schemaVersion: 2,
            id: params.id,
            version: '1.0.0',
            displayName: params.id,
            description: `${params.id} activation manifest`,
            engines: {
                happier: '^0.2.0',
            },
            runtime: {
                apiVersion: 1,
                capabilities: params.runtimeCapabilities,
            },
            capabilities: {
                permissions: params.permissions.map((capability) => ({ capability })),
            },
            targets: {
                daemon: {
                    entry: './daemon.mjs',
                },
            },
            contributes: params.contributes ?? {},
        }),
        'utf8',
    );
    return manifestPath;
}

describe('resolveExecutablePluginRuntimeRegistry', () => {
    it('activates the bundled opencode plugin by default and exposes a backend engine registration', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            contributes,
        });

        const engine = runtimeRegistry.backendEnginesByBackendId.get('opencode');
        expect(engine?.pluginId).toBe('opencode');
        expect(engine?.registration.backendId).toBe('opencode');
    });

    it('merges activation-time executable actions, resources, UI descriptors, and execution-run profiles into the authoritative contribution snapshot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-activated-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.activated',
            runtimeCapabilities: ['actions', 'resources', 'uiDescriptors', 'executionRunProfiles', 'hooks'],
            permissions: ['actions.register', 'resources.register', 'ui.descriptors', 'hooks.register'],
            contributes: {
                executionRunProfiles: [
                    {
                        id: 'acme.activated.review-profile',
                        kind: 'executionRun.profile',
                        version: '1.0.0',
                        intent: 'review',
                        displayKey: 'acme.activated.reviewProfile',
                        capabilityGates: [],
                        permissionGates: [],
                        redaction: 'none',
                        hidden: false,
                        actionIds: ['acme.activated.action'],
                    },
                ],
            },
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerAction({',
                '    id: "acme.activated.action",',
                '    title: "Activated Action",',
                '    description: "Runtime action surface",',
                '    surface: "cli",',
                '    handler: async () => "activated-action",',
                '  });',
                '  api.registerResource({',
                '    kindVersion: 1,',
                '    id: "acme.activated.prompt",',
                '    type: "prompt",',
                '    title: "Activated Prompt",',
                '    path: "resources/prompt.md",',
                '    digest: "sha256:prompt",',
                '    contentType: "text/markdown",',
                '  });',
                '  api.registerUiDescriptor({',
                '    kindVersion: 1,',
                '    id: "acme.activated.settings",',
                '    surface: "settings",',
                '    title: "Activated Settings",',
                '    description: "Runtime settings surface",',
                '    fields: [',
                '      {',
                '        id: "enabled",',
                '        kind: "boolean",',
                '        title: "Enabled",',
                '      },',
                '    ],',
                '  });',
                '  api.registerExecutionRunProfile({',
                '    id: "acme.activated.review-profile",',
                '    kind: "executionRun.profile",',
                '    version: "1.0.0",',
                '    intent: "review",',
                '    displayKey: "acme.activated.reviewProfile",',
                '    capabilityGates: [],',
                '    permissionGates: [],',
                '    redaction: "none",',
                '    hidden: false,',
                '    actionIds: ["acme.activated.action"],',
                '  });',
                '  api.registerHook({',
                '    hookId: "session.started",',
                '    handler: async () => "activated-hook",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.activated',
                    manifestPath,
                    manifestDigest: 'sha256:activated',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        expect(runtimeRegistry.contributes.actionsById?.get('acme.activated.action')).toMatchObject({
            pluginId: 'acme.activated',
            definition: {
                id: 'acme.activated.action',
                title: 'Activated Action',
                description: 'Runtime action surface',
                safety: 'safe',
                surfaces: expect.objectContaining({
                    cli: true,
                }),
            },
        });
        await expect(runtimeRegistry.actionHandlersByActionId.get('acme.activated.action')?.({
            actionId: 'acme.activated.action',
            pluginId: 'acme.activated',
            input: { scope: 'runtime' },
            context: {
                surface: 'cli',
            },
            provenance: {},
        })).resolves.toBe('activated-action');
        expect(runtimeRegistry.contributes.resourcesById?.get('acme.activated.prompt')).toMatchObject({
            pluginId: 'acme.activated',
            definition: {
                id: 'acme.activated.prompt',
                path: 'resources/prompt.md',
            },
        });
        expect(runtimeRegistry.contributes.uiDescriptorsById?.get('acme.activated.settings')).toMatchObject({
            pluginId: 'acme.activated',
            definition: {
                id: 'acme.activated.settings',
                surface: 'settings',
            },
        });
        expect(runtimeRegistry.contributes.executionRunProfilesById?.get('acme.activated.review-profile')).toMatchObject({
            pluginId: 'acme.activated',
            definition: {
                id: 'acme.activated.review-profile',
                kind: 'executionRun.profile',
                intent: 'review',
                actionIds: ['acme.activated.action'],
            },
        });
        await expect(runtimeRegistry.hookHandlersByHookId.get('session.started')?.[0]?.handler()).resolves.toBe('activated-hook');
    });

    it('loads the ui-descriptor authoring example through the activation-time runtime contract', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-authoring-home-'));
        const pluginRoot = fileURLToPath(new URL('../testkit/fixtures/authoring-examples/ui-descriptor-plugin/', import.meta.url));
        const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                providers: [],
                backends: [],
                actions: [],
                resources: [],
                uiDescriptors: [],
                activationTargets: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'examples.ui-descriptor-plugin',
                        manifestPath,
                        manifestDigest: 'sha256:ui-descriptor-example',
                        daemonEntryPath,
                        sourceSpec: {
                            kind: 'path',
                            locator: pluginRoot,
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                    },
                ],
            }),
        });

        expect(runtimeRegistry.contributes.resourcesById?.get('examples.ui.prompt')).toMatchObject({
            pluginId: 'examples.ui-descriptor-plugin',
            definition: {
                id: 'examples.ui.prompt',
                path: 'resources/review-prompt.md',
            },
        });
        expect(runtimeRegistry.contributes.uiDescriptorsById?.get('examples.ui.settings')).toMatchObject({
            pluginId: 'examples.ui-descriptor-plugin',
            definition: {
                id: 'examples.ui.settings',
                surface: 'settings',
            },
        });
        expect(runtimeRegistry.pluginDiagnosticsByPluginId['examples.ui-descriptor-plugin'] ?? []).toEqual([]);

        await runtimeRegistry.dispose();
    });

    it('normalizes activation-time tools and commands through the authoritative runtime contribution snapshot', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-command-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.activated',
            runtimeCapabilities: ['tools', 'commands'],
            permissions: ['tools.register', 'commands.register'],
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerTool({',
                '    id: "acme.activated.tool",',
                '    name: "acme_activated_tool",',
                '    title: "Activated Tool",',
                '    description: "Runtime tool surface",',
                '    surfaces: { cli: true, mcp: true, session_agent: true },',
                '    handler: async () => "activated-tool",',
                '  });',
                '  api.registerCommand({',
                '    id: "acme.activated.command",',
                '    command: "activated-review",',
                '    rootHelpLabel: "happier activated-review",',
                '    rootHelpDescription: "Run activated review",',
                '    allowTmux: false,',
                '    handler: async (request) => ({ argv: request.input?.argv ?? [] }),',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.activated',
                    manifestPath,
                    manifestDigest: 'sha256:activated',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        const projected = runtimeRegistry.contributes as typeof runtimeRegistry.contributes & Readonly<Record<string, unknown>>;

        expect(listBuiltInHappierTools({
            surface: 'cli',
            registry: runtimeRegistry.contributes,
        }).map((tool) => tool.name)).toContain('acme_activated_tool');
        expect(runtimeRegistry.contributes.actionsById?.get('acme.activated.tool')).toMatchObject({
            pluginId: 'acme.activated',
            definition: expect.objectContaining({
                id: 'acme.activated.tool',
                bindings: expect.objectContaining({
                    mcpToolName: 'acme_activated_tool',
                }),
            }),
        });
        expect(projected.commandsById).toBeInstanceOf(Map);
        expect((projected.commandsById as Map<string, unknown>).get('acme.activated.command')).toMatchObject({
            pluginId: 'acme.activated',
            definition: expect.objectContaining({
                id: 'acme.activated.command',
                command: 'activated-review',
            }),
        });
    });

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

        expect(runtimeRegistry.contributes.runtimeCoreHooksByBackendId.get('acme.runtime.backend')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime.backend',
                definition: expect.objectContaining({
                    id: 'backend.terminalRuntime.launch',
                    kind: 'terminalRuntime',
                }),
            }),
        ]);
        expect(runtimeRegistry.contributes.hookRegistrations).toHaveLength(1);
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
                contributes: {
                    agents: [{
                        kindVersion: 1,
                        id: 'acme.runtime.invalid',
                        catalogAgentId: 'claude',
                        display: {
                            name: 'Acme Runtime Invalid',
                            tags: ['plugin'],
                        },
                        ownedBackendIds: ['acme.runtime.invalid.backend'],
                        iconAgentId: 'not-a-built-in-agent',
                    }],
                    backends: [{
                        kindVersion: 1,
                        id: 'acme.runtime.invalid.backend',
                        agentId: 'acme.runtime.invalid',
                        engine: {
                            kind: 'custom',
                        },
                        capabilities: {},
                        runtimeCoreHooks: [
                            {
                                runtimeCoreHookApiVersion: 1,
                                id: 'backend.terminalRuntime.launch',
                                kind: 'terminalRuntime',
                                operation: 'launch',
                                handler: {
                                    target: 'daemon',
                                    exportName: 'launch',
                                },
                            },
                        ],
                    }],
                    hooks: [{
                        hookApiVersion: 1,
                        id: 'backend.terminalRuntime.bindTranscript',
                        category: 'integration',
                        scope: 'backend',
                        executionKind: 'integrate',
                        handler: {
                            target: 'plugin',
                            exportName: 'bindTranscript',
                        },
                    }],
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

        expect(runtimeRegistry.contributes.runtimeCoreHooksByBackendId.get('acme.runtime.invalid.backend')).toEqual([
            expect.objectContaining({
                backendId: 'acme.runtime.invalid.backend',
            }),
        ]);
        expect(runtimeRegistry.contributes.hookRegistrations).toHaveLength(1);
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

    it('reuses caller-provided contribution ingress when resolving executable runtime hooks', async () => {
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

        const initial = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
        const reused = await resolveExecutablePluginRuntimeRegistry({
            contributes: initial.contributes,
        });

        expect(reused.contributes).toBe(initial.contributes);
        expect(reused.hookHandlersByHookId.get('backend.terminalRuntime.bindTranscript')).toHaveLength(1);
    });

    it('uses the persisted reload generation to invalidate daemon module caches between runtime resolutions', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-runtime-generation-root-'));
        const daemonEntryPath = join(pluginRoot, 'daemon.mjs');
        const manifestPath = await writeActivationManifest(pluginRoot, {
            id: 'acme.generation',
            runtimeCapabilities: ['hooks'],
            permissions: ['hooks.register'],
        });

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerHook({',
                '    hookId: "session.started",',
                '    handler: async () => "generation-one",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const contributes = createResolvedContributionRegistry({
            providers: [],
            backends: [],
            activationTargets: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.generation',
                    manifestPath,
                    manifestDigest: 'sha256:generation',
                    daemonEntryPath,
                    sourceSpec: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                },
            ],
        });

        const first = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });
        await expect(first.hookHandlersByHookId.get('session.started')?.[0]?.handler()).resolves.toBe('generation-one');

        await writePluginReloadStateSnapshot(happyHomeDir, {
            t: 'happier_plugin_reload_state_v1',
            schemaVersion: 1,
            generation: 1,
            activeGenerationId: 'reload:1',
            changedPluginIds: ['acme.generation'],
            updatedAt: Date.now(),
        });
        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerHook({',
                '    hookId: "session.started",',
                '    handler: async () => "generation-two",',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const second = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes,
        });

        await expect(second.hookHandlersByHookId.get('session.started')?.[0]?.handler()).resolves.toBe('generation-two');
    });
});
