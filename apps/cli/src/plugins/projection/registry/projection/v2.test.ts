import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from './v2';
import type { ResolvedContributionRegistry } from '../types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        providers: [],
        backends: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        lifecycleHandlers: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        uiDescriptorsById: new Map(),
        lifecycleHandlersById: new Map(),
        runtimeCoreHooksByBackendId: new Map(),
        catalogEntriesById: {},
        providerDefinitionsById: new Map(),
        backendDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

describe('buildPluginProjectionV2', () => {
    it('allows sibling-owned non-agent projection families without changing core projection dispatch', () => {
        type ProjectionFamilyResult = Readonly<{
            family: string;
            entriesById: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        }>;
        type ProjectionFamilyDescriptor = Readonly<{
            family: string;
            project: (context: Readonly<{
                registry: ResolvedContributionRegistry;
                generation: number;
            }>) => ProjectionFamilyResult;
        }>;
        type ProjectionWithFamilies = ReturnType<typeof buildPluginProjectionV2> & Readonly<{
            familiesById: Readonly<Record<string, ProjectionFamilyResult>>;
        }>;
        type BuildProjectionWithFamilies = (
            params: Parameters<typeof buildPluginProjectionV2>[0] & Readonly<{
                familyDescriptors: readonly ProjectionFamilyDescriptor[];
            }>
        ) => ProjectionWithFamilies;

        const projectWithFamilies = buildPluginProjectionV2 as BuildProjectionWithFamilies;
        const projection = projectWithFamilies({
            registry: createEmptyResolvedContributionRegistry(),
            generation: 5,
            familyDescriptors: [
                {
                    family: 'scmHostingProviders',
                    project: ({ generation }) => ({
                        family: 'scmHostingProviders',
                        entriesById: {
                            github: {
                                id: 'github',
                                pluginId: 'acme.scm',
                                generation,
                                hostPattern: 'github.com',
                            },
                        },
                    }),
                },
            ],
        });

        expect(projection.familiesById.scmHostingProviders?.entriesById.github).toEqual({
            id: 'github',
            pluginId: 'acme.scm',
            generation: 5,
            hostPattern: 'github.com',
        });
        expect(projection.providersById).toEqual({});
        expect(projection.backendsById).toEqual({});
    });

    it('projects backend execution-run capability metadata with default support', () => {
        const projection = buildPluginProjectionV2({
            registry: {
                ...createEmptyResolvedContributionRegistry(),
                providers: [
                    {
                        id: 'acme.provider',
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.provider',
                            ownedBackendIds: ['acme.backend'],
                        },
                    },
                ],
                backends: [
                    {
                        id: 'acme.backend',
                        providerId: 'acme.provider',
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.backend',
                            providerId: 'acme.provider',
                        },
                    },
                ],
            },
            generation: 1,
        });

        expect((projection.backendsById['acme.backend'] as Record<string, unknown> | undefined)?.capabilities).toEqual({
            executionRun: { supported: true },
        });
    });

    it('projects static MCP contribution families through the canonical projection family surface', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            mcpServers: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.mcp',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:mcp',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    definition: {
                        id: 'acme.server',
                        kind: 'mcp.server',
                        version: '1.0.0',
                        name: 'acme-hosted',
                        transport: 'hosted',
                    },
                },
            ],
            mcpTools: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.mcp',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:mcp',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    definition: {
                        id: 'acme.tool',
                        kind: 'mcp.tool',
                        version: '1.0.0',
                        name: 'ext.acme.mcp.search',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 6,
        });

        expect(projection.familiesById.mcp?.entriesById['server:acme.server']).toEqual({
            id: 'server:acme.server',
            pluginId: 'acme.mcp',
            contributionKind: 'server',
            name: 'acme-hosted',
            transport: 'hosted',
        });
        expect(projection.familiesById.mcp?.entriesById['tool:acme.tool']).toEqual({
            id: 'tool:acme.tool',
            pluginId: 'acme.mcp',
            contributionKind: 'tool',
            name: 'ext.acme.mcp.search',
        });
    });

    it('rejects static MCP tool namespace collisions across plugins', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            mcpTools: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'alpha.mcp',
                    manifestPath: '/tmp/alpha/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:alpha',
                    daemonEntryPath: '/tmp/alpha/daemon.mjs',
                    definition: {
                        id: 'alpha.tool',
                        kind: 'mcp.tool',
                        version: '1.0.0',
                        name: 'provider.shared.search',
                    },
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'beta.mcp',
                    manifestPath: '/tmp/beta/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:beta',
                    daemonEntryPath: '/tmp/beta/daemon.mjs',
                    definition: {
                        id: 'beta.tool',
                        kind: 'mcp.tool',
                        version: '1.0.0',
                        name: 'provider.shared.lookup',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({
            registry,
            generation: 7,
        })).toThrow(/MCP tool namespace collision/);
    });

    it('rejects backend-client namespace collisions with static MCP tool namespaces', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            mcpBackendClients: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'alpha.mcp',
                    manifestPath: '/tmp/alpha/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:alpha',
                    daemonEntryPath: '/tmp/alpha/daemon.mjs',
                    definition: {
                        id: 'alpha.client',
                        kind: 'mcp.backendClient',
                        version: '1.0.0',
                        serverName: 'alpha-hosted',
                        toolNamespace: 'provider.shared',
                    },
                },
            ],
            mcpTools: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'beta.mcp',
                    manifestPath: '/tmp/beta/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:beta',
                    daemonEntryPath: '/tmp/beta/daemon.mjs',
                    definition: {
                        id: 'beta.tool',
                        kind: 'mcp.tool',
                        version: '1.0.0',
                        name: 'provider.shared.lookup',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({
            registry,
            generation: 8,
        })).toThrow(/MCP tool namespace collision/);
    });

    it('fails closed for MCP namespace claims without plugin ownership', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            mcpBackendClients: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    manifestPath: '/tmp/alpha/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:alpha',
                    daemonEntryPath: '/tmp/alpha/daemon.mjs',
                    definition: {
                        id: 'alpha.client',
                        kind: 'mcp.backendClient',
                        version: '1.0.0',
                        serverName: 'alpha-hosted',
                        toolNamespace: 'provider.shared',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({
            registry,
            generation: 9,
        })).toThrow(/MCP backend-client namespace claim requires plugin ownership/);
    });

    it('projects hook semantics from the canonical protocol hook catalog when normalized hook records omit raw v2 fields', () => {
        const registry: ResolvedContributionRegistry = {
            providers: [],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            activationTargets: [],
            hookRegistrations: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.reload',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:reload',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        hookApiVersion: 1,
                        id: 'plugin.reload.before',
                        category: 'lifecycle',
                        scope: 'backend',
                        executionKind: 'observe',
                        handler: {
                            target: 'plugin',
                        },
                    },
                },
            ],
            lifecycleHandlers: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
            uiDescriptorsById: new Map(),
            lifecycleHandlersById: new Map(),
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 4,
        });

        expect(Object.values(projection.hooksById ?? {})).toEqual([
            {
                id: 'acme.reload:plugin.reload.before:1',
                pluginId: 'acme.reload',
                eventId: 'plugin.reload.before',
                category: 'lifecycle',
                scope: 'plugin',
                executionKind: 'observe',
                aggregation: 'orderedList',
                failureMode: 'bestEffort',
                priority: undefined,
            },
        ]);
    });

    it('keeps multiple plugin registrations for the same hook event instead of overwriting them in projection output', () => {
        const registry: ResolvedContributionRegistry = {
            providers: [],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            activationTargets: [],
            hookRegistrations: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'alpha.reload',
                    manifestPath: '/tmp/alpha/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:alpha',
                    daemonEntryPath: '/tmp/alpha/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/alpha',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        hookApiVersion: 1,
                        id: 'plugin.reload.before',
                        category: 'lifecycle',
                        scope: 'backend',
                        executionKind: 'observe',
                        handler: {
                            target: 'plugin',
                        },
                    },
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'beta.reload',
                    manifestPath: '/tmp/beta/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:beta',
                    daemonEntryPath: '/tmp/beta/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/beta',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        hookApiVersion: 1,
                        id: 'plugin.reload.before',
                        category: 'lifecycle',
                        scope: 'backend',
                        executionKind: 'observe',
                        handler: {
                            target: 'plugin',
                        },
                    },
                },
            ],
            lifecycleHandlers: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
            uiDescriptorsById: new Map(),
            lifecycleHandlersById: new Map(),
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 4,
        });

        expect(Object.keys(projection.hooksById ?? {})).toEqual([
            'alpha.reload:plugin.reload.before:1',
            'beta.reload:plugin.reload.before:1',
        ]);
        expect(Object.values(projection.hooksById ?? {})).toEqual([
            expect.objectContaining({
                id: 'alpha.reload:plugin.reload.before:1',
                pluginId: 'alpha.reload',
                eventId: 'plugin.reload.before',
            }),
            expect.objectContaining({
                id: 'beta.reload:plugin.reload.before:1',
                pluginId: 'beta.reload',
                eventId: 'plugin.reload.before',
            }),
        ]);
    });

    it("projects built-in contributes as bundled sources so first-party plugins don't look like external installs", () => {
        const registry: ResolvedContributionRegistry = {
            providers: [{
                id: 'happier.bundled',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'happier.bundled',
                    ownedBackendIds: [],
                },
                // PS-02/PS-06: bundled first-party contributes carry a plugin id, but must not
                // be projected as if they were installed from a path/archive.
                pluginId: 'happier.bundled',
            }],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [],
            activationTargets: [],
            hookRegistrations: [],
            lifecycleHandlers: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
            uiDescriptorsById: new Map(),
            lifecycleHandlersById: new Map(),
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
            installedPackages: [],
        });

        expect(projection.installedPackagesById).toEqual({
            'happier.bundled': expect.objectContaining({
                id: 'happier.bundled',
                source: {
                    kind: 'bundled',
                    locator: 'happier.bundled',
                },
            }),
        });
    });

    it('includes bundled plugin UI descriptors in the projection output', () => {
        const registry: ResolvedContributionRegistry = {
            providers: [],
            backends: [],
            actions: [],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [{
                provenance: 'first_party',
                source: { kind: 'bundled' },
                pluginId: 'happier.bundled',
                definition: {
                    kindVersion: 1,
                    id: 'happier.bundled.settings',
                    surface: 'settings',
                    title: 'Bundled Settings',
                    description: null,
                    fields: [],
                },
            }],
            activationTargets: [],
            hookRegistrations: [],
            lifecycleHandlers: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
            uiDescriptorsById: new Map(),
            lifecycleHandlersById: new Map(),
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
            installedPackages: [],
        });

        expect(projection.uiDescriptorsById).toHaveProperty('happier.bundled.settings');
        expect(projection.uiDescriptorsById['happier.bundled.settings']).toEqual(expect.objectContaining({
            pluginId: 'happier.bundled',
            surface: 'settings',
            title: 'Bundled Settings',
        }));
    });

    it('normalizes legacy provider settings descriptors to the plugin agent settings surface', () => {
        const registry = createEmptyResolvedContributionRegistry();
        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
                uiDescriptors: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.plugin',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.plugin.provider-settings',
                        surface: 'providerSettings',
                        title: 'Provider settings',
                        description: null,
                        fields: [],
                    },
                }],
            },
            generation: 1,
        });

        expect(projection.uiDescriptorsById['acme.plugin.provider-settings']?.surface).toBe('agentSettings');
    });

    it('projects UI descriptor fields without inventing unsupported optional metadata', () => {
        const registry: ResolvedContributionRegistry = {
            providers: [],
            backends: [],
            actions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.plugin',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.plugin.refresh',
                        title: 'Refresh Acme',
                        description: 'Refreshes Acme state',
                        safety: 'safe',
                        placements: [],
                        slash: null,
                        bindings: null,
                        examples: null,
                        surfaces: {
                            ui: true,
                            voice: false,
                            session_agent: false,
                            mcp: false,
                            cli: false,
                            rpc: false,
                            sdk: false,
                        },
                        inputHints: null,
                        inputSchema: {},
                    },
                },
            ],
            tools: [],
            commands: [],
            resources: [],
            uiDescriptors: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.plugin',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.plugin.settings',
                        surface: 'settings',
                        title: 'Acme settings',
                        description: 'Host-rendered plugin settings',
                        fields: [
                            {
                                id: 'runRefresh',
                                kind: 'action',
                                title: 'Run refresh',
                                description: 'Execute refresh',
                                options: [],
                            },
                        ],
                    },
                },
            ],
            activationTargets: [],
            hookRegistrations: [],
            lifecycleHandlers: [],
            actionsById: new Map(),
            toolsById: new Map(),
            commandsById: new Map(),
            resourcesById: new Map(),
            uiDescriptorsById: new Map(),
            lifecycleHandlersById: new Map(),
            runtimeCoreHooksByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 4,
        });

        expect(projection.uiDescriptorsById['acme.plugin.settings']).toMatchObject({
            id: 'acme.plugin.settings',
            pluginId: 'acme.plugin',
            surface: 'settings',
            title: 'Acme settings',
            description: 'Host-rendered plugin settings',
            fields: [
                expect.objectContaining({
                    id: 'runRefresh',
                    type: 'action',
                }),
            ],
        });
    });
});
