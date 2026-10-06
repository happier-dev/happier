import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { navigationPlacementsFromLegacyPins } from '@/sync/domains/settings/mobileSurfacePinning';

import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileNavigatorSurfaces,
    resolveSessionCockpitMobileTabVisibility,
} from './sessionCockpitMobileCatalog';

function createMobilePluginPlacement(input: Readonly<{
    pluginId: string;
    destinationId: string;
    label: string;
    platforms?: readonly ('ios' | 'android' | 'desktop' | 'web')[];
}>): PluginUiSurfacePlacementProjection {
    const normalizedBinding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: input.destinationId,
        rendererId: `${input.destinationId}-panel`,
        container: 'rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    if (!normalizedBinding) {
        throw new Error('fixture must produce an admitted V2 session right-sidebar binding');
    }
    const binding = {
        ...normalizedBinding,
        ...(input.platforms === undefined ? {} : { platforms: input.platforms }),
    };

    return {
        id: `surfacePlacement:${input.pluginId}:${input.destinationId}`,
        pluginId: input.pluginId,
        occurrenceId: `${input.pluginId}-occurrence`,
        contributionKind: 'surfacePlacement',
        descriptorId: input.destinationId,
        binding,
        target: binding.target,
        renderer: { kind: 'host', rendererId: `${input.destinationId}-panel` },
        display: { developerFallback: input.label },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
}

