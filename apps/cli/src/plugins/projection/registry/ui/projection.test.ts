import { readFileSync } from 'node:fs';

import {
    PluginOpenableContentViewerContributionV1Schema,
    PluginProjectionV2Schema,
    PluginUiViewV2Schema,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '../projection/v2';
import { projectPluginUiRendererAvailability, projectPluginUiRendererRef } from './projection';
import type {
    ResolvedContributionRegistry,
    ResolvedOpenableContentViewerContribution,
    ResolvedUiViewV2Contribution,
} from '../types';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import {
    createPluginRuntimeOccurrenceId,
    type PluginRuntimeOccurrenceId,
} from '@/plugins/runtime/runtimeSlots';

const admittedOccurrencesByPluginId = new Map<string, PluginRuntimeOccurrenceId>();

function admittedOccurrenceForPlugin(pluginId: string): PluginRuntimeOccurrenceId {
    const existing = admittedOccurrencesByPluginId.get(pluginId);
    if (existing) return existing;
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    admittedOccurrencesByPluginId.set(pluginId, occurrenceId);
    return occurrenceId;
}

it('projects inline HTML source through the canonical renderer reference without an Artifact entry', () => {
    expect(projectPluginUiRendererRef({
        pluginId: 'com.acme.inline',
        pluginVersion: '1.0.0',
        provenance: 'external', source: { kind: 'path' },
        identity: { pluginId: 'com.acme.inline', localId: 'inline' }, manifestPath: '/plugin/happier.plugin.json',
        definition: { id: 'inline', kind: 'hostedHtml', source: { kind: 'html', html: '<p>Hello</p>' }, requiredHostMethods: ['context'] },
    }, undefined)).toEqual({
        rendererRef: { kind: 'hostedHtml', contributionId: 'inline', source: { kind: 'html', html: '<p>Hello</p>' }, requiredHostMethods: ['context'] },
        registryRendererRef: { kind: 'hostedHtml', contributionId: 'inline' },
    });
});

it('projects bundled and external inline HTML with identical public renderer semantics', () => {
    const project = (pluginId: string, provenance: 'first_party' | 'external') => projectPluginUiRendererRef({
        pluginId,
        pluginVersion: '1.0.0',
        provenance,
        source: { kind: 'path' },
        identity: { pluginId, localId: 'status' },
        manifestPath: '/plugin/happier.plugin.json',
        definition: {
            id: 'status',
            kind: 'hostedHtml',
            source: { kind: 'html', html: '<p>Status</p>' },
        },
    }, undefined);

    expect(project('built-in.review', 'first_party')).toEqual(project('com.acme.external', 'external'));
});

it('carries the declared hosted-HTML capability request to the mount that must enforce it', () => {
    const requestedCapabilities = {
        resources: [{ pluginId: 'com.acme.inline', localId: 'status' }],
        networkOrigins: ['https://api.example.com'],
    };
    const projected = projectPluginUiRendererRef({
        pluginId: 'com.acme.inline',
        pluginVersion: '1.0.0',
        provenance: 'external', source: { kind: 'path' },
        identity: { pluginId: 'com.acme.inline', localId: 'inline' }, manifestPath: '/plugin/happier.plugin.json',
        definition: {
            id: 'inline',
            kind: 'hostedHtml',
            source: { kind: 'html', html: '<p>Hello</p>' },
            requiredHostMethods: ['context'],
            requestedCapabilities,
        },
    }, undefined);
    expect(projected.rendererRef).toEqual({
        kind: 'hostedHtml',
        contributionId: 'inline',
        source: { kind: 'html', html: '<p>Hello</p>' },
        requiredHostMethods: ['context'],
        requestedCapabilities,
    });
    // The registry reference stays a stable identity: declared authority is
    // resolved at the mount, never cached as a placement fact.
    expect(projected.registryRendererRef).toEqual({ kind: 'hostedHtml', contributionId: 'inline' });
    // An Artifact-backed renderer has no by-value capability request to carry.
    expect(projectPluginUiRendererRef({
        pluginId: 'com.acme.inline',
        pluginVersion: '1.0.0',
        provenance: 'external', source: { kind: 'path' },
        identity: { pluginId: 'com.acme.inline', localId: 'web' }, manifestPath: '/plugin/happier.plugin.json',
        definition: { id: 'web', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'web' } },
    }, undefined).rendererRef).not.toHaveProperty('requestedCapabilities');
});

it('reports admitted inline source availability without looking for an Artifact', () => {
    expect(projectPluginUiRendererAvailability({
        pluginId: 'com.acme.inline',
        renderer: {
            pluginId: 'com.acme.inline', provenance: 'external', source: { kind: 'path' },
            identity: { pluginId: 'com.acme.inline', localId: 'inline' }, manifestPath: '/plugin/happier.plugin.json',
            definition: { id: 'inline', kind: 'hostedHtml', source: { kind: 'html', html: '<p>Hello</p>' } },
        },
        declarativeModel: undefined,
        registryRendererRef: { kind: 'hostedHtml', contributionId: 'inline' },
        entriesById: {},
    })).toEqual({ state: 'available', reason: 'available', diagnostics: [] });
});

function createEmptyResolvedContributionRegistry(
    ...admittedPluginIds: readonly string[]
): ResolvedContributionRegistry {
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
        occurrenceIdsByPluginId: Object.fromEntries(admittedPluginIds.map((pluginId) => [
            pluginId,
            admittedOccurrenceForPlugin(pluginId),
        ])),
    };
}

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
};

const emptyDeclarativeInventory = Object.freeze({
    dragSources: Object.freeze([]),
    dropTargets: Object.freeze([]),
    actions: Object.freeze([]),
    destinations: Object.freeze([]),
    settings: Object.freeze([]),
    uiQueries: Object.freeze([]),
}) satisfies StablePluginDeclarativeModel['declarativeInventory'];

