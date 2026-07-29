import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import { normalizePluginUiProjection } from './projection';
import {
    selectPluginRightSidebarTabPlacements,
    selectRenderablePluginRightSidebarTabPlacements,
    selectPluginSurfacePlacementsForPlacement,
    selectRenderablePluginSurfacePlacementsForPlacement,
} from './surfacePlacementSelectors';

describe('plugin surface placement selectors', () => {
    it('selects placements by host-owned placement kind in deterministic order', () => {
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
                        'surfacePlacement:acme.preview:workspace-late': {
                            id: 'surfacePlacement:acme.preview:workspace-late',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'workspace-late',
                            placement: 'workspace.details',
                            target: { kind: 'workspace' },
                            renderer: { kind: 'host', rendererId: 'workspaceLate' },
                            display: { titleKey: 'title' },
                            order: 30,
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:browser-panel': {
                            id: 'surfacePlacement:acme.preview:browser-panel',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'browser-panel',
                            placement: 'browser.panel',
                            target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
                            renderer: { kind: 'host', rendererId: 'browserPanel' },
                            display: { titleKey: 'title' },
                            order: 20,
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:workspace-early': {
                            id: 'surfacePlacement:acme.preview:workspace-early',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'workspace-early',
                            placement: 'workspace.details',
                            target: { kind: 'workspace' },
                            renderer: { kind: 'host', rendererId: 'workspaceEarly' },
                            display: { titleKey: 'title' },
                            order: 10,
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:settings': {
                            id: 'surfacePlacement:acme.preview:settings',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'settings',
                            placement: 'app.settingsPage',
                            target: { kind: 'app' },
                            renderer: { kind: 'host', rendererId: 'settings' },
                            display: { titleKey: 'title' },
                            order: 10,
                            featureGate: 'plugins.ui.settingsPage',
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:settings-blocked': {
                            id: 'surfacePlacement:acme.preview:settings-blocked',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'settings-blocked',
                            placement: 'app.settingsPage',
                            target: { kind: 'app' },
                            renderer: { kind: 'host', rendererId: 'settingsBlocked' },
                            display: { titleKey: 'title' },
                            order: 20,
                            availability: { state: 'blocked', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
                        },
                        'surfacePlacement:acme.preview:session-review': {
                            id: 'surfacePlacement:acme.preview:session-review',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'session-review',
                            placement: 'session.rightSidebarTab',
                            target: { kind: 'session' },
                            renderer: { kind: 'host', rendererId: 'sessionReview' },
                            display: { titleKey: 'title' },
                            rightSidebar: {
                                tabId: 'review',
                                scope: 'session',
                                section: 'plugin',
                                order: 25,
                                mobile: { enabled: true, surface: 'pluginTab' },
                            },
                            order: 25,
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:session-review-deferred': {
                            id: 'surfacePlacement:acme.preview:session-review-deferred',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'session-review-deferred',
                            placement: 'session.rightSidebarTab',
                            target: { kind: 'session' },
                            renderer: { kind: 'host', rendererId: 'sessionReviewDeferred' },
                            display: { titleKey: 'title' },
                            rightSidebar: {
                                tabId: 'deferred',
                                scope: 'session',
                                section: 'plugin',
                                order: 35,
                            },
                            order: 35,
                            enabled: { kind: 'pathTruthy', path: '/enabled' },
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'surfacePlacement:acme.preview:project-review-unavailable': {
                            id: 'surfacePlacement:acme.preview:project-review-unavailable',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'project-review-unavailable',
                            placement: 'project.rightSidebarTab',
                            target: { kind: 'project' },
                            renderer: { kind: 'host', rendererId: 'projectReview' },
                            display: { titleKey: 'title' },
                            rightSidebar: {
                                tabId: 'project-review',
                                scope: 'project',
                                section: 'plugin',
                                order: 10,
                            },
                            order: 10,
                            availability: { state: 'disabled', reason: 'right_sidebar_tab_id_reserved', diagnostics: ['right_sidebar_tab_id_reserved'] },
                        },
                        'surfacePlacement:acme.preview:service-inspector': {
                            id: 'surfacePlacement:acme.preview:service-inspector',
                            pluginId: 'acme.preview',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'service-inspector',
                            placement: 'services.panel',
                            target: { kind: 'services' },
                            renderer: { kind: 'host', rendererId: 'serviceInspector' },
                            display: { titleKey: 'title' },
                            order: 5,
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                    },
                },
            },
            diagnostics: [],
        };
        const model = normalizePluginUiProjection(projection);

        expect(selectPluginSurfacePlacementsForPlacement(model, 'workspace.details').map((placement) => placement.descriptorId)).toEqual([
            'workspace-early',
            'workspace-late',
        ]);
        expect(selectPluginSurfacePlacementsForPlacement(model, 'browser.panel').map((placement) => placement.descriptorId)).toEqual([
            'browser-panel',
        ]);
        expect(selectPluginSurfacePlacementsForPlacement(model, 'app.settingsPage').map((placement) => placement.descriptorId)).toEqual([
            'settings',
            'settings-blocked',
        ]);
        expect(selectPluginRightSidebarTabPlacements(model, 'session').map((placement) => placement.descriptorId)).toEqual([
            'session-review',
            'session-review-deferred',
        ]);
        // Phase 1.1: a declared `enabled` predicate is now EVALUATED to a
        // visible-but-disabled state, not silently hidden — so the deferred tab
        // renders (interactivity is gated downstream by the evaluated enabled bit).
        expect(selectRenderablePluginRightSidebarTabPlacements(model, 'session').map((placement) => placement.descriptorId)).toEqual([
            'session-review',
            'session-review-deferred',
        ]);
        expect(selectRenderablePluginRightSidebarTabPlacements(model, 'project')).toEqual([]);
        expect(selectRenderablePluginSurfacePlacementsForPlacement(model, 'app.settingsPage', {
            isFeatureEnabled: (featureId) => featureId === 'plugins.ui.settingsPage',
        }).map((placement) => placement.descriptorId)).toEqual([
            'settings',
        ]);
        expect(selectRenderablePluginSurfacePlacementsForPlacement(model, 'app.settingsPage', {
            isFeatureEnabled: () => false,
        })).toEqual([]);
        expect(selectRenderablePluginSurfacePlacementsForPlacement(model, 'services.panel').map((placement) => placement.descriptorId)).toEqual([
            'service-inspector',
        ]);
    });
});
