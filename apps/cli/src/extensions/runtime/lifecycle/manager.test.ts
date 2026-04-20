import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedBackendContribution, ResolvedContributionRegistry, ResolvedProviderContribution } from '@/extensions/registry/types';
import type { PluginExtensionApi } from '@/extensions/runtime/api/types';

import { activatePluginRuntimeRegistry } from './manager';

async function writeActivationModule(): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
    disposeMarkerPath: string;
    lifecycleMarkerPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-'));
    const manifestPath = await writeManifest(root, {
        id: 'acme.activated',
        runtimeCapabilities: ['actions', 'tools', 'commands', 'hooks', 'backends', 'lifecycle'],
        permissions: ['actions.register', 'tools.register', 'commands.register', 'hooks.register'],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    const disposeMarkerPath = join(root, 'dispose.log');
    const lifecycleMarkerPath = join(root, 'lifecycle.log');
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            '  api.registerAction({',
            '    id: "acme.activated.action",',
            '    title: "Activated Action",',
            '    description: "Action from activation",',
            '    surface: "cli",',
            '    handler: async () => "activated-action-result",',
            '  });',
            '  api.registerTool({',
            '    id: "acme.activated.tool",',
            '    name: "acme_activated_tool",',
            '    title: "Activated Tool",',
            '    description: "Tool from activation",',
            '    surfaces: { cli: true, mcp: true, session_agent: false },',
            '    handler: async () => "activated-tool-result",',
            '  });',
            '  api.registerCommand({',
            '    id: "acme.activated.command",',
            '    command: "activated-review",',
            '    rootHelpLabel: "happier activated-review",',
            '    rootHelpDescription: "Run activated review",',
            '    allowTmux: false,',
            '    handler: async (request) => ({ argv: request.input?.argv ?? [] }),',
            '  });',
            '  api.registerHook({',
            '    hookId: "session.started",',
            '    priority: 25,',
            '    handler: async () => "activated-hook",',
            '  });',
            '  api.registerLifecycleHandler({',
            '    event: "activated",',
            '    handler: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER, "activated\\n", "utf8");',
            '    },',
            '  });',
            '  api.registerLifecycleHandler({',
            '    event: "deactivating",',
            '    handler: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER, "deactivating\\n", "utf8");',
            '    },',
            '  });',
            '  api.registerRuntimeAdapter({',
            '    backendId: "acme.activated.backend",',
            '    kind: "terminalRuntime",',
            '    operation: "launch",',
            '    handler: async () => "activated-launch",',
            '  });',
            '  return {',
            '    dispose: async () => {',
            '      const { appendFile } = await import("node:fs/promises");',
            '      await appendFile(process.env.HAPPIER_PLUGIN_DISPOSE_MARKER, "disposed\\n", "utf8");',
            '    },',
            '  };',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    return { manifestPath, daemonEntryPath, disposeMarkerPath, lifecycleMarkerPath };
}

async function writeActivationModuleWithBackendEngine(params: Readonly<{
    pluginId: string;
    backendId: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-backend-engine-'));
    const manifestPath = await writeManifest(root, {
        id: params.pluginId,
        runtimeCapabilities: ['backends'],
        permissions: [],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate(api) {',
            `  api.registerBackendEngine({ backendId: ${JSON.stringify(params.backendId)}, create: async () => ({}) });`,
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    return { manifestPath, daemonEntryPath };
}

async function writeManifest(
    root: string,
    params: Readonly<{
        id: string;
        runtimeCapabilities: readonly string[];
        permissions: readonly string[];
    }>,
): Promise<string> {
    const manifestPath = join(root, '.happier-plugin', 'plugin.json');
    await mkdir(join(root, '.happier-plugin'), { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify({
            schemaVersion: 2,
            id: params.id,
            version: '1.0.0',
            displayName: params.id,
            description: `${params.id} test manifest`,
            engines: {
                happier: '^0.2.0',
            },
            runtime: {
                apiVersion: 1,
                capabilities: params.runtimeCapabilities,
            },
            permissions: params.permissions.map((capability) => ({ capability })),
            targets: {
                daemon: {
                    entry: './daemon.mjs',
                },
            },
            contributions: [],
        }),
        'utf8',
    );
    return manifestPath;
}

function createContributions(params: Readonly<{
    pluginId?: string;
    manifestPath: string;
    daemonEntryPath: string;
    trustPolicy?: 'local_trusted' | 'prompt' | 'untrusted';
}>): ResolvedContributionRegistry {
    const pluginId = params.pluginId ?? 'acme.activated';
    const provider: ResolvedProviderContribution = {
        id: pluginId,
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: 'digest-activation',
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: {
            kind: 'path',
            locator: join(params.manifestPath, '..', '..'),
            trustPolicy: params.trustPolicy ?? 'local_trusted',
            installPolicy: 'link',
        },
        definition: {
            kindVersion: 1,
            id: pluginId,
            ownedBackendIds: [`${pluginId}.backend`],
        },
    };
    const backend: ResolvedBackendContribution = {
        id: `${pluginId}.backend`,
        providerId: pluginId,
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        manifestPath: params.manifestPath,
        manifestDigest: 'digest-activation',
        daemonEntryPath: params.daemonEntryPath,
        sourceSpec: provider.sourceSpec,
        definition: {
            kindVersion: 1,
            id: `${pluginId}.backend`,
            providerId: pluginId,
        },
    };

    return {
        providers: [provider],
        backends: [backend],
        actions: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        runtimeAdaptersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        providerDefinitionsById: new Map([[provider.id, provider]]),
        backendDefinitionsById: new Map([[backend.id, backend]]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

describe('activatePluginRuntimeRegistry', () => {
    it('activates trusted plugin modules, records API handlers, and disposes once', async () => {
        const { manifestPath, daemonEntryPath, disposeMarkerPath, lifecycleMarkerPath } = await writeActivationModule();
        await mkdir(join(daemonEntryPath, '..'), { recursive: true });
        process.env.HAPPIER_PLUGIN_DISPOSE_MARKER = disposeMarkerPath;
        process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER = lifecycleMarkerPath;

        const activated = await activatePluginRuntimeRegistry({
            contributions: createContributions({
                manifestPath,
                daemonEntryPath,
            }),
            generation: 7,
        });
        const activatedWithFamilies = activated as typeof activated & Readonly<Record<string, unknown>>;

        expect(activated.generation).toBe(7);
        expect(activated.pluginDiagnosticsByPluginId['acme.activated']).toEqual([]);
        expect(activated.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.action',
                    title: 'Activated Action',
                    safety: 'safe',
                    surfaces: expect.objectContaining({
                        cli: true,
                    }),
                }),
            }),
        ]));
        expect(activatedWithFamilies.tools).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.tool',
                    name: 'acme_activated_tool',
                }),
            }),
        ]);
        expect(activatedWithFamilies.commands).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.command',
                    command: 'activated-review',
                }),
            }),
        ]);
        const hookHandlers = activated.hookHandlersByHookId.get('session.started');
        expect(hookHandlers).toHaveLength(1);
        await expect(hookHandlers?.[0]?.handler({})).resolves.toBe('activated-hook');
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\n');

        const adapterHandlers = activated.runtimeAdapterHandlersByBackendId.get('acme.activated.backend');
        expect(adapterHandlers?.get('terminalRuntime:launch')).toEqual(expect.any(Function));
        await expect(adapterHandlers?.get('terminalRuntime:launch')?.({})).resolves.toBe('activated-launch');

        await activated.dispose();
        await activated.dispose();

        await expect(readFile(disposeMarkerPath, 'utf8')).resolves.toBe('disposed\n');
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\ndeactivating\n');
    });

    it('records trust diagnostics instead of collapsing prompt-trust activation failures into generic load errors', async () => {
        const { manifestPath, daemonEntryPath } = await writeActivationModule();

        const activated = await activatePluginRuntimeRegistry({
            contributions: createContributions({
                pluginId: 'acme.prompt',
                manifestPath,
                daemonEntryPath,
                trustPolicy: 'prompt',
            }),
            generation: 3,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.prompt']).toEqual([
            expect.objectContaining({
                code: 'plugin_trust_approval_required',
            }),
        ]);
        expect(activated.actions).toEqual([]);
    });

    it('fails closed when activation-time registrations exceed declared runtime capabilities or permissions', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-activation-policy-'));
        const manifestPath = await writeManifest(root, {
            id: 'acme.policy',
            runtimeCapabilities: ['resources', 'tools', 'uiDescriptors'],
            permissions: ['resources.register'],
        });
        const daemonEntryPath = join(root, 'daemon.mjs');

        await writeFile(
            daemonEntryPath,
            [
                'export async function activate(api) {',
                '  api.registerResource({',
                '    kindVersion: 1,',
                '    id: "acme.policy.prompt",',
                '    type: "prompt",',
                '    path: "resources/prompt.md",',
                '  });',
                '  api.registerTool({',
                '    id: "acme.policy.tool",',
                '    name: "acme_policy_tool",',
                '    title: "Policy Tool",',
                '    handler: async () => "tool",',
                '  });',
                '  api.registerUiDescriptor({',
                '    kindVersion: 1,',
                '    id: "acme.policy.settings",',
                '    surface: "settings",',
                '    title: "Policy Settings",',
                '    fields: [],',
                '  });',
                '}',
                '',
            ].join('\n'),
            'utf8',
        );

        const activated = await activatePluginRuntimeRegistry({
            contributions: createContributions({
                pluginId: 'acme.policy',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 5,
        });
        const activatedWithFamilies = activated as typeof activated & Readonly<Record<string, unknown>>;

        expect(activated.resources).toEqual([
            expect.objectContaining({
                pluginId: 'acme.policy',
                definition: expect.objectContaining({
                    id: 'acme.policy.prompt',
                }),
            }),
        ]);
        expect(activated.actions).toEqual([]);
        expect(activatedWithFamilies.tools).toEqual([]);
        expect(activated.uiDescriptors).toEqual([]);
        expect(activated.pluginDiagnosticsByPluginId['acme.policy']).toEqual([
            expect.objectContaining({
                code: 'plugin_permission_missing',
                message: expect.stringContaining('tools.register'),
            }),
            expect.objectContaining({
                code: 'plugin_permission_missing',
                message: expect.stringContaining('ui.descriptors'),
            }),
        ]);
    });

    it('supports bundled activation sources without requiring a file-backed daemon entry path', async () => {
        const { manifestPath: existingManifestPath, disposeMarkerPath, lifecycleMarkerPath } = await writeActivationModule();
        process.env.HAPPIER_PLUGIN_DISPOSE_MARKER = disposeMarkerPath;
        process.env.HAPPIER_PLUGIN_LIFECYCLE_MARKER = lifecycleMarkerPath;

        const activated = await activatePluginRuntimeRegistry({
            contributions: createContributions({
                // Bundled sources must not require a manifest file on disk.
                manifestPath: join(existingManifestPath, '..', 'missing-plugin.json'),
                // Intentionally points to a non-existent file. The activation source must be bundled.
                daemonEntryPath: join(join(existingManifestPath, '..'), 'missing-daemon.mjs'),
            }),
            generation: 1,
            resolveActivationSource(target) {
                if (target.pluginId !== 'acme.activated') {
                    return null;
                }
                return {
                    kind: 'bundled',
                    moduleId: '@happier-dev/extensions-acme.activated/daemon',
                    load: async () => {
                        return {
                            EXTENSION_MANIFEST: {
                                schemaVersion: 2,
                                id: 'acme.activated',
                                version: '0.0.0',
                                displayName: 'acme.activated',
                                engines: { happier: '^0.0.0' },
                                runtime: { apiVersion: 1, capabilities: ['actions'] },
                                targets: {},
                                permissions: [{ capability: 'actions.register' }],
                                contributions: [],
                            },
                            activate: async (api: PluginExtensionApi) => {
                                api.registerAction({
                                    id: 'acme.activated.action',
                                    title: 'Activated Action',
                                    description: 'Action from bundled activation',
                                    surface: 'cli',
                                    handler: async () => 'activated-action-result',
                                });
                                return {
                                    dispose: async () => {
                                        const { appendFile } = await import('node:fs/promises');
                                        await appendFile(
                                            process.env.HAPPIER_PLUGIN_DISPOSE_MARKER!,
                                            'disposed\n',
                                            'utf8',
                                        );
                                    },
                                };
                            },
                        };
                    },
                };
            },
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.activated']).toEqual([]);
        expect(activated.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: 'acme.activated',
                definition: expect.objectContaining({
                    id: 'acme.activated.action',
                }),
            }),
        ]));
        await activated.dispose();
        const disposeMarker = await readFile(disposeMarkerPath, 'utf8');
        expect(disposeMarker.trim()).toBe('disposed');
    });

    it('records a diagnostic when multiple plugins register backend engines with the same backendId and keeps the first registration', async () => {
        const backendId = 'acme.shared.backend';
        const first = await writeActivationModuleWithBackendEngine({
            pluginId: 'acme.dupe.a',
            backendId,
        });
        const second = await writeActivationModuleWithBackendEngine({
            pluginId: 'acme.dupe.b',
            backendId,
        });

        const contributions: ResolvedContributionRegistry = {
            ...createContributions({
                pluginId: 'acme.dupe.a',
                manifestPath: first.manifestPath,
                daemonEntryPath: first.daemonEntryPath,
            }),
            providers: [
                ...createContributions({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providers,
                ...createContributions({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providers,
            ],
            backends: [
                ...createContributions({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backends,
                ...createContributions({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backends,
            ],
            providerDefinitionsById: new Map([
                ...createContributions({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providerDefinitionsById.entries(),
                ...createContributions({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providerDefinitionsById.entries(),
            ]),
            backendDefinitionsById: new Map([
                ...createContributions({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backendDefinitionsById.entries(),
                ...createContributions({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backendDefinitionsById.entries(),
            ]),
        };

        const activated = await activatePluginRuntimeRegistry({
            contributions,
            generation: 1,
        });

        expect(activated.backendEnginesByBackendId.get(backendId)?.pluginId).toBe('acme.dupe.a');
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.a'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_backend_engine_duplicate_backend_id',
            }),
        ]));
        expect(activated.pluginDiagnosticsByPluginId['acme.dupe.b'] ?? []).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'plugin_backend_engine_duplicate_backend_id',
            }),
        ]));
    });
});
