import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';
import {
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiInlineSurfaceBindingV1,
    PluginUiDestinationBindingV1Schema,
    type PluginUiDestinationBindingInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { normalizePluginUiProjection } from './projection';
import {
    selectPluginRightSidebarTabPlacements,
    selectPluginInlineSurfacePlacementsBySurface,
    selectPluginInlineSurfacePlacementsForRole,
    selectRenderablePluginInlineSurfacePlacementsForRole,
    selectPluginSessionDetailsTabPlacement,
    selectPluginSurfacePlacementsForBinding,
    selectRenderablePluginRightSidebarTabPlacements,
    selectRenderablePluginSurfacePlacementsForBinding,
} from './surfacePlacementSelectors';

type PluginUiProjectedEntry = NonNullable<PluginProjectionV2['familiesById']['pluginUi']>['entriesById'][string];

function binding(input: PluginUiDestinationBindingInputV1) {
    const normalized = normalizePluginUiDestinationBindingV1(input);
    if (!normalized) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    return PluginUiDestinationBindingV1Schema.parse(normalized);
}

function placement(input: Readonly<{
    localId: string;
    rendererId: string;
    container: PluginUiDestinationBindingInputV1['container'];
    target: PluginUiDestinationBindingInputV1['target'];
    /** Deliberately stale input: V2 has no surface-placement order field. */
    legacyOrder?: number;
    availability?: Readonly<{ state: 'available' | 'fallback' | 'blocked' | 'disabled'; reason: string; diagnostics: readonly string[] }>;
    featureGate?: string;
}>): PluginUiProjectedEntry {
    const normalizedBinding = binding({
        pluginId: 'acme.preview',
        destinationId: input.localId,
        rendererId: input.rendererId,
        container: input.container,
        target: input.target,
    });
    return {
        id: `surfacePlacement:acme.preview:${input.localId}`,
        pluginId: 'acme.preview',
        occurrenceId: `preview-${input.localId}-occurrence`,
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        binding: normalizedBinding,
        target: normalizedBinding.target,
        renderer: { kind: 'declarative', contributionId: input.rendererId },
        display: { titleKey: 'title' },
        ...(input.legacyOrder === undefined ? {} : { order: input.legacyOrder }),
        availability: {
            ...(input.availability ?? { state: 'available', reason: 'available', diagnostics: [] }),
            ...(input.featureGate === undefined ? {} : {
                when: { fact: 'host.feature', operator: 'enabled', value: input.featureGate },
            }),
        },
    };
}

describe('plugin surface placement selectors', () => {
    it('rejects an unqualified Session-details resource identity instead of appointing a plugin', () => {
        const firstBinding = binding({
            pluginId: 'acme.one',
            destinationId: 'inspect',
            rendererId: 'inspect-renderer',
            container: 'detailsTab',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        const model = normalizePluginUiProjection({
            v: 2,
            generation: 12,
            installedPackagesById: {},
            agentsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        'surfacePlacement:acme.one:inspect': {
                            id: 'surfacePlacement:acme.one:inspect',
                            pluginId: 'acme.one',
                            occurrenceId: 'acme-one-inspect-occurrence',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'inspect',
                            binding: firstBinding,
                            target: firstBinding.target,
                            renderer: { kind: 'declarative', contributionId: 'inspect-renderer' },
                            display: { titleKey: 'inspect' },
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                    },
                },
            },
            diagnostics: [],
        });

        expect(selectPluginSessionDetailsTabPlacement(model, 'inspect')).toBeNull();
        expect(selectPluginSessionDetailsTabPlacement(model, {
            pluginId: 'acme.one',
            localId: 'inspect',
        })).toMatchObject({
            id: 'surfacePlacement:acme.one:inspect',
        });
    });

    it('selects admitted bindings by their host-owned slot in deterministic order', () => {
        const projection: PluginProjectionV2 = {
            v: 2,
            generation: 12,
            installedPackagesById: {},
            agentsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        'surfacePlacement:acme.preview:details-late': placement({
                            localId: 'details-late', rendererId: 'details-late', container: 'detailsTab',
                            // A retained raw-order reader would put this one first.
                            target: { kind: 'session', sessionIdPath: '/session/id' }, legacyOrder: 0,
                        }),
                        'surfacePlacement:acme.preview:browser-panel': placement({
                            localId: 'browser-panel', rendererId: 'browser-panel', container: 'browserPanel',
                            target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
                        }),
                        'surfacePlacement:acme.preview:details-early': placement({
                            localId: 'details-early', rendererId: 'details-early', container: 'detailsTab',
                            target: { kind: 'session', sessionIdPath: '/session/id' }, legacyOrder: 100,
                        }),
                        'surfacePlacement:acme.preview:settings': placement({
                            localId: 'settings', rendererId: 'settings', container: 'settingsPage',
                            target: { kind: 'app' }, featureGate: 'plugins.ui.settingsPage',
                        }),
                        'surfacePlacement:acme.preview:settings-blocked': placement({
                            localId: 'settings-blocked', rendererId: 'settings-blocked', container: 'settingsPage',
                            target: { kind: 'app' },
                            availability: { state: 'blocked', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                        }),
                        'surfacePlacement:acme.preview:session-review': placement({
                            localId: 'session-review', rendererId: 'session-review', container: 'rightSidebarTab',
                            target: { kind: 'session', sessionIdPath: '/session/id' },
                        }),
                        'surfacePlacement:acme.preview:session-review-deferred': placement({
                            localId: 'session-review-deferred', rendererId: 'session-review-deferred', container: 'rightSidebarTab',
                            target: { kind: 'session', sessionIdPath: '/session/id' },
                        }),
                        'surfacePlacement:acme.preview:project-review-unavailable': placement({
                            localId: 'project-review-unavailable', rendererId: 'project-review', container: 'rightSidebarTab',
                            target: { kind: 'project', projectIdPath: '/project/id' },
                            availability: {
                                state: 'disabled',
                                reason: 'plugin_destination_collision',
                                diagnostics: ['plugin_destination_collision'],
                            },
                        }),
                        'surfacePlacement:acme.preview:service-inspector': placement({
                            localId: 'service-inspector', rendererId: 'service-inspector', container: 'servicesPanel',
                            target: { kind: 'services', machineIdPath: '/machine/id', serverIdPath: '/server/id' },
                        }),
                    },
                },
            },
            diagnostics: [],
        };
        const model = normalizePluginUiProjection(projection);

        expect(selectPluginSurfacePlacementsForBinding(model, {
            container: 'detailsTab', targetKind: 'session',
        }).map((entry) => entry.descriptorId)).toEqual(['details-early', 'details-late']);
        expect(selectPluginSurfacePlacementsForBinding(model, {
            container: 'browserPanel', targetKind: 'browser',
        }).map((entry) => entry.descriptorId)).toEqual(['browser-panel']);
        expect(selectPluginSurfacePlacementsForBinding(model, {
            container: 'settingsPage', targetKind: 'app',
        }).map((entry) => entry.descriptorId)).toEqual(['settings', 'settings-blocked']);
        expect(selectPluginRightSidebarTabPlacements(model, 'session').map((entry) => entry.descriptorId)).toEqual([
            'session-review',
            'session-review-deferred',
        ]);
        expect(selectRenderablePluginRightSidebarTabPlacements(model, 'session').map((entry) => entry.descriptorId)).toEqual([
            'session-review',
            'session-review-deferred',
        ]);
        expect(selectRenderablePluginRightSidebarTabPlacements(model, 'project')).toEqual([]);
        expect(selectRenderablePluginSurfacePlacementsForBinding(model, {
            container: 'settingsPage', targetKind: 'app',
        }, {
            isFeatureEnabled: (featureId) => featureId === 'plugins.ui.settingsPage',
        }).map((entry) => entry.descriptorId)).toEqual(['settings']);
        expect(selectRenderablePluginSurfacePlacementsForBinding(model, {
            container: 'settingsPage', targetKind: 'app',
        }, {
            isFeatureEnabled: () => false,
        })).toEqual([]);
        expect(selectRenderablePluginSurfacePlacementsForBinding(model, {
            container: 'servicesPanel', targetKind: 'services',
        }).map((entry) => entry.descriptorId)).toEqual(['service-inspector']);
    });
});

