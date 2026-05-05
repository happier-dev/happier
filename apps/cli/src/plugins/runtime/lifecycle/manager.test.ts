import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedBackendContribution, ResolvedContributionRegistry, ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { PluginApi } from '@/plugins/runtime/api/types';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

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
        runtimeCapabilities: ['actions', 'tools', 'commands', 'hooks', 'backends', 'lifecycle', 'notifications'],
        permissions: ['actions.register', 'tools.register', 'commands.register', 'hooks.register', 'notifications.register', 'network'],
        backendIds: ['acme.activated.backend'],
        notificationCategoryIds: ['acme.activated.notification'],
        notificationChannelIds: ['acme.activated.notification.memory'],
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
            '  api.registerBackendEngine({',
            '    backendId: "acme.activated.backend",',
            '    create: async () => ({',
            '      runtimeCore: {',
            '        createSessionRuntime: async () => null,',
            '        createExecutionRunBackend: () => ({ launch: async () => "activated-launch" }),',
            '      },',
            '    }),',
            '  });',
            '  api.registerNotificationCategory({',
            '    id: "acme.activated.notification",',
            '    kind: "activity",',
            '    title: "Activated notification",',
            '    eventIds: ["ready"],',
            '    defaultChannelIds: ["acme.activated.notification.memory"],',
            '  });',
            '  api.registerNotificationChannel({',
            '    id: "acme.activated.notification.memory",',
            '    kind: "plugin",',
            '    title: "Activated memory channel",',
            '    send: async () => ({ delivered: true }),',
            '  });',
            '  api.registerRequestInterceptor({',
            '    id: "acme.activated.fetch.audit",',
            '    priority: 10,',
            '    intercept: async (request, next) => next(request),',
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
        backendIds: [params.backendId],
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

