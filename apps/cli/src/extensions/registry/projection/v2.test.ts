import { describe, expect, it } from 'vitest';

import { buildExtensionProjectionV2 } from './v2';
import type { ResolvedContributionRegistry } from '../types';

describe('buildExtensionProjectionV2', () => {
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
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildExtensionProjectionV2({
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
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildExtensionProjectionV2({
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

    it("projects built-in contributions as bundled sources so first-party plugins don't look like external installs", () => {
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
                // PS-02/PS-06: bundled first-party contributions carry a plugin id, but must not
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
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildExtensionProjectionV2({
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
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildExtensionProjectionV2({
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

    it('projects UI descriptor fields without inventing unsupported optional metadata', () => {
        const registry: ResolvedContributionRegistry = {
            providers: [],
            backends: [],
            actions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.extension',
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
                        id: 'acme.extension.refresh',
                        title: 'Refresh Acme',
                        description: 'Refreshes Acme state',
                        safety: 'safe',
                        placements: [],
                        slash: null,
                        bindings: null,
                        examples: null,
                        surfaces: {
                            ui_button: true,
                            ui_slash_command: false,
                            voice_tool: false,
                            voice_action_block: false,
                            session_agent: false,
                            mcp: false,
                            cli: false,
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
                    pluginId: 'acme.extension',
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
                        id: 'acme.extension.settings',
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
            runtimeAdaptersByBackendId: new Map(),
            catalogEntriesById: {},
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };

        const projection = buildExtensionProjectionV2({
            registry,
            generation: 4,
        });

        expect(projection.uiDescriptorsById['acme.extension.settings']).toMatchObject({
            id: 'acme.extension.settings',
            pluginId: 'acme.extension',
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
