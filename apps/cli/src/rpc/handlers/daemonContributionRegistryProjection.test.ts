import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionInputs } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

function createRegistrar() {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method: string, handler: (payload: unknown) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

describe('daemon contribution registry projection rpc handler', () => {
    it('projects the authoritative executable runtime snapshot instead of the manifest-only registry snapshot', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const manifestOnlyRegistry = createResolvedContributionRegistry({
            providers: [
                {
                    id: 'manifest.only',
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'manifest.only',
                    manifestPath: '/plugins/manifest.only/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/manifest.only/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/plugins/manifest.only',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'manifest.only',
                        ownedBackendIds: [],
                    },
                },
            ],
            backends: [],
        });
        const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
            contributes: createResolvedContributionRegistry({
                providers: [
                    {
                        id: 'runtime.provider',
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.provider',
                            ownedBackendIds: ['runtime.backend'],
                        },
                        richDefinition: {
                            provenance: 'external',
                            definition: {
                                kindVersion: 1,
                                id: 'runtime.provider',
                                ownedBackendIds: ['runtime.backend'],
                                display: {
                                    name: 'Runtime Provider',
                                    subtitle: 'Activated contribution',
                                    tags: ['plugin'],
                                },
                            },
                        },
                    },
                ],
                backends: [
                    {
                        id: 'runtime.backend',
                        providerId: 'runtime.provider',
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.backend',
                            providerId: 'runtime.provider',
                        },
                        richDefinition: {
                            provenance: 'external',
                            definition: {
                                kindVersion: 1,
                                id: 'runtime.backend',
                                providerId: 'runtime.provider',
                                runtimeKind: 'native',
                                capabilities: normalizePluginBackendCapabilitiesV1({ executionRun: { supported: true } }),
                                surfaceHandlers: [],
                                title: 'Runtime Backend',
                            },
                        },
                        runtimeKind: 'native',
                        capabilities: normalizePluginBackendCapabilitiesV1({ executionRun: { supported: true } }),
                        surfaceHandlers: [],
                    },
                ],
                resources: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.prompt',
                            type: 'prompt',
                            title: 'Runtime Prompt',
                            path: 'resources/runtime.md',
                            digest: 'sha256:prompt',
                            contentType: 'text/markdown',
                        },
                    },
                ],
                tools: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.tool.search',
                            name: 'runtime_search',
                            title: 'Runtime Search',
                            description: 'Search runtime resources',
                            safety: 'safe',
                            surfaces: {
                                cli: false,
                                mcp: true,
                                session_agent: true,
                            },
                            actionId: 'runtime.tool.search',
                        },
                    },
                ],
                commands: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.command.reload',
                            command: 'runtime-reload',
                            rootHelpLabel: 'Reload Runtime Plugin',
                            rootHelpDescription: 'Reload the runtime plugin',
                            allowTmux: true,
                            actionId: 'runtime.command.reload',
                        },
                    },
                ],
                uiDescriptors: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            kindVersion: 1,
                            id: 'runtime.settings',
                            surface: 'settings',
                            title: 'Runtime Settings',
                            description: 'Activated settings surface',
                            fields: [],
                        },
                    },
                ],
                hookRegistrations: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'runtime.plugin',
                        manifestPath: '/plugins/runtime/plugin.json',
                        manifestDigest: 'sha256:runtime',
                        daemonEntryPath: '/plugins/runtime/daemon.mjs',
                        sourceSpec: {
                            kind: 'path',
                            locator: '/plugins/runtime',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'link',
                        },
                        definition: {
                            hookApiVersion: 1,
                            id: 'runtime.hook.spawn',
                            eventId: 'daemon.spawn.before',
                            category: 'lifecycle',
                            scope: 'machine',
                            executionKind: 'decide',
                            aggregation: 'firstDecision',
                            failureMode: 'failClosed',
                            priority: 10,
                            handler: {
                                target: 'plugin',
                                exportName: 'beforeSpawn',
                            },
                        },
                    },
                ],
            }),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            backendEnginesByBackendId: new Map(),
            scmHostingProvidersById: new Map(),
            networkAllowedUrlOriginsByPluginId: new Map(),
            processSpawnAllowedPathsByPluginId: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({
                'runtime.plugin': Object.freeze([
                    {
                        code: 'plugin_activation_failed' as const,
                        message: 'Activation failed once before recovering',
                    },
                ]),
            }),
            addRuntimeDisposable: (_pluginId, disposable) => disposable,
            readHookEventEnvelopeV1,
            dispose: async () => {},
        };

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => manifestOnlyRegistry,
            resolveRuntimeRegistry: async () => runtimeRegistry,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        expect(raw).toEqual(expect.objectContaining({
            projection: expect.objectContaining({
                v: 2,
                generation: expect.any(Number),
                installedPackagesById: expect.objectContaining({
                    'runtime.plugin': expect.objectContaining({
                        id: 'runtime.plugin',
                        displayName: 'Runtime Provider',
                        enabled: true,
                        source: expect.objectContaining({
                            kind: 'path',
                            locator: '/plugins/runtime',
                        }),
                        digest: 'sha256:runtime',
                    }),
                }),
                providersById: expect.objectContaining({
                    'runtime.provider': expect.objectContaining({
                        title: 'Runtime Provider',
                    }),
                }),
                backendsById: expect.objectContaining({
                    'runtime.backend': expect.objectContaining({
                        providerId: 'runtime.provider',
                    }),
                }),
                resourcesById: expect.objectContaining({
                    'runtime.prompt': expect.objectContaining({
                        path: 'resources/runtime.md',
                    }),
                }),
                uiDescriptorsById: expect.objectContaining({
                    'runtime.settings': expect.objectContaining({
                        surface: 'settings',
                    }),
                }),
                toolsById: expect.objectContaining({
                    'runtime.tool.search': expect.objectContaining({
                        title: 'Runtime Search',
                        exposesToAgent: true,
                    }),
                }),
                commandsById: expect.objectContaining({
                    'runtime.command.reload': expect.objectContaining({
                        title: 'Reload Runtime Plugin',
                        tokens: ['runtime-reload'],
                    }),
                }),
                hooksById: expect.any(Object),
                diagnostics: expect.arrayContaining([
                    expect.objectContaining({
                        pluginId: 'runtime.plugin',
                        code: 'plugin_activation_failed',
                    }),
                ]),
            }),
        }));
        expect(
            Object.values((raw as { projection: { hooksById?: Record<string, unknown> } }).projection.hooksById ?? {}),
        ).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'runtime.plugin:runtime.hook.spawn:1',
                pluginId: 'runtime.plugin',
                eventId: 'daemon.spawn.before',
                aggregation: 'firstDecision',
                failureMode: 'failClosed',
            }),
        ]));
        expect((raw as { projection: { providersById: Record<string, unknown> } }).projection.providersById.manifest).toBeUndefined();
        expect((raw as { projection: { providersById: Record<string, unknown> } }).projection.providersById['manifest.only']).toBeUndefined();
    });

    it('returns a versioned projection that includes plugin provider display fields', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection');
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const { registerDaemonContributionRegistryProjectionHandler } = projectionModule;

        const inputs: ResolvedContributionInputs = {
            providers: [
                {
                    id: 'plugin-provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'plugin-provider',
                        ownedBackendIds: ['plugin-backend'],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            kindVersion: 1,
                            id: 'plugin-provider',
                            display: { name: 'Plugin Provider', subtitle: 'Plugin subtitle', tags: [] },
                            ownedBackendIds: ['plugin-backend'],
                        },
                    },
                },
            ],
            backends: [
                {
                    id: 'plugin-backend',
                    providerId: 'plugin-provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: { kindVersion: 1, id: 'plugin-backend', providerId: 'plugin-provider' },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            kindVersion: 1,
                            id: 'plugin-backend',
                            providerId: 'plugin-provider',
                            runtimeKind: 'x',
                            capabilities: normalizePluginBackendCapabilitiesV1({ executionRun: { supported: true } }),
                            surfaceHandlers: [],
                        },
                    },
                    runtimeKind: 'x',
                    capabilities: normalizePluginBackendCapabilitiesV1({ executionRun: { supported: true } }),
                    surfaceHandlers: [],
                },
            ],
            hookRegistrations: [],
        };

        const registry = createResolvedContributionRegistry(inputs);

        const { handlers, registrar } = createRegistrar();
        registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => registry,
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const raw = await handler!({ machineId: 'm1' });
        expect(raw).toEqual(expect.objectContaining({
            protocolVersion: 1,
            projection: expect.objectContaining({
                v: 2,
                providersById: expect.objectContaining({
                    'plugin-provider': expect.objectContaining({
                        id: 'plugin-provider',
                        title: 'Plugin Provider',
                        subtitle: 'Plugin subtitle',
                    }),
                }),
                backendsById: expect.objectContaining({
                    'plugin-backend': expect.objectContaining({
                        id: 'plugin-backend',
                        providerId: 'plugin-provider',
                    }),
                }),
            }),
        }));
    });

    it('exposes explicit cache invalidation for plugin reload', async () => {
        const projectionModule = await import('./daemonContributionRegistryProjection') as typeof import('./daemonContributionRegistryProjection') & {
            invalidateDaemonContributionRegistryProjectionCache?: () => void;
        };
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();
        const inputs: ResolvedContributionInputs = {
            providers: [],
            backends: [],
            hookRegistrations: [],
        };
        let suffix = 'one';
        const { handlers, registrar } = createRegistrar();

        projectionModule.registerDaemonContributionRegistryProjectionHandler(registrar as never, {
            resolveRegistry: async () => createResolvedContributionRegistry({
                ...inputs,
                providers: [
                    {
                        id: `plugin-provider-${suffix}`,
                        provenance: 'external',
                        source: { kind: 'path' },
                        definition: {
                            kindVersion: 1,
                            id: `plugin-provider-${suffix}`,
                            ownedBackendIds: [],
                        },
                    },
                ],
            }),
        });

        const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(handler).toBeDefined();

        const first = await handler!({ machineId: 'm1' });
        suffix = 'two';
        const stale = await handler!({ machineId: 'm1' });
        expect(stale).toBe(first);

        expect(projectionModule.invalidateDaemonContributionRegistryProjectionCache).toEqual(expect.any(Function));
        projectionModule.invalidateDaemonContributionRegistryProjectionCache?.();

        const refreshed = await handler!({ machineId: 'm1' });
        expect(refreshed).not.toBe(first);
        expect(refreshed).toEqual(expect.objectContaining({
            projection: expect.objectContaining({
                providersById: expect.objectContaining({
                    'plugin-provider-two': expect.objectContaining({
                        id: 'plugin-provider-two',
                    }),
                }),
            }),
        }));
    });
});
