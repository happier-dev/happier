import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from './normalize/package';
import { buildPluginProjectionV2 } from './projection/v2';
import {
    projectDaemonEmbeddedPluginUiRenderer,
    projectDaemonComposerSurfaceCatalog,
} from './composer';
import { projectLoadedPluginContributes } from './fullProjection';
import type {
    ResolvedComposerAttachmentContribution,
    ResolvedComposerControlContribution,
    ResolvedComposerRegionContribution,
    ResolvedContributionRegistry,
    ResolvedUiRendererV2Contribution,
} from './types';

function emptyRegistry(): ResolvedContributionRegistry {
    return createResolvedContributionRegistry({});
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
    it('refuses an embedded renderer request outside the registry current occurrence', () => {
        const pluginId = 'acme.composer';
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId,
            pluginVersion: '1.0.0',
            identity: { pluginId, localId: 'setup' },
            manifestPath: '/fixtures/acme.composer/plugin.json',
            definition: {
                id: 'setup',
                kind: 'declarative',
                root: { kind: 'text', text: 'Setup' },
            },
        } as const satisfies ResolvedUiRendererV2Contribution;
        const registry = createResolvedContributionRegistry({
            agents: [],
            uiRenderersV2: [renderer],
            occurrenceIdsByPluginId: {
                [pluginId]: createPluginRuntimeOccurrenceId('occurrence-current'),
            },
            activationTargets: [],
        });

        expect(projectDaemonEmbeddedPluginUiRenderer({
            registry,
            projection: buildPluginProjectionV2({ registry, generation: 27 }),
            pluginUiHostRuntime: {},
            modelsByRendererKey: {},
            contributor: { pluginId, localId: 'event' },
            occurrenceId: createPluginRuntimeOccurrenceId('occurrence-retired'),
            renderer: { renderer: 'setup' },
        })).toBeNull();
    });

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
        const occurrenceId = createPluginRuntimeOccurrenceId('composer-occurrence-7');
        const registry = createResolvedContributionRegistry({
            ...resolved,
            occurrenceIdsByPluginId: {
                [plugin.pluginId]: occurrenceId,
            },
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
                        occurrenceId,
                    }),
                },
            },
            composerControls: {
                entriesById: {
                    'acme.composer/create': expect.objectContaining({
                        identity: { pluginId: plugin.pluginId, localId: 'create' },
                        occurrenceId,
                    }),
                },
            },
            composerRegions: {
                entriesById: {
                    'acme.composer/summary': expect.objectContaining({
                        identity: { pluginId: plugin.pluginId, localId: 'summary' },
                        occurrenceId,
                    }),
                },
            },
        });
        expect(projection.familiesById).not.toHaveProperty('composerReferences');
    });

    it('projects admitted static attachments, controls, and regions by qualified identity and occurrence', () => {
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
        const occurrenceId = createPluginRuntimeOccurrenceId('composer-occurrence-7');
        const registry: ResolvedContributionRegistry = {
            ...emptyRegistry(),
            composerAttachments: [attachment],
            composerControls: [control],
            composerRegions: [region],
            occurrenceIdsByPluginId: {
                [pluginId]: occurrenceId,
            },
        };

        const projection = buildPluginProjectionV2({ registry, generation: 19 });

        expect(projection.familiesById).toMatchObject({
            composerAttachments: {
                family: 'composerAttachments',
                entriesById: {
                    'acme.composer/issue': {
                        id: 'acme.composer/issue',
                        identity: attachment.identity,
                        occurrenceId,
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
                        occurrenceId,
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
                        occurrenceId,
                        definition: region.definition,
                    },
                },
            },
        });
    });

    it('does not project a static composer contribution without its current occurrence', () => {
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
            occurrenceIdsByPluginId: {},
        };

        const projection = buildPluginProjectionV2({ registry, generation: 20 });

        expect(projection.familiesById).toMatchObject({
            composerAttachments: {
                entriesById: {},
            },
        });
    });

});
