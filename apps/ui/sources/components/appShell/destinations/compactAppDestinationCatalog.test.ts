import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';

import {
    isCompactAppDestinationCurrent,
    resolveCompactAppDestinations,
    useCompactAppDestinations,
} from './compactAppDestinationCatalog';

const compactCatalogProjectionState = vi.hoisted(() => ({
    value: {
        interactionEnabled: true,
        pluginUiProjection: null as PluginUiProjectionModel | null,
    },
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => compactCatalogProjectionState.value,
}));

const page = Object.freeze({
    id: 'plugin:acme.notes:notes',
    pluginId: 'acme.notes',
    descriptorId: 'notes',
    localId: 'notes',
    label: 'Notes',
    icon: 'note',
    order: 40,
    disabledReason: null,
    placement: {} as PluginAppPage['placement'],
    routePath: '/plugins/acme.notes/notes',
} satisfies PluginAppPage);

const appSidebarTab = Object.freeze({
    id: 'plugin:acme.review:review-panel',
    owner: 'plugin',
    label: 'Review',
    icon: 'check-square',
    order: 50,
    scopes: ['app'],
    mobileSurfaces: { app: 'plugin' },
    plugin: { pluginId: 'acme.review', descriptorId: 'review-panel', generation: 4 },
    retentionKey: 'plugin:acme.review:review-panel:4',
    placement: {
        binding: {
            destination: { pluginId: 'acme.review', localId: 'review-panel' },
        },
    },
} as unknown as RightSidebarPluginTabDefinition);