describe('sessionCockpitMobileCatalog', () => {
    it('uses shared placement order and hides tools from both the bar and More while reserving Chat', () => {
        const catalog = resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true });
        const visibility = resolveSessionCockpitMobileTabVisibility({
            catalog,
            preferences: {
                orderedIds: ['terminal', 'git', 'browse', 'plugin:removed:panel'],
                placements: { chat: 'hidden', terminal: 'pinned', git: 'hidden', browse: 'overflow' },
            },
            slotCount: 7,
            alwaysSwipe: false,
        });
        expect(visibility.visible.map((entry) => entry.id)).toEqual(['chat', 'terminal', 'companion']);
        expect(visibility.overflow.map((entry) => entry.id)).toContain('browse');
        expect([...visibility.visible, ...visibility.held, ...visibility.overflow].map((entry) => entry.id)).not.toContain('git');
    });
    it('publishes Board on mobile only when the exact Home enables it', () => {
        expect(resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
        }).map((entry) => entry.id)).not.toContain('board');

        expect(resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
            boardFeatureEnabled: true,
        }).map((entry) => entry.id)).toContain('board');
    });

    it('publishes the Companion destination on every Home while Board stays behind its decision', () => {
        // Companion is host-owned like Chat and Tabs: its first-party Session
        // Summary needs no Board record, so a missing or refused `sessions.board`
        // answer hides only the Board destination.
        for (const input of [
            { terminalTabAvailable: false },
            { terminalTabAvailable: false, boardFeatureEnabled: false },
        ] as const) {
            const catalog = resolveSessionCockpitMobileCatalog(input);
            expect(catalog.map((entry) => entry.id)).toContain('companion');
            expect(catalog.map((entry) => entry.id)).not.toContain('board');
            expect(resolveSessionCockpitMobileNavigatorSurfaces({ catalog }))
                .toContain('companion');
        }

        const enabledCatalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
            boardFeatureEnabled: true,
        });
        expect(enabledCatalog.map((entry) => entry.id)).toContain('companion');
        expect(enabledCatalog.map((entry) => entry.id)).toContain('board');
        expect(resolveSessionCockpitMobileNavigatorSurfaces({ catalog: enabledCatalog }))
            .toContain('companion');
    });

    it('keeps a plugin in host-owned discovery and puts an explicitly pinned plugin on the bar', () => {
        const plugin = createMobilePluginPlacement({
            pluginId: 'acme.review',
            destinationId: 'session-review',
            label: 'Review',
        });
        const catalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: true,
            boardFeatureEnabled: true,
            pluginPlacements: [plugin],
            projectionGeneration: 7,
        });

        expect(catalog.map((entry) => entry.id)).toEqual([
            'chat',
            'browse',
            'git',
            'tabs',
            'companion',
            'agents',
            'navigation',
            'board',
            'browser',
            'services',
            'plugin:acme.review:session-review',
            'terminal',
        ]);

        // At rest the bar is Chat plus the host's default tools; everything else waits in More.
        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            preferences: null,
            slotCount: 7,
            alwaysSwipe: false,
        })).toMatchObject({
            mode: 'fit',
            visible: [{ id: 'chat' }, { id: 'browse' }, { id: 'git' }, { id: 'companion' }, { id: 'terminal' }],
            held: [],
            overflow: expect.arrayContaining([
                expect.objectContaining({ id: 'plugin:acme.review:session-review' }),
                expect.objectContaining({ id: 'tabs' }),
            ]),
        });

        // A pin puts the plugin on the bar, after the tools already there.
        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            preferences: navigationPlacementsFromLegacyPins(['browse', 'git', 'plugin:acme.review:session-review']),
            slotCount: 7,
            alwaysSwipe: false,
        })).toMatchObject({
            mode: 'fit',
            visible: [{ id: 'chat' }, { id: 'browse' }, { id: 'git' }, { id: 'plugin:acme.review:session-review' }],
        });
    });

    it('lets the bar width be the cap: more pins than fit scroll, or wait in More while Always swipe is on', () => {
        const catalog = resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true, boardFeatureEnabled: true });
        const pins = ['browse', 'git', 'companion', 'terminal', 'tabs', 'navigation', 'board'];
        // 390 pt holds 7 slots: Chat, More and five tools. Seven pinned tools do not fit.
        const scrolling = resolveSessionCockpitMobileTabVisibility({ catalog, preferences: navigationPlacementsFromLegacyPins(pins), slotCount: 7, alwaysSwipe: false });
        expect(scrolling.mode).toBe('scroll');
        expect(scrolling.visible.map((entry) => entry.id)).toEqual(['chat', ...pins]);
        expect(scrolling.held).toEqual([]);

        const swiping = resolveSessionCockpitMobileTabVisibility({ catalog, preferences: navigationPlacementsFromLegacyPins(pins), slotCount: 7, alwaysSwipe: true });
        expect(swiping.mode).toBe('more');
        expect(swiping.visible.map((entry) => entry.id)).toEqual(['chat', 'browse', 'git', 'companion', 'terminal', 'tabs']);
        expect(swiping.held.map((entry) => entry.id)).toEqual(['navigation', 'board']);
        expect(swiping.overflow.map((entry) => entry.id)).not.toContain('navigation');
    });

    it('never turns unavailable or unknown pinned values into a visible catalog entry', () => {
        const catalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
        });

        expect(resolveSessionCockpitMobileTabVisibility({
            catalog,
            preferences: navigationPlacementsFromLegacyPins(['plugin:removed:panel', 'not-a-surface', 'git']),
            slotCount: 7,
            alwaysSwipe: false,
        })).toMatchObject({
            visible: [
                { id: 'chat' },
                { id: 'git' },
            ],
        });
    });

    it('admits a conservative Android-only destination only to the Android phone catalog', () => {
        const androidOnlyPlugin = createMobilePluginPlacement({
            pluginId: 'acme.android',
            destinationId: 'session-review',
            label: 'Android review',
            platforms: ['android'],
        });
        const iosInput = {
            terminalTabAvailable: true,
            pluginPlacements: [androidOnlyPlugin],
            projectionGeneration: 7,
            runtimeAdmission: { platform: 'ios' as const, formFactor: 'phone' as const },
        };
        const androidInput = {
            ...iosInput,
            runtimeAdmission: { platform: 'android' as const, formFactor: 'phone' as const },
        };

        expect(resolveSessionCockpitMobileCatalog(iosInput).map((entry) => entry.id))
            .not.toContain('plugin:acme.android:session-review');
        expect(resolveSessionCockpitMobileCatalog(androidInput).map((entry) => entry.id))
            .toContain('plugin:acme.android:session-review');
    });
});
