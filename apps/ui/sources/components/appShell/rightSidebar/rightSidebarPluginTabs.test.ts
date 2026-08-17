import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { resolveRightSidebarPluginTabs } from './rightSidebarPluginTabs';

const REVIEW_PLUGIN_ID = 'acme.review';

function destinationBinding(
    pluginId: string,
    localId: string,
    targetKind: 'session' | 'project' | 'app' = 'session',
): PluginUiSurfacePlacementProjection['binding'] {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId: localId,
        rendererId: `${localId}-renderer`,
        container: 'rightSidebarTab',
        target: { kind: targetKind },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 right-sidebar binding');
    }
    return binding;
}

function createPlacement(overrides: Partial<PluginUiSurfacePlacementProjection> = {}): PluginUiSurfacePlacementProjection {
    const placement = {
        id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
        pluginId: REVIEW_PLUGIN_ID,
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        target: { kind: 'session' },
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review', icon: 'review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        ...overrides,
    };
    const binding = placement.binding ?? destinationBinding(
        placement.pluginId,
        placement.descriptorId,
        placement.target.kind === 'app' || placement.target.kind === 'project'
            ? placement.target.kind
            : 'session',
    );
    return {
        ...placement,
        binding,
        target: binding.target,
    } as PluginUiSurfacePlacementProjection;
}

describe('rightSidebarPluginTabs', () => {
    it('normalizes plugin surface placements into namespaced right-sidebar tabs', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [createPlacement({
                display: {
                    developerFallback: 'Review',
                    iconToken: 'settings',
                    badge: {
                        developerFallback: 'Preview',
                        tone: 'accent',
                    },
                    groupHint: 'sessions',
                    rankHint: -25,
                },
            })],
            projectionGeneration: 4,
        });

        expect(tabs).toHaveLength(1);
        expect(tabs[0]).toMatchObject({
            id: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
            owner: 'plugin',
            label: 'Review',
            badge: { label: 'Preview', tone: 'accent' },
            groupHint: 'sessions',
            rankHint: -25,
            order: Number.MAX_SAFE_INTEGER,
            scopes: ['session'],
            mobileSurfaces: { session: 'plugin' },
            plugin: {
                pluginId: REVIEW_PLUGIN_ID,
                descriptorId: 'review-panel',
                generation: 4,
            },
            retentionKey: `plugin:${REVIEW_PLUGIN_ID}:review-panel:4`,
        });
    });

    it('derives mobile admission and stable host ordering from the binding, not legacy metadata', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [createPlacement({
                id: `surfacePlacement:${REVIEW_PLUGIN_ID}:legacy-metadata`,
                descriptorId: 'legacy-metadata',
                // These fields cannot be produced by the V2 view projection.
                // Keep them here only to prove they cannot still affect a live
                // binding consumer during the contraction.
                order: -100,
                rightSidebar: {
                    order: -100,
                    mobile: { enabled: false, surface: 'pluginTab' },
                },
            })],
        });

        expect(tabs).toMatchObject([{
            id: `plugin:${REVIEW_PLUGIN_ID}:legacy-metadata`,
            order: Number.MAX_SAFE_INTEGER,
            mobileSurfaces: { session: 'plugin' },
        }]);
    });

    it('does not invent a mobile surface when the binding has no native platform admission', () => {
        const binding = destinationBinding(REVIEW_PLUGIN_ID, 'desktop-only');
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [createPlacement({
                id: `surfacePlacement:${REVIEW_PLUGIN_ID}:desktop-only`,
                descriptorId: 'desktop-only',
                binding: {
                    ...binding,
                    platforms: ['desktop', 'web'],
                },
            })],
        });

        expect(tabs[0]).toMatchObject({
            id: `plugin:${REVIEW_PLUGIN_ID}:desktop-only`,
            order: Number.MAX_SAFE_INTEGER,
        });
        expect(tabs[0]?.mobileSurfaces).toBeUndefined();
    });

    it('does not advertise a Project plugin binding as a native phone destination from generic metadata', () => {
        const binding = destinationBinding(REVIEW_PLUGIN_ID, 'project-review', 'project');
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'project',
            placements: [createPlacement({
                id: `surfacePlacement:${REVIEW_PLUGIN_ID}:project-review`,
                descriptorId: 'project-review',
                binding: {
                    ...binding,
                    platforms: ['ios', 'android'],
                },
                rightSidebar: {
                    mobile: { enabled: true, surface: 'pluginTab' },
                },
            })],
        });

        expect(tabs).toMatchObject([{
            id: `plugin:${REVIEW_PLUGIN_ID}:project-review`,
            scopes: ['project'],
        }]);
        expect(tabs[0]?.mobileSurfaces).toBeUndefined();
    });

    it('removes a desktop/tablet Project tab from the native phone catalog while retaining it on tablet', () => {
        const placement = createPlacement({
            id: `surfacePlacement:${REVIEW_PLUGIN_ID}:project-tablet-review`,
            descriptorId: 'project-tablet-review',
            target: { kind: 'project' },
            binding: destinationBinding(REVIEW_PLUGIN_ID, 'project-tablet-review', 'project'),
        });

        expect(resolveRightSidebarPluginTabs({
            scope: 'project',
            placements: [placement],
            runtimeAdmission: { platform: 'ios', formFactor: 'phone' },
        })).toEqual([]);

        expect(resolveRightSidebarPluginTabs({
            scope: 'project',
            placements: [placement],
            runtimeAdmission: { platform: 'ios', formFactor: 'tablet' },
        })).toMatchObject([{
            id: `plugin:${REVIEW_PLUGIN_ID}:project-tablet-review`,
            placement,
        }]);
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
                }),
            ],
            projectionGeneration: 4,
            policyContext: { platform: 'ios' },
        });

        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.disabledReason).toBeUndefined();
        expect(incompatible).toEqual([]);
    });

    it('hides policy-denied or unavailable plugin tabs before executable UI mounts', () => {
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements: [
                createPlacement({
                    featureGate: 'plugins.ui.reviewPanel',
                }),
                createPlacement({
                    id: `surfacePlacement:${REVIEW_PLUGIN_ID}:blocked-review`,
                    descriptorId: 'blocked-review',
                    availability: {
                        state: 'blocked',
                        reason: 'permission_denied',
                        diagnostics: ['permission_denied'],
                    },
                }),
            ],
            projectionGeneration: 4,
        });

        expect(tabs).toEqual([]);
    });

    it('rejects every colliding qualified destination instead of selecting the first declaration', () => {
        const placements = [
            createPlacement({
                descriptorId: 'review-panel-a',
                binding: destinationBinding(REVIEW_PLUGIN_ID, 'review'),
                display: { developerFallback: 'Review A', icon: 'review' },
            }),
            createPlacement({
                id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel-b`,
                descriptorId: 'review-panel-b',
                binding: destinationBinding(REVIEW_PLUGIN_ID, 'review'),
                display: { developerFallback: 'Review B', icon: 'review' },
            }),
        ];
        const tabs = resolveRightSidebarPluginTabs({
            scope: 'session',
            placements,
            projectionGeneration: 4,
        });

        expect(tabs).toEqual([]);
    });

    it('ignores placements whose metadata does not match the requested sidebar scope', () => {
        expect(resolveRightSidebarPluginTabs({
            scope: 'project',
            placements: [createPlacement()],
            projectionGeneration: 4,
        })).toEqual([]);
    });

});
