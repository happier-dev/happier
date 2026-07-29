import { describe, expect, it } from 'vitest';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { resolveRightSidebarPluginTabs } from './rightSidebarPluginTabs';

function createPlacement(overrides: Partial<PluginUiSurfacePlacementProjection> = {}): PluginUiSurfacePlacementProjection {
    return {
        id: 'pluginUi:review:surfacePlacement:review-panel',
        pluginId: 'review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        placement: 'session.rightSidebarTab',
        target: { kind: 'session' },
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review', icon: 'review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        order: 30,
        rightSidebar: {
            tabId: 'review',
            scope: 'session',
            order: 12,
            mobile: { enabled: true, surface: 'pluginTab' },
            lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
            disabledPolicy: 'disable',
            collisionPolicy: 'reject',
        },
        ...overrides,
    };
}

describe('rightSidebarPluginTabs', () => {
    it('normalizes plugin surface placements into namespaced right-sidebar tabs', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [createPlacement()],
            projectionGeneration: 4,
        });

        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toMatchObject({
            id: 'plugin:review:review',
            owner: 'plugin',
            label: 'Review',
            order: 12,
            scopes: ['session'],
            mobileSurfaces: { session: 'plugin' },
            plugin: {
                pluginId: 'review',
                descriptorId: 'review-panel',
                generation: 4,
            },
            retentionKey: 'plugin:review:review:4',
        });
    });

    it('uses host policy context when resolving compatible plugin tabs', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [
                createPlacement({
                    compatibility: { platforms: ['web'] },
                }),
            ],
            projectionGeneration: 4,
            policyContext: { platform: 'web' },
        });
        const incompatible = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [
                createPlacement({
                    compatibility: { platforms: ['web'] },
                    rightSidebar: {
                        tabId: 'review',
                        scope: 'session',
                        order: 12,
                    },
                }),
            ],
            projectionGeneration: 4,
            policyContext: { platform: 'ios' },
        });

        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.disabledReason).toBeUndefined();
        expect(incompatible).toEqual([]);
    });

    it('marks policy-denied or unavailable plugin tabs disabled before executable UI mounts', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [
                createPlacement({
                    featureGate: 'plugins.ui.reviewPanel',
                }),
                createPlacement({
                    id: 'pluginUi:review:surfacePlacement:blocked-review',
                    descriptorId: 'blocked-review',
                    availability: {
                        state: 'blocked',
                        reason: 'permission_denied',
                        diagnostics: ['permission_denied'],
                    },
                    rightSidebar: {
                        tabId: 'blocked-review',
                        scope: 'session',
                        order: 14,
                        disabledPolicy: 'disable',
                    },
                }),
            ],
            projectionGeneration: 4,
        });

        expect(tabs.map((tab) => [tab.id, tab.disabledReason])).toEqual([
            ['plugin:review:review', 'policy_deferred'],
            ['plugin:review:blocked-review', 'permission_denied'],
        ]);
    });

    it('does not emit duplicate host tab ids when stale projection data repeats a same-plugin slug', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [
                createPlacement({
                    descriptorId: 'review-panel-a',
                    display: { developerFallback: 'Review A', icon: 'review' },
                }),
                createPlacement({
                    id: 'pluginUi:review:surfacePlacement:review-panel-b',
                    descriptorId: 'review-panel-b',
                    display: { developerFallback: 'Review B', icon: 'review' },
                    rightSidebar: {
                        tabId: 'review',
                        scope: 'session',
                        order: 13,
                        mobile: { enabled: true, surface: 'pluginTab' },
                        lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
                        disabledPolicy: 'disable',
                        collisionPolicy: 'reject',
                    },
                }),
            ],
            projectionGeneration: 4,
        });

        expect(tabs.map((tab) => tab.id)).toEqual(['plugin:review:review']);
        expect(tabs[0]).toMatchObject({
            label: 'Review A',
            plugin: { descriptorId: 'review-panel-a' },
        });
    });

    it('ignores placements whose metadata does not match the requested sidebar scope', () => {
        expect(resolveRightSidebarPluginTabs({
            scope: 'project',
            placements: [createPlacement()],
            projectionGeneration: 4,
        })).toEqual([]);
    });
});
