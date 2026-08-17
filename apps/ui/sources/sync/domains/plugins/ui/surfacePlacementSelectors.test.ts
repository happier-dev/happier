import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';
import {
    normalizePluginUiDestinationBindingV1,
    PluginUiDestinationBindingV1Schema,
    type PluginUiDestinationBindingInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { normalizePluginUiProjection } from './projection';
import {
    selectPluginRightSidebarTabPlacements,
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
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        binding: normalizedBinding,
        target: normalizedBinding.target,
        renderer: { kind: 'declarative', contributionId: input.rendererId },
        display: { titleKey: 'title' },
        ...(input.legacyOrder === undefined ? {} : { order: input.legacyOrder }),
        ...(input.featureGate === undefined ? {} : { featureGate: input.featureGate }),
        availability: input.availability ?? { state: 'available', reason: 'available', diagnostics: [] },
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
            backendsById: {},
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
            backendsById: {},
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