describe('embedded Session widget picker inventory', () => {
    function inlinePlacement(input: Readonly<{
        pluginId: string;
        localId: string;
        role: 'widget' | 'sessionSubagentDetails';
        availability?: Readonly<{ state: 'available' | 'fallback' | 'blocked' | 'disabled'; reason: string; diagnostics: readonly string[] }>;
    }>): PluginUiProjectedEntry {
        const normalized = normalizePluginUiInlineSurfaceBindingV1({
            pluginId: input.pluginId,
            surfaceId: input.localId,
            rendererId: 'review-native',
            role: input.role,
            target: { kind: 'session' },
        });
        if (!normalized) throw new Error('test fixture must use an admitted inline binding');
        return {
            id: `surfacePlacement:${input.pluginId}:${input.localId}`,
            pluginId: input.pluginId,
            occurrenceId: `${input.pluginId}-${input.localId}-occurrence`,
            contributionKind: 'surfacePlacement',
            descriptorId: input.localId,
            binding: normalized,
            target: normalized.target,
            renderer: { kind: 'declarative', contributionId: 'review-native' },
            display: { title: input.localId },
            availability: input.availability ?? { state: 'available', reason: 'available', diagnostics: [] },
        } as unknown as PluginUiProjectedEntry;
    }

    const model = normalizePluginUiProjection({
        v: 2,
        generation: 1,
        installedPackagesById: {},
        actionsById: {},
        familiesById: {
            pluginUi: {
                entriesById: {
                    'surfacePlacement:acme.review:review-status-widget':
                        inlinePlacement({ pluginId: 'acme.review', localId: 'review-status-widget', role: 'widget' }),
                    'surfacePlacement:acme.ci:build-health':
                        inlinePlacement({ pluginId: 'acme.ci', localId: 'build-health', role: 'widget' }),
                    'surfacePlacement:acme.ci:blocked-widget': inlinePlacement({
                        pluginId: 'acme.ci',
                        localId: 'blocked-widget',
                        role: 'widget',
                        availability: { state: 'blocked', reason: 'entry_missing', diagnostics: ['entry_missing'] },
                    }),
                    'surfacePlacement:acme.review:review-subagent-details':
                        inlinePlacement({ pluginId: 'acme.review', localId: 'review-subagent-details', role: 'sessionSubagentDetails' }),
                    'surfacePlacement:acme.preview:details': placement({
                        localId: 'details', rendererId: 'r', container: 'detailsTab', target: { kind: 'session' },
                    }),
                },
            },
        },
    } as unknown as PluginProjectionV2);

    it('inventories every projected widget placement and excludes other roles and destinations', () => {
        expect(selectPluginInlineSurfacePlacementsForRole(model, 'widget')
            .map((entry) => `${entry.pluginId}:${entry.descriptorId}`)).toEqual([
            'acme.ci:blocked-widget',
            'acme.ci:build-health',
            'acme.review:review-status-widget',
        ]);
    });

    it('offers only currently renderable widgets as new-creation candidates', () => {
        expect(selectRenderablePluginInlineSurfacePlacementsForRole(model, 'widget')
            .map((entry) => `${entry.pluginId}:${entry.descriptorId}`)).toEqual([
            'acme.ci:build-health',
            'acme.review:review-status-widget',
        ]);
    });

    it('resolves one exact stored reference and fails closed on a role mismatch', () => {
        expect(selectPluginInlineSurfacePlacementsBySurface(
            model,
            { pluginId: 'acme.review', localId: 'review-status-widget' },
            'widget',
        ).map((entry) => entry.descriptorId)).toEqual(['review-status-widget']);
        expect(selectPluginInlineSurfacePlacementsBySurface(
            model,
            { pluginId: 'acme.review', localId: 'review-subagent-details' },
            'widget',
        )).toEqual([]);
    });
});
