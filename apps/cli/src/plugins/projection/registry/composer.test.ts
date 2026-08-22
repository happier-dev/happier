import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from './normalize/package';
import { buildPluginProjectionV2 } from './projection/v2';
import {
    projectDaemonComposerSurfaceCatalog,
    readCurrentComposerReactNativeCrashStateBindings,
} from './composer';
import { projectLoadedPluginContributes } from './resolvePluginContributions';
import { createReactNativeCrashStateBindingKey } from '@/plugins/runtime/ui/reactNativeCrashDisableState';
import type {
    ResolvedComposerAttachmentContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
} from './types';

function emptyRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        catalogEntriesById: {},
        agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

function loadedComposerPlugin(): LoadedPlugin {
    const pluginId = 'acme.composer';
    return {
        pluginId,
        pluginRootPath: `/plugins/${pluginId}`,
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        daemonEntryPath: `/plugins/${pluginId}/dist/plugin.js`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${pluginId}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: normalizePluginManifestV2({
            schemaVersion: 2,
            id: pluginId,
            version: '1.0.0',
            displayName: 'Acme Composer',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './dist/plugin.js' },
            contributes: {
                composerReferences: [{
                    id: 'issues',
                    title: 'Issues',
                    description: 'Search issues',
                    icon: 'search',
                    triggers: ['$'],
                }],
                composerAttachments: [{
                    id: 'issue',
                    title: 'Issue',
                    icon: 'warning',
                    cardinality: 'many',
                    valueSchema: { type: 'object' },
                }],
                composerControls: [{
                    id: 'create',
                    label: 'Create',
                    icon: 'add',
                    interaction: {
                        kind: 'attachmentPicker',
                        attachment: 'issue',
                        presentation: 'popover',
                        layout: 'content',
                    },
                }],
                composerRegions: [{
                    id: 'summary',
                    placement: 'beforeComposer',
                    renderer: { renderer: 'composer-summary' },
                }],
                ui: {
                    renderers: [{
                        id: 'composer-summary',
                        kind: 'declarative',
                        root: { kind: 'text', text: 'Summary' },
                    }],
                },
            },
        }),
    };
}

