import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from './v2';
import type { ResolvedContributionRegistry } from '../types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
        agentRuntimes: [],
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
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
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
                agents: [
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
                agentRuntimes: [
                    {
                        id: 'acme.backend',
                        agentId: 'acme.provider',
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.backend',
                            agentId: 'acme.provider',
                        },
                    },
                ],
            },
            generation: 1,
        });

        expect((projection.backendsById['acme.backend'] as Record<string, unknown> | undefined)?.capabilities).toMatchObject({
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
            mcpDiscoveryProviders: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.mcp',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:mcp',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    definition: {
                        id: 'acme.discovery',
                        kind: 'mcp.discoveryProvider',
                        version: '1.0.0',
                        agentId: 'acme',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 6,
        });

        expect(projection.familiesById.mcp?.entriesById['server:acme.server']).toMatchObject({
            id: 'server:acme.server',
            pluginId: 'acme.mcp',
            contributionKind: 'server',
            name: 'acme-hosted',
            transport: 'hosted',
        });
        expect(projection.familiesById.mcp?.entriesById['discoveryProvider:acme.discovery']).toMatchObject({
            id: 'discoveryProvider:acme.discovery',
            pluginId: 'acme.mcp',
            contributionKind: 'discoveryProvider',
            agentId: 'acme',
        });
        expect(projection.familiesById.mcp?.entriesById['backendClient:acme.backendClient']).toBeUndefined();
        expect(projection.familiesById.mcp?.entriesById['tool:acme.tool']).toBeUndefined();
        expect('mcpBackendClients' in projection).toBe(false);
        expect('mcpTools' in projection).toBe(false);
    });

    it('projects hook semantics from the canonical protocol hook catalog when normalized hook records omit raw v2 fields', () => {
        const registry: ResolvedContributionRegistry = {
            agents: [],
            agentRuntimes: [],
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
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
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
            agents: [],
            agentRuntimes: [],
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
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
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
            agents: [{
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
            agentRuntimes: [],
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
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
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

    it('projects first-party provider settings backend ids for bundled multi-backend agents', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            agents: [{
                id: 'antigravity',
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: 'antigravity',
                    ownedBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
                    settingsBackendId: 'antigravity-localharness',
                    catalogAgentId: 'antigravity',
                    iconAgentId: 'antigravity',
                },
                pluginId: 'happier.agent.antigravity',
            }],
            agentRuntimes: [
                {
                    id: 'antigravity-localharness',
                    agentId: 'antigravity',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'antigravity-localharness',
                        agentId: 'antigravity',
                    },
                },
                {
                    id: 'antigravity-terminal',
                    agentId: 'antigravity',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'antigravity-terminal',
                        agentId: 'antigravity',
                    },
                },
            ],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 1,
            installedPackages: [],
        });

        expect(projection.providersById.antigravity).toEqual(expect.objectContaining({
            settingsBackendId: 'antigravity-localharness',
            providerAgentId: 'antigravity',
            iconAgentId: 'antigravity',
        }));
        expect(projection.backendsById['antigravity-localharness']).toEqual(expect.objectContaining({
            providerId: 'antigravity',
        }));
        expect(projection.backendsById['antigravity-terminal']).toEqual(expect.objectContaining({
            providerId: 'antigravity',
        }));
    });

    it('includes bundled plugin UI descriptors in the projection output', () => {
        const registry: ResolvedContributionRegistry = {
            agents: [],
            agentRuntimes: [],
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
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
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

    it('projects generic plugin-local settings for a hook-only plugin without mixing them into UI descriptors', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            hookRegistrations: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.hooks',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:hooks',
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
                        scope: 'plugin',
                        executionKind: 'observe',
                        handler: {
                            target: 'plugin',
                        },
                    },
                },
            ],
            settings: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.hooks',
                    manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:settings',
                    daemonEntryPath: '/tmp/acme/daemon.mjs',
                    sourceSpec: {
                        kind: 'path',
                        locator: '/tmp/acme',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                    },
                    definition: {
                        id: 'acme.hooks.settings',
                        fields: [
                            {
                                id: 'apiToken',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: {
                                    type: 'string',
                                    default: 'schema-secret-default',
                                    enum: ['schema-secret-option'],
                                },
                                control: 'password',
	                                displayKey: 'plugins.acme.apiToken.label',
	                                descriptionKey: 'plugins.acme.apiToken.description',
	                                capabilityGates: [],
	                                permissionGates: [],
	                                redaction: 'secret',
	                                hidden: false,
	                                defaultValue: 'super-secret-token',
	                                clearWhenEmpty: 'omit',
	                            },
                            {
                                id: 'enabled',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'boolean' },
	                                control: 'switch',
	                                displayKey: 'plugins.acme.enabled.label',
	                                capabilityGates: [],
	                                permissionGates: [],
	                                redaction: 'none',
	                                clearWhenEmpty: 'persist',
	                                defaultBooleanValue: true,
	                                hidden: false,
	                            },
                            {
                                id: 'internalOnly',
                                kind: 'settings.field',
                                version: '1.0.0',
	                                valueSchema: { type: 'string' },
	                                control: 'text',
	                                displayKey: 'plugins.acme.internalOnly.label',
	                                capabilityGates: [],
	                                permissionGates: [],
	                                redaction: 'none',
	                                clearWhenEmpty: 'persist',
	                                hidden: true,
	                            },
                        ],
                    },
                },
            ],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
            installedPackages: [],
        });

        expect(projection.settingsById['acme.hooks.settings']).toEqual({
            id: 'acme.hooks.settings',
            pluginId: 'acme.hooks',
            storageScope: 'pluginLocal',
            fields: [
                expect.objectContaining({
                    id: 'apiToken',
                    control: 'password',
                    redaction: 'secret',
                    clearWhenEmpty: 'omit',
                }),
                expect.objectContaining({
                    id: 'enabled',
                    control: 'switch',
                    defaultBooleanValue: true,
                }),
            ],
        });
        expect(projection.settingsById['acme.hooks.settings']?.fields.map((field) => field.id)).toEqual([
            'apiToken',
            'enabled',
        ]);
        expect(projection.settingsById['acme.hooks.settings']?.fields[0]?.valueSchema).toEqual({ type: 'string' });
        expect(projection.uiDescriptorsById['acme.hooks.settings']).toBeUndefined();
        expect(JSON.stringify(projection.settingsById)).not.toContain('super-secret-token');
        expect(JSON.stringify(projection.settingsById)).not.toContain('schema-secret-default');
        expect(JSON.stringify(projection.settingsById)).not.toContain('schema-secret-option');
    });

    it('normalizes agent settings descriptors to the plugin agent settings surface', () => {
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
                        id: 'acme.plugin.agent-settings',
                        surface: 'agentSettings',
                        title: 'Agent settings',
                        description: null,
                        fields: [],
                    },
                }],
            },
            generation: 1,
        });

        expect(projection.uiDescriptorsById['acme.plugin.agent-settings']?.surface).toBe('agentSettings');
    });

    it('fails closed for retired or unknown UI descriptor surfaces', () => {
        const retiredBackendSurface = ('backend' + 'Settings') as 'agentSettings';
        const unknownSurface = 'settings.plugin.' + 'details';
        const registry = createEmptyResolvedContributionRegistry();
        const projection = buildPluginProjectionV2({
            registry: {
                ...registry,
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
                            id: 'acme.plugin.retired',
                            surface: retiredBackendSurface,
                            title: 'Retired',
                            description: null,
                            fields: [],
                        },
                    },
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
                            id: 'acme.plugin.unknown',
                            surface: unknownSurface as 'settings',
                            title: 'Unknown',
                            description: null,
                            fields: [],
                        },
                    },
                ],
            },
            generation: 1,
        });

        expect(projection.uiDescriptorsById['acme.plugin.retired']).toBeUndefined();
        expect(projection.uiDescriptorsById['acme.plugin.unknown']).toBeUndefined();
    });

    it('projects UI descriptor fields without inventing unsupported optional metadata', () => {
        const registry: ResolvedContributionRegistry = {
            agents: [],
            agentRuntimes: [],
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
                            agent: false,
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
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
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