describe('plugin UI projection family', () => {
    it('isolates one malformed projected entry while preserving healthy sibling and app-page contributions', () => {
        const channelsPluginId = 'happier.channels';
        const triagePluginId = 'happier.triage';
        const channelsOccurrenceId = createPluginRuntimeOccurrenceId(channelsPluginId);
        const triageOccurrenceId = createPluginRuntimeOccurrenceId(triagePluginId);
        const view = (pluginId: string, id: string, container: 'widget' | 'appPage') => ({
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            pluginId,
            pluginVersion: '1.2.3',
            identity: createPluginContributionIdentity({ pluginId, localId: id }),
            manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            definition: PluginUiViewV2Schema.parse(container === 'widget' ? {
                id,
                container: 'widget',
                target: { kind: 'session' },
                renderer: 'renderer',
                title: id,
                inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
                inputSchema: { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false },
                sessionInputPath: 'session',
            } : {
                id, container: 'appPage', target: { kind: 'app' }, renderer: 'renderer', title: id,
            }),
        });
        const uiViewsV2 = [
            view(channelsPluginId, 'session-conversations-widget', 'widget'),
            view(channelsPluginId, 'channels', 'appPage'),
            view(triagePluginId, 'triage', 'appPage'),
        ] satisfies NonNullable<ResolvedContributionRegistry['uiViewsV2']>;
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            occurrenceIdsByPluginId: {
                [channelsPluginId]: channelsOccurrenceId,
                [triagePluginId]: triageOccurrenceId,
            },
            uiViewsV2,
            uiRenderersV2: [channelsPluginId, triagePluginId].map((pluginId) => ({
                provenance: 'first_party', source: { kind: 'bundled' }, pluginId, pluginVersion: '1.2.3',
                identity: createPluginContributionIdentity({ pluginId, localId: 'renderer' }),
                manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
                definition: { id: 'renderer', kind: 'declarative', root: { kind: 'text', text: 'Healthy' } },
            })),
            introspectionContributions: [channelsPluginId, triagePluginId].map((pluginId) => ({
                pluginId, pluginVersion: '1.2.3', source: 'bundled', family: 'ui.views',
                identity: { kind: 'localId', localId: pluginId === triagePluginId ? 'triage' : 'session-conversations-widget' },
                registration: 'notRequired', consumer: 'ui-view-host', platforms: ['web'],
            })),
        };

        const admittedProjection = buildPluginProjectionV2({ registry, generation: 7 });
        expect(admittedProjection.familiesById.pluginUi?.entriesById['surfacePlacement:happier.channels:session-conversations-widget'])
            .toMatchObject({ inputs: { fields: [{ path: 'session', required: true }] }, sessionInputPath: 'session' });
        const widget = uiViewsV2[0].definition;
        if (!('sessionInputPath' in widget)) throw new Error('Expected a Session widget fixture');
        // Isolate malformed routing from the real, consumed Session input declaration.
        widget.sessionInputPath = 'undeclared-session';
        const projection = buildPluginProjectionV2({ registry, generation: 7 });

        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        expect(entries['surfacePlacement:happier.channels:session-conversations-widget']).toBeUndefined();
        expect(entries['surfacePlacement:happier.channels:channels']).toMatchObject({ descriptorId: 'channels' });
        expect(entries['surfacePlacement:happier.triage:triage']).toMatchObject({ descriptorId: 'triage' });
        const healthyProjection = buildPluginProjectionV2({
            registry: { ...registry, uiViewsV2: uiViewsV2.slice(1) }, generation: 7,
        });
        for (const entryId of ['surfacePlacement:happier.channels:channels', 'surfacePlacement:happier.triage:triage']) {
            expect(entries[entryId]).toEqual(healthyProjection.familiesById.pluginUi?.entriesById[entryId]);
        }
        expect(projection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
            data: expect.objectContaining({
                code: 'plugin_compatibility_projection_invalid',
                severity: 'error',
                details: expect.objectContaining({
                    family: 'pluginUi',
                    entryId: 'surfacePlacement:happier.channels:session-conversations-widget',
                    issues: expect.arrayContaining([expect.objectContaining({ path: ['sessionInputPath'] })]),
                }),
            }),
            plugin: { id: channelsPluginId, version: '1.2.3', source: 'bundled' },
            contribution: { pluginId: channelsPluginId, localId: 'session-conversations-widget' },
            occurrenceId: channelsOccurrenceId,
            stage: 'normalization', host: 'daemon',
        })]));
    });

    it('stamps every UI entry with the exact current materialization rather than a coarse machine identity', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.materialized'),
            occurrenceIdsByPluginId: {
                'acme.materialized': 'materialized-occurrence-a',
            },
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'renderer' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Materialized' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'overview' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'overview',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Overview',
                },
            }],
        } as unknown as ResolvedContributionRegistry;
        const entryId = 'surfacePlacement:acme.materialized:overview';
        const project = (materializationId: string | undefined) => (
            buildPluginProjectionV2({
                registry,
                generation: 7,
                ...(materializationId
                    ? {
                        pluginExecutionOriginsByPluginId: {
                            'acme.materialized': {
                                serverIdentityId: 'srv_projection_fixture',
                                materializationRef: {
                                    machineId: 'machine_projection_fixture',
                                    materializationId,
                                    pluginId: 'acme.materialized',
                                },
                            },
                        },
                    }
                    : {}),
            } as Parameters<typeof buildPluginProjectionV2>[0])
                .familiesById.pluginUi?.entriesById[entryId]
        );

        expect(project(undefined)).not.toHaveProperty('materializationRef');
        expect(project('materialization-a')).toMatchObject({
            occurrenceId: 'materialized-occurrence-a',
            serverIdentityId: 'srv_projection_fixture',
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-a',
                pluginId: 'acme.materialized',
            },
        });
        expect(project('materialization-b')).toMatchObject({
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-b',
                pluginId: 'acme.materialized',
            },
        });
        expect(project('materialization-b')).not.toMatchObject({
            materializationRef: { materializationId: 'materialization-a' },
        });

        expect(buildPluginProjectionV2({
            registry: { ...registry, occurrenceIdsByPluginId: {} },
            generation: 7,
        }).familiesById.pluginUi?.entriesById[entryId]).toBeUndefined();
    });

    it('derives an openable-content viewer from its existing direct details destination', () => {
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'renderer' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: {
                id: 'renderer',
                kind: 'declarative',
                root: { kind: 'text', text: 'Viewer' },
            },
        } as const;
        const detailsView = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'file-details' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: PluginUiViewV2Schema.parse({
                id: 'file-details',
                container: 'detailsTab',
                target: { kind: 'session' },
                renderer: 'renderer',
                title: 'File',
            }),
        } satisfies ResolvedUiViewV2Contribution;
        const viewer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'markdown' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: PluginOpenableContentViewerContributionV1Schema.parse({
                id: 'markdown',
                destination: 'file-details',
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            }),
        } satisfies ResolvedOpenableContentViewerContribution;
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.viewer'),
            uiRenderersV2: [renderer],
            uiViewsV2: [detailsView],
            openableContentViewers: [viewer],
        } as unknown as ResolvedContributionRegistry;
        const viewerEntryId = 'openableContentViewer:acme.viewer:markdown';
        const origin = {
            serverIdentityId: 'srv_projection_fixture',
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-current',
                pluginId: 'acme.viewer',
            },
        } as const;
        const projected = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginExecutionOriginsByPluginId: { 'acme.viewer': origin },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(projected[viewerEntryId]).toMatchObject({
            pluginId: 'acme.viewer',
            contributionKind: 'openableContentViewer',
            descriptorId: 'markdown',
            identity: { pluginId: 'acme.viewer', localId: 'markdown' },
            viewer: {
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            },
            destination: { pluginId: 'acme.viewer', localId: 'file-details' },
            ...origin,
        });
        expect(projected[viewerEntryId]).not.toHaveProperty('path');
        expect(projected[viewerEntryId]).not.toHaveProperty('launchInput');

        const withoutDestination = buildPluginProjectionV2({
            registry: { ...registry, uiViewsV2: [] },
            generation: 7,
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(withoutDestination).not.toHaveProperty(viewerEntryId);

        const wrongContainerView = {
            ...detailsView,
            definition: PluginUiViewV2Schema.parse({
                ...detailsView.definition,
                container: 'rightPane',
            }),
        } satisfies ResolvedUiViewV2Contribution;
        const withWrongContainer = buildPluginProjectionV2({
            registry: {
                ...registry,
                uiViewsV2: [wrongContainerView],
            },
            generation: 7,
        }).familiesById.pluginUi?.entriesById ?? {};
        expect(withWrongContainer).not.toHaveProperty(viewerEntryId);

        const mismatchedViewer = {
            ...viewer,
            identity: { ...viewer.identity, localId: 'other' },
        } satisfies ResolvedOpenableContentViewerContribution;
        const withMismatchedIdentity = buildPluginProjectionV2({
            registry: {
                ...registry,
                openableContentViewers: [mismatchedViewer],
            },
            generation: 7,
        }).familiesById.pluginUi?.entriesById ?? {};
        expect(withMismatchedIdentity).not.toHaveProperty(viewerEntryId);
    });

    it('carries only the canonical Resource capability onto every V2 projected surface', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.generated-resource'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-resource',
                identity: { pluginId: 'acme.generated-resource', localId: 'renderer' },
                manifestPath: '/plugins/acme-generated/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Resource' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-resource',
                identity: { pluginId: 'acme.generated-resource', localId: 'generated-resource-surface' },
                manifestPath: '/plugins/acme-generated/.happier-plugin/plugin.json',
                definition: {
                    id: 'generated-resource-surface',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Resource',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                resourceCapabilityForPlugin: () => ({ readable: true, dynamic: false }),
            },
        }).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.generated-resource:generated-resource-surface'])
            .toMatchObject({ runtime: { resourceCapability: { readable: true, dynamic: false } } });
        expect(entries['surfacePlacement:acme.generated-resource:generated-resource-surface'])
            .not.toHaveProperty('runtime.resourceCapability.resourceIds');
    });

    it('projects normalized destination bindings and the declared settings-page destination', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.navigation'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'session-panel' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'session-panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Session panel',
                },
            }],
            uiSettingsGroupsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation',
                    title: 'Navigation',
                    icon: 'browser',
                    defaultRank: 12,
                },
            }],
            uiSettingsPagesV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-settings',
                    group: { kind: 'plugin', localId: 'navigation' },
                    title: 'Navigation settings',
                    keywords: ['navigation'],
                    renderer: 'renderer',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.navigation:session-panel']).toMatchObject({
            contributionKind: 'surfacePlacement',
            binding: {
                destination: { pluginId: 'acme.navigation', localId: 'session-panel' },
                renderer: { pluginId: 'acme.navigation', localId: 'renderer' },
                container: 'rightPane',
                target: { kind: 'session' },
                targetKind: 'session',
                instancePolicy: 'singleton',
                platforms: ['desktop', 'web'],
            },
        });
        expect(entries['surfacePlacement:acme.navigation:session-panel'])
            .not.toHaveProperty('binding.collisionDomain');
        expect(entries['surfacePlacement:acme.navigation:session-panel'])
            .not.toHaveProperty('binding.collisionKey');
        expect(entries['settingsGroup:acme.navigation:navigation']).toMatchObject({
            contributionKind: 'settingsGroup',
            group: {
                id: { pluginId: 'acme.navigation', localId: 'navigation' },
                title: 'Navigation',
                icon: 'browser',
                defaultRank: 12,
            },
        });
        expect(entries['settingsPage:acme.navigation:navigation-settings']).toMatchObject({
            contributionKind: 'settingsPage',
            page: {
                id: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                group: { kind: 'plugin', id: { pluginId: 'acme.navigation', localId: 'navigation' } },
                title: 'Navigation settings',
                keywords: ['navigation'],
            },
            binding: {
                destination: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                renderer: { pluginId: 'acme.navigation', localId: 'renderer' },
                container: 'settingsPage',
                target: { kind: 'app' },
                targetKind: 'app',
            },
        });
    });

    it('keeps tablet-capable destinations available for final native form-factor admission', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.tablet'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.tablet',
                identity: { pluginId: 'acme.tablet', localId: 'renderer' },
                manifestPath: '/plugins/acme-tablet/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Tablet' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.tablet',
                identity: { pluginId: 'acme.tablet', localId: 'panel' },
                manifestPath: '/plugins/acme-tablet/.happier-plugin/plugin.json',
                definition: {
                    id: 'panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Tablet panel',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({
            registry,
            generation: 1,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    hostRuntime: {
                        platform: 'ios',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0])
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.tablet:panel'];

        expect(entry).toMatchObject({
            binding: { platforms: ['desktop', 'web'] },
            availability: {
                state: 'fallback',
                reason: 'declarative_model_unavailable',
            },
        });
        expect(entry).not.toMatchObject({
            availability: { reason: 'destination_platform_unavailable' },
        });
    });

    it('qualifies app-page header actions at the compiled projection boundary', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.navigation'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    headerActions: [{
                        id: 'refresh',
                        title: 'Refresh',
                        command: { kind: 'executeAction', action: 'refresh-navigation' },
                    }],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:navigation-page'];

        expect(entry).toMatchObject({
            binding: {
                container: 'appPage',
                targetKind: 'app',
                surfaceContextPlacement: 'appSurface',
            },
            headerActions: [{
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.navigation', localId: 'refresh-navigation' },
                },
            }],
        });
        // The compiled entry carries the qualified semantic command only; the
        // retired `action` spelling must not survive anywhere on the wire.
        expect(entry).not.toHaveProperty('headerActions.0.action');
    });

    it('projects a destination placement and its independently gated page column renderer', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.navigation'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'column-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'column-renderer',
                    kind: 'hostedHtml',
                    source: { kind: 'html', html: '<p>Navigation</p>' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    title: { key: 'navigation.title', fallback: 'Navigation' },
                    icon: 'settings',
                    badge: {
                        label: { key: 'navigation.badge', fallback: 'Preview' },
                        tone: 'accent',
                    },
                    placement: { kind: 'column', column: 'sessions' },
                    column: { renderer: 'column-renderer' },
                    rankHint: -25,
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:navigation-page'];

        expect(entry).toMatchObject({
            display: {
                titleKey: 'navigation.title',
                developerFallback: 'Navigation',
                iconToken: 'settings',
                badge: {
                    labelKey: 'navigation.badge',
                    developerFallback: 'Preview',
                    tone: 'accent',
                },
                placement: { kind: 'column', column: 'sessions' },
                rankHint: -25,
            },
            column: {
                renderer: {
                    kind: 'hostedHtml',
                    contributionId: 'column-renderer',
                    source: { kind: 'html', html: '<p>Navigation</p>' },
                    requiredHostMethods: [],
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
        });
    });

    it('keeps authored literal destination presentation distinct from keyed localized presentation', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.navigation'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'literal-navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'literal-navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    title: 'Navigation',
                    badge: { label: 'Preview', tone: 'accent' },
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:literal-navigation-page'];

        expect(entry).toMatchObject({
            display: {
                title: 'Navigation',
                badge: { label: 'Preview', tone: 'accent' },
            },
        });
        expect(entry).not.toHaveProperty('display.titleKey');
        expect(entry).not.toHaveProperty('display.developerFallback');
        expect(entry).not.toHaveProperty('display.badge.labelKey');
        expect(entry).not.toHaveProperty('display.badge.developerFallback');
    });

    it('resolves duplicate V2 locales deterministically across contribution order', () => {
        const v2Translations = [
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/z.plugin.json',
                definition: { locale: 'en', messages: { title: 'Zulu V2' } },
            },
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/a.plugin.json',
                definition: { locale: 'en', messages: { title: 'Alpha V2' } },
            },
        ] as const;
        const project = (translations: readonly (typeof v2Translations)[number][]) => {
            const registry = {
                ...createEmptyResolvedContributionRegistry('acme.preview'),
                uiTranslationsV2: translations,
            } as unknown as ResolvedContributionRegistry;
            return buildPluginProjectionV2({ registry, generation: 1 })
                .familiesById.pluginUi?.entriesById['translations:acme.preview'];
        };

        const forward = project(v2Translations);
        const reversed = project([...v2Translations].reverse());

        expect(forward).toEqual(reversed);
        expect(forward).toMatchObject({
            bundles: { en: { title: 'Zulu V2' } },
            diagnostics: ['duplicate_translation_locale'],
        });
    });

    it('ships only the locales a client can read when the describe request names one', () => {
        const contributedLocales = ['en', 'fr', 'ja', 'ru'] as const;
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.preview'),
            uiTranslationsV2: contributedLocales.map((locale) => ({
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale },
                manifestPath: `/plugins/acme/${locale}.plugin.json`,
                definition: { locale, messages: { title: `title-${locale}` } },
            })),
        } as unknown as ResolvedContributionRegistry;

        const project = (requestedLocale?: string) => buildPluginProjectionV2({
            registry,
            generation: 1,
            ...(requestedLocale === undefined ? {} : { requestedLocale }),
        } as Parameters<typeof buildPluginProjectionV2>[0])
            .familiesById.pluginUi?.entriesById['translations:acme.preview'] as unknown as Readonly<{
                locales: readonly string[];
                bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
            }>;

        // The only reader (`resolvePluginUiTranslationBundle`) merges the preferred
        // locale over English and never touches another one, so nothing else belongs
        // on the wire.
        const narrowed = project('fr');
        expect(Object.keys(narrowed.bundles)).toEqual(['en', 'fr']);
        expect(narrowed.bundles).toEqual({
            en: { title: 'title-en' },
            fr: { title: 'title-fr' },
        });
        // `locales` stays the full availability fact; only the payload narrows.
        expect(narrowed.locales).toEqual(['en', 'fr', 'ja', 'ru']);

        // An English client needs exactly one bundle.
        expect(Object.keys(project('en').bundles)).toEqual(['en']);

        // A client that names no locale — an older one — still receives everything.
        expect(Object.keys(project().bundles)).toEqual(['en', 'fr', 'ja', 'ru']);
    });

    it('projects connected-account descriptors only through the canonical connectedAccounts family', async () => {
        const { resolveBuiltInContributions } = await import('../resolveBuiltInContributions');
        const builtIn = resolveBuiltInContributions();
        const registry = {
            ...createEmptyResolvedContributionRegistry('happier.scm.forge.bitbucket'),
            connectedAccountDescriptors: builtIn.connectedAccountDescriptors,
            scmHostingProviders: builtIn.scmHostingProviders,
        } as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {},
        } as Parameters<typeof buildPluginProjectionV2>[0]);

        expect(projection.familiesById.connectedAccounts?.entriesById['happier.scm.forge.bitbucket/bitbucket-account'])
            .toEqual(expect.objectContaining({
                id: 'bitbucket-account',
                serviceId: 'bitbucket',
                pluginId: 'happier.scm.forge.bitbucket',
                provenance: 'first_party',
                sourceKind: 'bundled',
                availability: { state: 'available', reason: 'resolved' },
                authentication: expect.objectContaining({
                    defaultModeId: 'manual',
                    modes: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'manual',
                            kind: 'manual',
                            fields: expect.arrayContaining([
                                expect.objectContaining({ id: 'token', secret: true }),
                            ]),
                        }),
                    ]),
                }),
            }));
        expect(projection.familiesById.pluginUi?.entriesById)
            .not.toHaveProperty('connectedAccountDescriptor:happier.scm.forge.bitbucket:bitbucket-account');
    });

    it('does not project host-private structured-message descriptors even when a registry contains one', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.preview'),
            structuredMessages: [
                {
                    pluginId: 'acme.preview',
                    definition: {
                        id: 'preview-card',
                        title: 'Preview',
                        kind: 'acme.preview/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: 'summary-card',
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 3,
            pluginUiHostRuntime: {
                structuredMessages: { featureEnabled: true },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(entries['structuredMessage:acme.preview:preview-card']).toBeUndefined();
    });

    it('projects transcript Activity descriptors as same-plugin qualified Resource and Action identities', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.preview'),
            transcriptActivities: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                identity: { pluginId: 'acme.preview', localId: 'outward-delivery' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'outward-delivery',
                    resourceId: 'outward-delivery-activities-v1',
                    actions: ['retry-delivery'],
                },
            }],
        } satisfies ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 9,
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['transcriptActivity:acme.preview:outward-delivery']).toEqual({
            id: 'transcriptActivity:acme.preview:outward-delivery',
            pluginId: 'acme.preview',
            occurrenceId: registry.occurrenceIdsByPluginId?.['acme.preview'],
            contributionKind: 'transcriptActivity',
            descriptorId: 'outward-delivery',
            resource: { pluginId: 'acme.preview', localId: 'outward-delivery-activities-v1' },
            actions: [{ pluginId: 'acme.preview', localId: 'retry-delivery' }],
        });
    });

    it('projects a search provider as identity plus its resolved qualified query Action', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.triage'),
            searchProviders: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.triage',
                identity: { pluginId: 'acme.triage', localId: 'entries' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: { id: 'entries', action: 'entries/search-v1' },
            }],
        } satisfies ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 9,
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        // Identity and one reference. Title, icon, availability and execution
        // target stay with the referenced Action's own projection.
        expect(entries['searchProvider:acme.triage:entries']).toEqual({
            id: 'searchProvider:acme.triage:entries',
            pluginId: 'acme.triage',
            occurrenceId: registry.occurrenceIdsByPluginId?.['acme.triage'],
            contributionKind: 'searchProvider',
            descriptorId: 'entries',
            identity: { pluginId: 'acme.triage', localId: 'entries' },
            action: { pluginId: 'acme.triage', localId: 'entries/search-v1' },
        });
    });

    it('keeps a search provider on its closed wire arm when its plugin has a machine execution origin', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.triage'),
            searchProviders: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.triage',
                identity: { pluginId: 'acme.triage', localId: 'entries' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: { id: 'entries', action: 'entries/search-v1' },
            }],
        } satisfies ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
            pluginExecutionOriginsByPluginId: {
                'acme.triage': {
                    serverIdentityId: 'srv_projection_fixture',
                    materializationRef: {
                        machineId: 'machine_projection_fixture',
                        materializationId: 'daemon-selected:acme.triage',
                        pluginId: 'acme.triage',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);

        // The execution origin is the referenced Action's own projected fact;
        // stamping it here makes every client reject the whole projection.
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        expect(projection.familiesById.pluginUi?.entriesById['searchProvider:acme.triage:entries'])
            .not.toHaveProperty('materializationRef');
    });

    it('projects a Session-info section through the canonical declarative model', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.preview'),
            sessionInfoSections: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'acme.preview', localId: 'overview' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'overview',
                    resourceId: 'session-overview',
                    order: 25,
                    actions: ['open-details'],
                    availability: {
                        when: { fact: 'session.exists', operator: 'equals', value: true },
                    },
                },
            }],
        } satisfies ResolvedContributionRegistry;
        const model = {
            identity: {
                pluginId: 'acme.preview',
                localId: 'session-info-overview',
                qualifiedId: 'acme.preview/session-info-overview',
                occurrenceId: '9',
            },
            visible: true,
            requiredHostMethods: ['context', 'executeAction', 'readResource', 'watchResource'],
            declarativeInventory: emptyDeclarativeInventory,
            root: {
                kind: 'state',
                path: 'root',
                order: 0,
                state: 'loading',
                title: 'Loading overview',
            },
        } satisfies StablePluginDeclarativeModel;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 9,
            pluginUiHostRuntime: {
                declarative: { modelsByRendererKey: { ['acme.preview\0session-info-overview']: model } },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['sessionInfoSection:acme.preview:overview']).toMatchObject({
            pluginId: 'acme.preview',
            pluginVersion: '1.0.0',
            contributionKind: 'sessionInfoSection',
            descriptorId: 'overview',
            order: 25,
            resource: { pluginId: 'acme.preview', localId: 'session-overview' },
            actions: [{ pluginId: 'acme.preview', localId: 'open-details' }],
            availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            },
            renderer: {
                kind: 'declarative',
                contributionId: 'session-info-overview',
                model,
                documentSource: { kind: 'resource', resourceId: 'session-overview' },
            },
            placement: {
                contributionKind: 'surfacePlacement',
                descriptorId: 'overview',
                // Outer section applicability is Session-owned. The physical
                // placement remains a valid admitted mount and receives the
                // exact Session policy context for inner renderer policies.
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                binding: expect.objectContaining({
                    kind: 'inline',
                    role: 'sessionInfoSection',
                    surface: { pluginId: 'acme.preview', localId: 'overview' },
                    target: { kind: 'session' },
                    targetKind: 'session',
                }),
            },
        });
    });

    it('rejects a duplicate V2 view id instead of selecting a projection-order survivor (DR-2)', () => {
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'renderer' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: 'renderer',
                kind: 'declarative',
                root: { kind: 'text', text: 'Review' },
            },
        };
        const makeView = (title: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'dupe-panel' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: 'dupe-panel',
                container: 'servicesPanel',
                target: { kind: 'services' },
                renderer: 'renderer',
                title,
                headerActions: [],
                fallbackRenderers: [],
            },
        });
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.review'),
            uiRenderersV2: [renderer],
            uiViewsV2: [makeView('First'), makeView('Second')],
        } as unknown as ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({ registry, generation: 9 }))
            .toThrow("Duplicate projected plugin UI contribution 'surfacePlacement:acme.review:dupe-panel'");
    });

    it('projects every V2 view through the canonical surface-placement family and adopts the first admitted renderer fallback', () => {
        const generatedArtifact = {
            artifactId: 'panel-artifact',
            tier: 'reactNative' as const,
            entry: 'react-native/panel-artifact/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/panel-artifact/entry.cjs.bundle',
                digest: `sha256:${'3'.repeat(64)}`,
                byteSize: 12,
            }],
            digest: `sha256:${'1'.repeat(64)}`,
            builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
            executable: { exports: ['renderSurface'] },
            hostUiApiRange: '^1.0.0',
        };
        const generatedHostedArtifact = {
            artifactId: 'hosted-artifact',
            tier: 'hostedWeb' as const,
            entry: 'hosted-web/hosted-artifact/index.html',
            files: [
                {
                    relativePath: 'hosted-web/hosted-artifact/index.html',
                    digest: `sha256:${'5'.repeat(64)}`,
                    byteSize: 13,
                },
                {
                    relativePath: 'hosted-web/hosted-artifact/assets/index.js',
                    digest: `sha256:${'6'.repeat(64)}`,
                    byteSize: 14,
                },
            ],
            digest: `sha256:${'4'.repeat(64)}`,
            builtWith: { staging: 'staticDirectory' as const },
            hostUiApiRange: '^1.0.0',
        };
        const stableDeclarativeModel = {
            identity: {
                pluginId: 'acme.generated-rnw',
                localId: 'declarative-renderer',
                qualifiedId: 'acme.generated-rnw/declarative-renderer',
                occurrenceId: '31',
            },
            visible: true,
            requiredHostMethods: ['context', 'executeAction'],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Generated status' },
        } satisfies StablePluginDeclarativeModel;
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.generated-rnw'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'panel-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 2 as const,
                    entries: [generatedArtifact],
                },
                definition: {
                    id: 'panel-renderer',
                    kind: 'reactNative',
                    artifact: 'panel-artifact',
                    requiredHostMethods: ['context', 'watchContext'],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'declarative-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'declarative-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Generated status' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 2 as const,
                    entries: [generatedHostedArtifact],
                },
                definition: {
                    id: 'hosted-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'hosted-artifact' },
                    requiredHostMethods: ['context'],
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'panel' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'panel-renderer',
                    title: 'Generated panel',
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'declarative-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'declarative-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'declarative-renderer',
                    title: { key: 'settings.title', fallback: 'Generated settings' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'hosted-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'hosted-renderer',
                    fallbackRenderers: ['panel-renderer'],
                    title: 'Generated hosted panel',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: {
                    featureEnabled: true,
                    frameCapability: {
                        platform: 'web',
                        adapter: 'domIframe',
                    },
                },
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
                declarative: {
                    modelsByRendererKey: {
                        ['acme.generated-rnw\0declarative-renderer']: stableDeclarativeModel,
                    },
                },
            },
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        const reactNativeEntry = entries['reactNativeBundle:acme.generated-rnw:panel-renderer'];
        expect(reactNativeEntry).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'reactNativeBundle',
            contributionId: 'panel-renderer',
            artifactSelectionOwner: 'daemonProjection',
            artifactGraph: generatedArtifact,
            requiredHostMethods: ['context', 'watchContext'],
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                cacheIdentity: {
                    artifactDigest: generatedArtifact.digest,
                },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
        if (!reactNativeEntry || !('artifactGraph' in reactNativeEntry)) {
            throw new Error('React Native projection omitted its artifact graph');
        }
        expect(reactNativeEntry?.artifactGraph).toEqual(generatedArtifact);
        expect(entries['surfacePlacement:acme.generated-rnw:panel']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'panel',
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
            }),
            renderer: { kind: 'reactNative', contributionId: 'panel-renderer' },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:declarative-view']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'declarative-view',
            generatedV2: true,
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
            }),
            display: { titleKey: 'settings.title', developerFallback: 'Generated settings' },
            renderer: {
                kind: 'declarative',
                contributionId: 'declarative-renderer',
                model: stableDeclarativeModel,
            },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:declarative-view']).not.toHaveProperty('order');
        expect(entries['surfacePlacement:acme.generated-rnw:hosted-view']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'hosted-view',
            generatedV2: true,
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
                rendererChain: [
                    { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
                    { pluginId: 'acme.generated-rnw', localId: 'panel-renderer' },
                ],
                renderer: { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
            }),
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'hosted-renderer',
            },
            availability: {
                state: 'available',
                reason: 'available',
            },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:hosted-view'])
            .not.toHaveProperty('fallbackRenderers');
        const hostedWebEntry = entries['hostedWeb:acme.generated-rnw:hosted-renderer'];
        expect(hostedWebEntry).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'hostedWeb',
            contributionId: 'hosted-renderer',
            artifactSelectionOwner: 'daemonProjection',
            generatedV2: true,
            bridge: { allowedMessages: ['ready', 'hostApi'] },
            entry: { routeMode: 'pathFallback', path: '/' },
            runtime: {
                state: 'available',
                diagnostics: [],
                artifactReadIdentity: {
                    artifactDigest: generatedHostedArtifact.digest,
                },
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        });
        expect(hostedWebEntry).not.toHaveProperty('runtimeMode');
        if (!hostedWebEntry || !('artifactGraph' in hostedWebEntry)) {
            throw new Error('Hosted-Web projection omitted its artifact graph');
        }
        expect(hostedWebEntry?.artifactGraph).toEqual(generatedHostedArtifact);

        const portableProjection = buildPluginProjectionV2({
            registry: {
                ...registry,
                uiRenderersV2: registry.uiRenderersV2?.map((renderer) => ({
                    ...renderer,
                    source: { kind: 'archive' as const },
                })),
                immutableGenerationIdsByPluginId: {
                    'acme.generated-rnw': 'managed-generation-a',
                },
            },
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: {
                    featureEnabled: true,
                    frameCapability: { platform: 'web', adapter: 'domIframe' },
                },
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
            },
        });
        expect(portableProjection.familiesById.pluginUi?.entriesById[
            'reactNativeBundle:acme.generated-rnw:panel-renderer'
        ]).toMatchObject({ artifactSelectionOwner: 'accountRelease' });

        const bundledProjection = buildPluginProjectionV2({
            registry: {
                ...registry,
                uiRenderersV2: registry.uiRenderersV2?.map((renderer) => ({
                    ...renderer,
                    provenance: 'first_party' as const,
                    source: { kind: 'bundled' as const },
                })),
                // Bundled runtime registries also have immutable generations;
                // source custody, not generation presence, owns selection.
                immutableGenerationIdsByPluginId: {
                    'acme.generated-rnw': 'bundled-generation-a',
                },
            },
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: {
                    featureEnabled: true,
                    frameCapability: { platform: 'web', adapter: 'domIframe' },
                },
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
            },
        });
        expect(bundledProjection.familiesById.pluginUi?.entriesById[
            'reactNativeBundle:acme.generated-rnw:panel-renderer'
        ]).toMatchObject({ artifactSelectionOwner: 'daemonProjection' });

        // A missing physical frame fact does not leave a renderer-local
        // unavailable terminal. The canonical surface-placement selector
        // consumes the hosted renderer's fallback decision and adopts the
        // next declared renderer in its existing chain.
        const adapterUnavailableProjection = buildPluginProjectionV2({
            registry,
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: { featureEnabled: true },
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
                declarative: {
                    modelsByRendererKey: {
                        ['acme.generated-rnw\0declarative-renderer']: stableDeclarativeModel,
                    },
                },
            },
        });
        const adapterUnavailableEntries = adapterUnavailableProjection.familiesById.pluginUi?.entriesById ?? {};

        expect(adapterUnavailableEntries['hostedWeb:acme.generated-rnw:hosted-renderer']).toMatchObject({
            runtime: {
                state: 'fallback',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                decision: {
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                },
            },
        });
        expect(adapterUnavailableEntries['surfacePlacement:acme.generated-rnw:hosted-view']).toMatchObject({
            renderer: { kind: 'reactNative', contributionId: 'panel-renderer' },
            availability: { state: 'available', reason: 'available' },
        });
    });

    it('owns declarative availability only in the evaluated-model path', () => {
        const declarativeRenderer = (localId: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.declarative',
            identity: { pluginId: 'acme.declarative', localId },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: localId,
                kind: 'declarative',
                root: { kind: 'text', text: 'Status' },
                requiredHostMethods: ['context'],
            },
        });
        const declarativeView = (localId: string, renderer: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.declarative',
            identity: { pluginId: 'acme.declarative', localId },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: localId,
                container: 'rightPane',
                target: { kind: 'session' },
                renderer,
                title: 'Declarative',
            },
        });
        const model = (visible: boolean, localId: string) => ({
            identity: {
                pluginId: 'acme.declarative',
                localId,
                qualifiedId: `acme.declarative/${localId}`,
                occurrenceId: '7',
            },
            visible,
            requiredHostMethods: ['context'],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Status' },
        } satisfies StablePluginDeclarativeModel);
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.declarative'),
            uiRenderersV2: [
                declarativeRenderer('visible-renderer'),
                declarativeRenderer('hidden-renderer'),
                declarativeRenderer('modelless-renderer'),
            ],
            uiViewsV2: [
                declarativeView('visible-view', 'visible-renderer'),
                declarativeView('hidden-view', 'hidden-renderer'),
                declarativeView('modelless-view', 'modelless-renderer'),
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                declarative: {
                    modelsByRendererKey: {
                        ['acme.declarative\0visible-renderer']: model(true, 'visible-renderer'),
                        ['acme.declarative\0hidden-renderer']: model(false, 'hidden-renderer'),
                    },
                },
            },
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        const visibleEntry = entries['surfacePlacement:acme.declarative:visible-view'];
        const hiddenEntry = entries['surfacePlacement:acme.declarative:hidden-view'];
        const modellessEntry = entries['surfacePlacement:acme.declarative:modelless-view'];
        if (
            !visibleEntry || !('availability' in visibleEntry)
            || !hiddenEntry || !('availability' in hiddenEntry)
            || !modellessEntry || !('availability' in modellessEntry)
        ) {
            throw new Error('Surface-placement projection omitted availability');
        }

        expect(visibleEntry?.availability)
            .toMatchObject({ state: 'available', reason: 'available' });
        expect(hiddenEntry?.availability)
            .toMatchObject({ state: 'fallback', reason: 'declarative_model_hidden' });
        expect(modellessEntry?.availability)
            .toMatchObject({ state: 'fallback', reason: 'declarative_model_unavailable' });

        // The generic renderer-availability projector must not carry a second declarative
        // decision: it schema-parses through the strict v1 renderer union, which has no
        // declarative member, so any declarative branch there is unreachable and wrong.
        const source = readFileSync(new URL('./projection.ts', import.meta.url), 'utf8');
        const start = source.indexOf('function projectSurfaceAvailability');
        expect(start).toBeGreaterThan(-1);
        const end = source.indexOf('\n}\n', start);
        expect(end).toBeGreaterThan(start);
        expect(source.slice(start, end)).not.toContain('declarative');
    });

    it('projects a declarative document source beside its evaluated static model', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.declarative'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.declarative',
                identity: { pluginId: 'acme.declarative', localId: 'dashboard' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Static dashboard' },
                    documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.declarative',
                identity: { pluginId: 'acme.declarative', localId: 'dashboard-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'dashboard',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;
        const model = {
            identity: {
                pluginId: 'acme.declarative',
                localId: 'dashboard',
                qualifiedId: 'acme.declarative/dashboard',
                occurrenceId: '7',
            },
            visible: true,
            requiredHostMethods: [],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Static dashboard' },
        } satisfies StablePluginDeclarativeModel;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                declarative: {
                    modelsByRendererKey: {
                        ['acme.declarative\0dashboard']: model,
                    },
                },
            },
        });
        const entry = projection.familiesById.pluginUi?.entriesById[
            'surfacePlacement:acme.declarative:dashboard-view'
        ];

        expect(entry).toMatchObject({
            renderer: {
                kind: 'declarative',
                contributionId: 'dashboard',
                documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
                model,
            },
        });
    });

    it('projects a Voice provider client from its canonical generated artifact graph without a UI renderer', () => {
        const generatedArtifact = {
            artifactId: 'voice-runtime-web',
            tier: 'reactNative' as const,
            entry: 'react-native/voice-runtime-web/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/voice-runtime-web/entry.cjs.bundle',
                digest: `sha256:${'4'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'3'.repeat(64)}`,
            builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
            executable: { exports: ['activate'] },
            hostUiApiRange: '^1.0.0',
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.generated-voice'),
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId: 'acme.generated-voice',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'acme.generated-voice', localId: 'conversation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 2 as const, entries: [generatedArtifact] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['web'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                    },
                    client: {
                        artifactId: generatedArtifact.artifactId,
                        exportName: 'activate',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 33,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['reactNativeBundle:acme.generated-voice:conversation']).toMatchObject({
            pluginId: 'acme.generated-voice',
            contributionKind: 'reactNativeBundle',
            contributionId: 'conversation',
            artifactGraph: generatedArtifact,
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                cacheIdentity: {
                    artifactDigest: generatedArtifact.digest,
                },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
        expect(Object.keys(entries).some((id) => id.startsWith('uiArtifact:acme.generated-voice:'))).toBe(false);
    });

    it('projects a client Action under its own identity without borrowing a co-resident Voice Artifact', () => {
        const pluginId = 'acme.generated-client-action';
        const actionId = 'open-preview';
        const actionArtifact = {
            artifactId: 'open-preview-artifact',
            tier: 'reactNative' as const,
            entry: 'react-native/open-preview-artifact/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/open-preview-artifact/entry.cjs.bundle',
                digest: `sha256:${'5'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'6'.repeat(64)}`,
            builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
            executable: { exports: ['activate'] },
            hostUiApiRange: '^1.0.0',
        };
        const voiceArtifact = {
            artifactId: 'voice-artifact',
            tier: 'reactNative' as const,
            entry: 'react-native/voice-artifact/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/voice-artifact/entry.cjs.bundle',
                digest: `sha256:${'7'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'8'.repeat(64)}`,
            builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
            executable: { exports: ['activate'] },
            hostUiApiRange: '^1.0.0',
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(pluginId),
            actions: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId,
                pluginVersion: '1.0.0',
                identity: { pluginId, localId: actionId },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 2 as const, entries: [actionArtifact] },
                definition: {
                    kindVersion: 1,
                    id: actionId,
                    title: 'Open preview',
                    description: null,
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
                        api: false,
                        plugin: false,
                    },
                    inputHints: null,
                    inputSchema: {},
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: actionArtifact.artifactId,
                            exportName: 'activate',
                        },
                        platforms: ['ios'],
                    },
                    scopes: ['session'],
                    contributionSurfaces: ['ui'],
                    placementBindings: ['detailsPanel'],
                    dangerLevel: 'safe',
                },
            }],
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId,
                pluginVersion: '1.0.0',
                identity: { pluginId, localId: 'conversation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 2 as const, entries: [voiceArtifact] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['ios'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                    },
                    client: {
                        artifactId: voiceArtifact.artifactId,
                        exportName: 'activate',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 34,
            pluginExecutionOriginsByPluginId: {
                [pluginId]: {
                    serverIdentityId: 'srv_client_action',
                    materializationRef: {
                        machineId: 'machine_client_action',
                        materializationId: 'client-action-materialization',
                        pluginId,
                    },
                },
            },
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'ios',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        const actionEntry = entries[`reactNativeBundle:${pluginId}:${actionId}`];

        expect(actionEntry).toMatchObject({
            pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: actionId,
            generatedOwnerKind: 'clientContribution',
            artifactGraph: actionArtifact,
            entry: {
                exportName: 'activate',
            },
            runtime: {
                state: 'loadable',
                cacheIdentity: {
                    artifactDigest: actionArtifact.digest,
                },
            },
            serverIdentityId: 'srv_client_action',
            materializationRef: {
                machineId: 'machine_client_action',
                materializationId: 'client-action-materialization',
                pluginId,
            },
        });
        expect(actionEntry).not.toMatchObject({
            artifactGraph: { artifactId: voiceArtifact.artifactId },
        });
    });

    it('projects a V2-owned generated native renderer directly without reviving legacy artifact rows', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry('acme.preview'),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                identity: { pluginId: 'acme.preview', localId: 'native-preview' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 2 as const,
                    entries: [{
                        artifactId: 'native-artifact',
                        tier: 'reactNative' as const,
                        entry: 'react-native/native-artifact/entry.cjs.bundle',
                        files: [{
                            relativePath: 'react-native/native-artifact/entry.cjs.bundle',
                            digest: `sha256:${'4'.repeat(64)}`,
                            byteSize: 1,
                        }],
                        digest: `sha256:${'2'.repeat(64)}`,
                        builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
                        executable: { exports: ['renderSurface'] },
                        hostUiApiRange: '^1.0.0',
                    }],
                },
                definition: {
                    id: 'native-preview',
                    kind: 'reactNative',
                    artifact: 'native-artifact',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 32,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    hostRuntime: {
                        platform: 'ios',
                        channel: 'internal',
                        hostUiApiVersion: '1.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById[
            'reactNativeBundle:acme.preview:native-preview'
        ];

        expect(entry).toMatchObject({
            contributionKind: 'reactNativeBundle',
            contributionId: 'native-preview',
            artifactGraph: expect.objectContaining({
                artifactId: 'native-artifact',
                builtWith: { bundler: 'esbuild', version: '0.25.0' },
                executable: { exports: ['renderSurface'] },
            }),
            runtime: {
                state: 'loadable',
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
                cacheIdentity: expect.objectContaining({
                    artifactDigest: `sha256:${'2'.repeat(64)}`,
                }),
            },
        });
        expect(entry).not.toHaveProperty('bundle');
    });
});