function createProjectedAppPage(): PluginUiSurfacePlacementProjection {
    return {
        id: 'surfacePlacement:acme.notes:notes',
        pluginId: 'acme.notes',
        contributionKind: 'surfacePlacement',
        descriptorId: 'notes',
        binding: {
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            container: 'appPage',
            targetKind: 'app',
        } as PluginUiSurfacePlacementProjection['binding'],
        target: { kind: 'app' },
        renderer: { kind: 'hostedWeb', contributionId: 'notes-renderer' },
        display: { developerFallback: 'Notes', iconToken: 'note' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        order: 40,
    };
}

function CompactCatalogProbe() {
    const destinations = useCompactAppDestinations({ browseExistingSessionsEnabled: false });
    return React.createElement('CompactCatalogProbe', { destinations });
}

describe('resolveCompactAppDestinations', () => {
    it('projects the built-in Browse Existing Sessions entry and an exact qualified app page through one catalog', () => {
        expect(resolveCompactAppDestinations({
            browseExistingSessionsEnabled: true,
            pages: [page],
        })).toEqual([
            expect.objectContaining({
                kind: 'builtin',
                id: 'browseExistingSessions',
                routePath: '/external/browse',
                availability: 'available',
            }),
            expect.objectContaining({
                kind: 'plugin',
                id: 'plugin:acme.notes:notes',
                destination: { pluginId: 'acme.notes', localId: 'notes' },
                routePath: '/plugins/acme.notes/notes',
                availability: 'available',
            }),
        ]);
    });

    it('retains an unavailable qualified page as its exact destination instead of substituting another launcher', () => {
        const unavailable = Object.freeze({
            ...page,
            disabledReason: 'plugin_disabled',
        });

        expect(resolveCompactAppDestinations({
            browseExistingSessionsEnabled: false,
            pages: [unavailable],
        })).toEqual([
            expect.objectContaining({
                kind: 'plugin',
                id: 'plugin:acme.notes:notes',
                destination: { pluginId: 'acme.notes', localId: 'notes' },
                availability: 'unavailable',
                unavailableReason: 'plugin_disabled',
            }),
        ]);
    });

    it('projects an admitted App right-sidebar tab through the same ordinary App catalog', () => {
        expect(resolveCompactAppDestinations({
            browseExistingSessionsEnabled: false,
            pages: [],
            rightSidebarTabs: [appSidebarTab],
        })).toEqual([
            expect.objectContaining({
                kind: 'plugin',
                container: 'rightSidebarTab',
                id: 'rightSidebarTab:plugin:acme.review:review-panel',
                destination: { pluginId: 'acme.review', localId: 'review-panel' },
                routePath: '/settings/plugins/panels?pluginId=acme.review&destinationId=review-panel',
                availability: 'available',
            }),
        ]);
    });

    it('matches compact selection by the exact host-issued route and qualified panel identity', () => {
        const [pageDestination, panelDestination] = resolveCompactAppDestinations({
            browseExistingSessionsEnabled: false,
            pages: [page],
            rightSidebarTabs: [appSidebarTab],
        });

        expect(isCompactAppDestinationCurrent(pageDestination!, {
            pathname: '/plugins/acme.notes/notes/history',
            params: {},
        })).toBe(true);
        expect(isCompactAppDestinationCurrent(panelDestination!, {
            pathname: '/settings/plugins/panels',
            params: { pluginId: 'acme.review', destinationId: 'review-panel' },
        })).toBe(true);
        expect(isCompactAppDestinationCurrent(panelDestination!, {
            pathname: '/settings/plugins/panels',
            params: { pluginId: 'acme.review', destinationId: 'different-panel' },
        })).toBe(false);
    });
});

describe('compact App destination presentation policy', () => {
    it('uses author presentation as a bounded default while retaining host-owned ordering', () => {
        const sessionHint = Object.freeze({
            ...page,
            id: 'plugin:acme.review:review',
            pluginId: 'acme.review',
            descriptorId: 'review',
            localId: 'review',
            label: 'Review',
            routePath: '/plugins/acme.review/review',
            badge: { label: 'Preview', tone: 'accent' },
            groupHint: 'sessions',
            rankHint: -25,
        }) as unknown as PluginAppPage;
        const navigationHint = Object.freeze({
            ...page,
            id: 'plugin:acme.notes:notes',
            badge: { label: 'New', tone: 'success' },
            groupHint: 'navigation',
            rankHint: 25,
        }) as unknown as PluginAppPage;

        const destinations = resolveCompactAppDestinations({
            browseExistingSessionsEnabled: true,
            pages: [navigationHint, sessionHint],
        });

        expect(destinations.map((destination) => ({
            id: destination.id,
            group: destination.group,
            badge: destination.kind === 'plugin' ? destination.badge : undefined,
        }))).toEqual([
            { id: 'browseExistingSessions', group: 'sessions', badge: undefined },
            { id: 'plugin:acme.review:review', group: 'sessions', badge: { label: 'Preview', tone: 'accent' } },
            { id: 'plugin:acme.notes:notes', group: 'plugins', badge: { label: 'New', tone: 'success' } },
        ]);
    });

    it('applies user order and visibility without deleting the route-owned unavailable destination', () => {
        const review = Object.freeze({
            ...page,
            id: 'plugin:acme.review:review',
            pluginId: 'acme.review',
            descriptorId: 'review',
            localId: 'review',
            label: 'Review',
            routePath: '/plugins/acme.review/review',
            disabledReason: 'feature_disabled',
        }) as unknown as PluginAppPage;

        const destinations = resolveCompactAppDestinations({
            browseExistingSessionsEnabled: true,
            pages: [page, review],
            preferences: {
                orderedDestinationIds: ['plugin:acme.notes:notes'],
                hiddenDestinationIds: ['plugin:acme.review:review'],
            },
        });

        expect(destinations.map((destination) => destination.id)).toEqual([
            'plugin:acme.notes:notes',
            'browseExistingSessions',
            'plugin:acme.review:review',
        ]);
        expect(destinations.find((destination) => destination.id === 'plugin:acme.review:review'))
            .toMatchObject({
                visibility: 'hidden',
                availability: 'unavailable',
                unavailableReason: 'feature_disabled',
            });
    });
});

describe('useCompactAppDestinations', () => {
    it('keeps an admitted app page discoverable while daemon interaction is offline', async () => {
        compactCatalogProjectionState.value = {
            interactionEnabled: false,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 1,
                surfacePlacementsById: {
                    'surfacePlacement:acme.notes:notes': createProjectedAppPage(),
                },
            },
        };

        const screen = await renderScreen(React.createElement(CompactCatalogProbe));
        const probe = screen.tree.findByType('CompactCatalogProbe' as never);

        expect(probe.props.destinations).toEqual([
            expect.objectContaining({
                kind: 'plugin',
                destination: { pluginId: 'acme.notes', localId: 'notes' },
                routePath: '/plugins/acme.notes/notes',
                availability: 'available',
            }),
        ]);
    });
});