async function writeActivationModuleWithAutoAcpBackend(params: Readonly<{
    pluginId: string;
    backendId: string;
}>): Promise<Readonly<{
    manifestPath: string;
    daemonEntryPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-auto-acp-'));
    const manifestPath = await writeManifest(root, {
        id: params.pluginId,
        runtimeCapabilities: ['backends'],
        permissions: [],
        backendIds: [params.backendId],
    });
    const daemonEntryPath = join(root, 'daemon.mjs');
    await mkdir(join(root, 'agent'), { recursive: true });
    await writeFile(
        daemonEntryPath,
        [
            'export async function activate() {',
            '}',
            '',
        ].join('\n'),
        'utf8',
    );
    await writeFile(
        join(root, 'agent', 'acp.js'),
        [
            'export const ACP_BACKEND_DEFINITION = {',
            `  backendId: ${JSON.stringify(params.backendId)},`,
            '  transport: {',
            '    kind: "stdio",',
            '    launch: { kind: "executable", command: "acme-agent", args: ["acp"] },',
            '  },',
            '  ux: { title: "Auto ACP Backend" },',
            '};',
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
        backendIds?: readonly string[];
        notificationCategoryIds?: readonly string[];
        notificationChannelIds?: readonly string[];
    }>,
): Promise<string> {
    const manifestPath = join(root, '.happier-plugin', 'plugin.json');
    await mkdir(join(root, '.happier-plugin'), { recursive: true });
    await writeFile(
        manifestPath,
        JSON.stringify(createPluginManifestV2Fixture({
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
            contributes: {
                backends: (params.backendIds ?? []).map((backendId) => ({
                    kindVersion: 1,
                    id: backendId,
                    agentId: params.id,
                    engine: { kind: 'custom' },
                    capabilities: {},
                })),
                notifications: (params.notificationCategoryIds ?? []).map((notificationId) => ({
                    id: notificationId,
                    kind: 'activity',
                    title: `${notificationId} test notification`,
                    eventIds: ['ready'],
                    defaultChannelIds: params.notificationChannelIds ?? [],
                })),
                notificationChannels: (params.notificationChannelIds ?? []).map((channelId) => ({
                    id: channelId,
                    kind: 'plugin',
                    title: `${channelId} test channel`,
                })),
            },
        })),
        'utf8',
    );
    return manifestPath;
}

function createContributes(params: Readonly<{
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
        runtimeCoreHooksByBackendId: new Map(),
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
            contributes: createContributes({
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

        expect(activated.runtimeCoreHandlersByBackendId.get('acme.activated.backend')).toBeUndefined();
        expect(activated.backendEnginesByBackendId.get('acme.activated.backend')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                backendId: 'acme.activated.backend',
                create: expect.any(Function),
            }),
        });
        expect(activated.notificationCategoriesById.get('acme.activated.notification')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                id: 'acme.activated.notification',
                kind: 'activity',
            }),
        });
        expect(activated.notificationChannelsById.get('acme.activated.notification.memory')).toMatchObject({
            pluginId: 'acme.activated',
            registration: expect.objectContaining({
                id: 'acme.activated.notification.memory',
                send: expect.any(Function),
            }),
        });
        expect(activated.requestInterceptors).toEqual([
            expect.objectContaining({
                pluginId: 'acme.activated',
                registration: expect.objectContaining({
                    id: 'acme.activated.fetch.audit',
                    priority: 10,
                    intercept: expect.any(Function),
                }),
            }),
        ]);
        expect(activated.networkAllowedPluginIds.has('acme.activated')).toBe(true);

        await activated.dispose();
        await activated.dispose();

        await expect(readFile(disposeMarkerPath, 'utf8')).resolves.toBe('disposed\n');
        await expect(readFile(lifecycleMarkerPath, 'utf8')).resolves.toBe('activated\ndeactivating\n');
    });

    it('records trust diagnostics instead of collapsing prompt-trust activation failures into generic load errors', async () => {
        const { manifestPath, daemonEntryPath } = await writeActivationModule();

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
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
            contributes: createContributes({
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
            contributes: createContributes({
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
                    moduleId: '@happier-dev/plugins-acme.activated/daemon',
                    load: async () => {
                        return {
                            PLUGIN_MANIFEST: createPluginManifestV2Fixture({
                                schemaVersion: 2,
                                id: 'acme.activated',
                                version: '0.0.0',
                                displayName: 'acme.activated',
                                engines: { happier: '^0.0.0' },
                                runtime: { apiVersion: 1, capabilities: ['actions'] },
                                targets: {},
                                permissions: [{ capability: 'actions.register' }],
                                contributes: [],
                            }),
                            activate: async (api: PluginApi) => {
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

        const contributes: ResolvedContributionRegistry = {
            ...createContributes({
                pluginId: 'acme.dupe.a',
                manifestPath: first.manifestPath,
                daemonEntryPath: first.daemonEntryPath,
            }),
            providers: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providers,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providers,
            ],
            backends: [
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backends,
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backends,
            ],
            providerDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).providerDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).providerDefinitionsById.entries(),
            ]),
            backendDefinitionsById: new Map([
                ...createContributes({
                    pluginId: 'acme.dupe.a',
                    manifestPath: first.manifestPath,
                    daemonEntryPath: first.daemonEntryPath,
                }).backendDefinitionsById.entries(),
                ...createContributes({
                    pluginId: 'acme.dupe.b',
                    manifestPath: second.manifestPath,
                    daemonEntryPath: second.daemonEntryPath,
                }).backendDefinitionsById.entries(),
            ]),
        };

        const activated = await activatePluginRuntimeRegistry({
            contributes,
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

    it('auto-registers agent/acp.js definitions during plugin activation', async () => {
        const { manifestPath, daemonEntryPath } = await writeActivationModuleWithAutoAcpBackend({
            pluginId: 'acme.auto.acp',
            backendId: 'acme.auto.backend',
        });

        const activated = await activatePluginRuntimeRegistry({
            contributes: createContributes({
                pluginId: 'acme.auto.acp',
                manifestPath,
                daemonEntryPath,
            }),
            generation: 9,
        });

        expect(activated.pluginDiagnosticsByPluginId['acme.auto.acp']).toEqual([]);
        expect(activated.backendEnginesByBackendId.get('acme.auto.backend')).toEqual(expect.objectContaining({
            pluginId: 'acme.auto.acp',
            registration: expect.objectContaining({
                backendId: 'acme.auto.backend',
                create: expect.any(Function),
            }),
        }));
    });
});