describe('embedded widget projection', () => {
    const makeRegistry = (
        container: string,
        targetKind: 'session' | 'app' = 'session',
        homeDefault?: 'shown' | 'available',
        inputs?: { fields: { path: string; title: string; widget: 'json'; required: true }[] },
    ) => {
        const sessionInputs = container === 'widget' && targetKind === 'session'
            ? inputs ?? { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true as const }] }
            : undefined;
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            pluginVersion: '1.0.0',
            identity: { pluginId: 'acme.review', localId: 'review-native' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: { id: 'review-native', kind: 'declarative', root: { kind: 'text', text: 'Review' } },
        };
        const view = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            pluginVersion: '1.0.0',
            identity: { pluginId: 'acme.review', localId: 'review-status-widget' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: PluginUiViewV2Schema.parse({
                id: 'review-status-widget',
                container,
                target: { kind: targetKind },
                renderer: 'review-native',
                title: 'Review status',
                ...(homeDefault ? { home: { default: homeDefault } } : {}),
                ...(sessionInputs ? { inputs: sessionInputs, inputSchema: { type: 'object', properties: { session: { type: 'object' } }, required: ['session'], additionalProperties: false }, sessionInputPath: 'session' } : {}),
            }),
        };
        return {
            ...createEmptyResolvedContributionRegistry('acme.review'),
            uiRenderersV2: [renderer],
            uiViewsV2: [view],
        } as unknown as ResolvedContributionRegistry;
    };

    it('classifies a Registry inline role as an inline binding without a hardcoded role pair test', () => {
        const entries = buildPluginProjectionV2({ registry: makeRegistry('widget'), generation: 9 })
            .familiesById.pluginUi?.entriesById ?? {};
        const entry = entries['surfacePlacement:acme.review:review-status-widget'];
        expect(entry).toMatchObject({
            contributionKind: 'surfacePlacement',
            descriptorId: 'review-status-widget',
            target: { kind: 'session' },
            binding: expect.objectContaining({
                kind: 'inline',
                role: 'widget',
                surface: { pluginId: 'acme.review', localId: 'review-status-widget' },
                targetKind: 'session',
                surfaceContextPlacement: 'sessionPane',
            }),
        });
        // Destination-only projection metadata must stay absent for an inline role.
        expect(entry).not.toHaveProperty('container');
        expect(entry).not.toHaveProperty('rightSidebar');
        expect(entry).not.toHaveProperty('headerActions');
    });

    it('carries neutral widget inputs and exact Session field routing into its closed host projection', () => {
        const inputs = { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true as const }] };
        const projection = buildPluginProjectionV2({ registry: makeRegistry('widget', 'session', undefined, inputs), generation: 9 });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        expect(entries['surfacePlacement:acme.review:review-status-widget']).toMatchObject({
            inputs, sessionInputPath: 'session',
        });
        expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);
        const entry = entries['surfacePlacement:acme.review:review-status-widget']!;
        const withPlacements = (placements: readonly string[]) => ({
            ...projection,
            familiesById: { ...projection.familiesById, pluginUi: {
                ...projection.familiesById.pluginUi,
                entriesById: { ...entries, [entry.id]: { ...entry, placements } },
            } },
        });
        expect(PluginProjectionV2Schema.safeParse(withPlacements(['home'])).success).toBe(false);
        expect(PluginProjectionV2Schema.safeParse(withPlacements(['arbitrary-host'])).success).toBe(false);
    });

    it('projects the App widget Home default beside its App binding', () => {
        const entries = buildPluginProjectionV2({ registry: makeRegistry('widget', 'app', 'shown'), generation: 9 })
            .familiesById.pluginUi?.entriesById ?? {};
        expect(entries['surfacePlacement:acme.review:review-status-widget']).toMatchObject({
            binding: { kind: 'inline', role: 'widget', targetKind: 'app', surfaceContextPlacement: 'appSurface' },
            home: { default: 'shown' },
        });
        const omitted = buildPluginProjectionV2({ registry: makeRegistry('widget', 'app'), generation: 9 })
            .familiesById.pluginUi?.entriesById ?? {};
        expect(omitted['surfacePlacement:acme.review:review-status-widget']).toMatchObject({
            home: { default: 'available' },
        });
    });

    it('keeps every incumbent authored inline role on the same classification branch', () => {
        for (const container of ['sessionSubagentLaunch', 'sessionSubagentDetails'] as const) {
            const entries = buildPluginProjectionV2({ registry: makeRegistry(container), generation: 9 })
                .familiesById.pluginUi?.entriesById ?? {};
            expect(entries['surfacePlacement:acme.review:review-status-widget'])
                .toMatchObject({ binding: expect.objectContaining({ kind: 'inline', role: container }) });
        }
    });
});