describe('composer contribution projection families', () => {
    it('normalizes omitted Composer families to empty arrays at the contribution-registry owner', () => {
        const populated = loadedComposerPlugin();
        const plugin: LoadedPlugin = {
            ...populated,
            manifest: normalizePluginManifestV2({
                schemaVersion: 2,
                id: populated.pluginId,
                version: '1.0.0',
                displayName: 'Empty Composer',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './dist/plugin.js' },
                contributes: {},
            }),
        };

        const normalized = buildPluginContributionRegistry({
            loadedPlugins: [plugin],
        });

        expect(normalized.composerReferences).toEqual([]);
        expect(normalized.composerAttachments).toEqual([]);
        expect(normalized.composerControls).toEqual([]);
        expect(normalized.composerRegions).toEqual([]);
    });

    it('walks static Composer declarations from manifest normalization through the one resolved projection', () => {
        const plugin = loadedComposerPlugin();
        const resolved = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} },
            provenance: 'external',
        });
        const registry = createResolvedContributionRegistry({
            ...resolved,
            immutableGenerationIdsByPluginId: { [plugin.pluginId]: 'immutable-composer-7' },
        });
        const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({
            registry,
            generation: 19,
        }));

        expect(registry.composerAttachments).toMatchObject([{
            identity: { pluginId: plugin.pluginId, localId: 'issue' },
            definition: { id: 'issue' },
        }]);
        expect(registry.composerReferences).toMatchObject([{
            identity: { pluginId: plugin.pluginId, localId: 'issues' },
            definition: {
                id: 'issues',
                title: 'Issues',
                description: 'Search issues',
                icon: 'search',
                triggers: ['$'],
            },
        }]);
        expect(registry.composerControls).toMatchObject([{
            identity: { pluginId: plugin.pluginId, localId: 'create' },
            definition: { id: 'create' },
        }]);
        expect(registry.composerRegions).toMatchObject([{
            identity: { pluginId: plugin.pluginId, localId: 'summary' },
            definition: { id: 'summary' },
        }]);
        expect(projection.familiesById).toMatchObject({
            composerAttachments: {
                entriesById: {
                    'acme.composer/issue': expect.objectContaining({
                        identity: { pluginId: plugin.pluginId, localId: 'issue' },
                        immutableGenerationId: 'immutable-composer-7',
                    }),
                },
            },
            composerControls: {
                entriesById: {
                    'acme.composer/create': expect.objectContaining({
                        identity: { pluginId: plugin.pluginId, localId: 'create' },
                        immutableGenerationId: 'immutable-composer-7',
                    }),
                },
            },
            composerRegions: {
                entriesById: {
                    'acme.composer/summary': expect.objectContaining({
                        identity: { pluginId: plugin.pluginId, localId: 'summary' },
                        immutableGenerationId: 'immutable-composer-7',
                    }),
                },
            },
        });
        expect(projection.familiesById).not.toHaveProperty('composerReferences');
    });

    it('projects admitted static attachments, controls, and regions by qualified identity and immutable generation', () => {
        const pluginId = 'acme.composer';
        const attachment = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'issue' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'issue',
                title: 'Issue',
                icon: 'warning',
                cardinality: 'many',
                valueSchema: { type: 'object' },
            },
        } as const satisfies ResolvedComposerAttachmentContribution;
        const control = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'create' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'create',
                label: 'Create',
                icon: 'add',
                interaction: {
                    kind: 'choices',
                    selection: 'single',
                    options: [{
                        id: 'create',
                        label: 'Create',
                        effect: {
                            kind: 'composerApply',
                            operations: [{ kind: 'text.set', text: 'Create a task for ' }],
                        },
                    }],
                },
            },
        } as const satisfies ResolvedComposerControlContribution;
        const region = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'summary' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'summary',
                placement: 'beforeComposer',
                renderer: { renderer: 'composer-summary' },
            },
        } as const satisfies ResolvedComposerRegionContribution;
        const registry: ResolvedContributionRegistry = {
            ...emptyRegistry(),
            composerAttachments: [attachment],
            composerControls: [control],
            composerRegions: [region],
            immutableGenerationIdsByPluginId: { [pluginId]: 'immutable-composer-7' },
        };

        const projection = buildPluginProjectionV2({ registry, generation: 19 });

        expect(projection.familiesById).toMatchObject({
            composerAttachments: {
                family: 'composerAttachments',
                entriesById: {
                    'acme.composer/issue': {
                        id: 'acme.composer/issue',
                        identity: attachment.identity,
                        immutableGenerationId: 'immutable-composer-7',
                        definition: attachment.definition,
                    },
                },
            },
            composerControls: {
                family: 'composerControls',
                entriesById: {
                    'acme.composer/create': {
                        id: 'acme.composer/create',
                        identity: control.identity,
                        immutableGenerationId: 'immutable-composer-7',
                        definition: control.definition,
                    },
                },
            },
            composerRegions: {
                family: 'composerRegions',
                entriesById: {
                    'acme.composer/summary': {
                        id: 'acme.composer/summary',
                        identity: region.identity,
                        immutableGenerationId: 'immutable-composer-7',
                        definition: region.definition,
                    },
                },
            },
        });
    });

    it('rejects a Composer renderer whose resolved identity is not owned by the declaring plugin', () => {
        const pluginId = 'acme.composer';
        const rendererId = 'summary';
        const region = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'summary-region' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'summary-region',
                placement: 'beforeComposer',
                renderer: { renderer: rendererId },
            },
        } as const satisfies ResolvedComposerRegionContribution;
        const forgedRenderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId: 'acme.forged', localId: rendererId },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: rendererId,
                kind: 'declarative',
                root: { kind: 'text', text: 'Forged' },
            },
        } as const satisfies ResolvedUiRendererV2Contribution;
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [forgedRenderer],
            composerRegions: [region],
            immutableGenerationIdsByPluginId: { [pluginId]: 'composer-generation' },
            activationTargets: [],
        });

        const catalog = projectDaemonComposerSurfaceCatalog({
            registry,
            projection: buildPluginProjectionV2({ registry, generation: 27 }),
            pluginUiHostRuntime: {},
            modelsByRendererKey: {},
            pluginExecutionOriginsByPluginId: {
                [pluginId]: {
                    serverIdentityId: 'server-composer',
                    materializationRef: {
                        machineId: 'machine-composer',
                        materializationId: 'composer-materialization',
                        pluginId,
                    },
                },
            },
            resourceCapabilityForPlugin: () => ({ readable: true, dynamic: true }),
            readContributorTargetedContributions: (target) => ({ target, points: [] }),
        });

        expect(catalog).toEqual([]);
    });

    it('does not project a static composer contribution without its current immutable generation', () => {
        const pluginId = 'acme.composer';
        const attachment = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'issue' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'issue',
                title: 'Issue',
                icon: 'warning',
                cardinality: 'many',
                valueSchema: { type: 'object' },
            },
        } as const satisfies ResolvedComposerAttachmentContribution;
        const registry: ResolvedContributionRegistry = {
            ...emptyRegistry(),
            composerAttachments: [attachment],
            immutableGenerationIdsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({ registry, generation: 20 });

        expect(projection.familiesById).toMatchObject({
            composerAttachments: {
                entriesById: {},
            },
        });
    });

    it('projects a disabled exact Composer React Native crash state through the selected renderer', () => {
        const pluginId = 'acme.composer';
        const immutableGenerationId = 'immutable-composer-7';
        const rendererId = 'composer-region';
        const region = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'summary' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'summary',
                placement: 'beforeComposer',
                renderer: { renderer: rendererId },
            },
        } as const satisfies ResolvedComposerRegionContribution;
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: rendererId },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: rendererId,
                kind: 'reactNative',
                artifact: 'composer-region-bundle',
                requiredHostMethods: [],
            },
        } as const satisfies ResolvedUiRendererV2Contribution;
        const registry: ResolvedContributionRegistry = {
            ...emptyRegistry(),
            composerRegions: [region],
            uiRenderersV2: [renderer],
            immutableGenerationIdsByPluginId: { [pluginId]: immutableGenerationId },
        };
        const mount = {
            kind: 'composer' as const,
            contribution: region.identity,
            immutableGenerationId,
            role: 'region' as const,
        };
        const artifactDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
        const crashState = {
            token: {
                mount,
                renderer: renderer.identity,
                artifactDigest,
                crashStateEpoch: 0,
            },
            disabled: true,
        };
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 31,
            familiesById: {
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        [`reactNativeBundle:${pluginId}:${rendererId}`]: {
                            id: `reactNativeBundle:${pluginId}:${rendererId}`,
                            pluginId,
                            runtime: {
                                decision: {
                                    state: 'load',
                                    reason: 'compatible',
                                    diagnostics: [],
                                },
                                cacheIdentity: {
                                    pluginId,
                                    contributionId: rendererId,
                                    artifactDigest: crashState.token.artifactDigest,
                                    hostAppVersion: '1.0.0',
                                    hostUiApiVersion: '1.0.0',
                                    reactVersion: '19.0.0',
                                    reactNativeVersion: '0.80.0',
                                    platform: 'ios',
                                    channel: 'internal',
                                    nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
                                    projectionGeneration: 31,
                                },
                            },
                        },
                    },
                },
            },
        });

        expect(readCurrentComposerReactNativeCrashStateBindings({ registry, projection })).toEqual([{
            mount,
            renderer: renderer.identity,
            artifactDigest: crashState.token.artifactDigest,
        }]);

        const catalog = projectDaemonComposerSurfaceCatalog({
            registry,
            projection,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    crashStatesByBindingKey: {
                        [createReactNativeCrashStateBindingKey({ mount, renderer: renderer.identity })]: crashState,
                    },
                },
            },
            modelsByRendererKey: {},
            pluginExecutionOriginsByPluginId: {
                [pluginId]: {
                    serverIdentityId: 'server-composer',
                    materializationRef: {
                        machineId: 'machine-composer',
                        materializationId: 'composer-materialization',
                        pluginId,
                    },
                },
            },
            resourceCapabilityForPlugin: () => ({ readable: true, dynamic: true }),
            readContributorTargetedContributions: (target) => ({ target, points: [] }),
        });

        expect(catalog).toMatchObject([{
            contribution: region.identity,
            role: 'region',
            selectedRenderer: {
                identity: renderer.identity,
                availability: {
                    state: 'disabled',
                    reason: 'crash_disabled',
                },
                crashState,
            },
        }]);
    });
});
