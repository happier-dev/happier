import { describe, expect, it } from 'vitest';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveRightSidebarMobileProjection,
    resolveRightSidebarTabIdForMobileSurface,
} from './rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from './rightSidebarTabRegistry';

const pluginPlacement = {
    id: 'pluginUi:review:surfacePlacement:review-panel',
    pluginId: 'review',
    contributionKind: 'surfacePlacement',
    descriptorId: 'review-panel',
    placement: 'session.rightSidebarTab',
    target: { kind: 'session' },
    renderer: { kind: 'host', rendererId: 'review.panel' },
    display: { developerFallback: 'Review' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    order: 70,
    rightSidebar: {
        tabId: 'review',
        scope: 'session',
        order: 70,
        mobile: { enabled: true, surface: 'pluginTab' },
        disabledPolicy: 'disable',
    },
} satisfies PluginUiSurfacePlacementProjection;

describe('rightSidebarMobileProjection', () => {
    it('projects built-in and plugin right-sidebar tabs to mobile from the shared registry', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            terminalTabAvailable: true,
            pluginPlacements: [pluginPlacement],
        });

        expect(resolveRightSidebarMobileProjection({ scope: 'session', tabs }).map((entry) => ({
            tabId: entry.tabId,
            surface: entry.surface,
            owner: entry.owner,
        }))).toEqual([
            { tabId: 'git', surface: 'git', owner: 'builtin' },
            { tabId: 'files', surface: 'browse', owner: 'builtin' },
            { tabId: 'navigation', surface: 'navigation', owner: 'builtin' },
            { tabId: 'terminal', surface: 'terminal', owner: 'builtin' },
            { tabId: 'browser', surface: 'browser', owner: 'builtin' },
            { tabId: 'services', surface: 'services', owner: 'builtin' },
            { tabId: 'plugin:review:review', surface: 'plugin', owner: 'plugin' },
        ]);

        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'browser', tabs })).toBe('browser');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'services', tabs })).toBe('services');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'navigation', tabs })).toBe('navigation');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'plugin', tabs })).toBe('plugin:review:review');
    });

    it('keeps the agents tab desktop-only: it declares no session mobile surface', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            terminalTabAvailable: true,
        });

        expect(tabs.some((tab) => tab.id === 'agents')).toBe(true);
        expect(resolveRightSidebarMobileProjection({ scope: 'session', tabs }).map((entry) => entry.tabId))
            .not.toContain('agents');
    });

    it('scopes the navigation mobile surface to sessions only', () => {
        const tabs = resolveRightSidebarTabs({ scope: 'project', presentation: 'mobile' });

        expect(resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map((entry) => entry.tabId))
            .not.toContain('navigation');
    });

    it('omits disabled plugin tabs from mobile projection', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            pluginPlacements: [{
                ...pluginPlacement,
                availability: {
                    state: 'disabled',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                },
            }],
        });

        expect(resolveRightSidebarMobileProjection({ scope: 'session', tabs }).map((entry) => entry.tabId))
            .not.toContain('plugin:review:review');
    });
});
