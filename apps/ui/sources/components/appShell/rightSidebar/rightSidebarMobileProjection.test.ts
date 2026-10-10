import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveRightSidebarMobileProjection,
    resolveRightSidebarTabIdForMobileSurface,
} from './rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from './rightSidebarTabRegistry';

const REVIEW_PLUGIN_ID = 'acme.review';

const pluginBinding = normalizePluginUiDestinationBindingV1({
    pluginId: REVIEW_PLUGIN_ID,
    destinationId: 'review-panel',
    rendererId: 'review-panel-renderer',
    container: 'rightSidebarTab',
    target: { kind: 'session' },
});
if (!pluginBinding) {
    throw new Error('test fixture must use an admitted V2 session right-sidebar binding');
}

const pluginPlacement = {
    id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
    pluginId: REVIEW_PLUGIN_ID,
    occurrenceId: 'acme-review-occurrence',
    contributionKind: 'surfacePlacement',
    descriptorId: 'review-panel',
    binding: pluginBinding,
    target: pluginBinding.target,
    renderer: { kind: 'host', rendererId: 'review.panel' },
    display: { developerFallback: 'Review' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
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
            { tabId: 'agents', surface: 'agents', owner: 'builtin' },
            { tabId: 'navigation', surface: 'navigation', owner: 'builtin' },
            { tabId: 'terminal', surface: 'terminal', owner: 'builtin' },
            { tabId: 'browser', surface: 'browser', owner: 'builtin' },
            { tabId: 'services', surface: 'services', owner: 'builtin' },
            { tabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`, surface: 'plugin', owner: 'plugin' },
        ]);

        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'browser', tabs })).toBe('browser');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'services', tabs })).toBe('services');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'navigation', tabs })).toBe('navigation');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'plugin', tabs }))
            .toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
    });

    it('keeps the persisted agents destination available as the Work surface on phone', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            presentation: 'mobile',
            terminalTabAvailable: true,
        });

        expect(tabs.some((tab) => tab.id === 'agents')).toBe(true);
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'session', surface: 'agents', tabs }))
            .toBe('agents');
    });

    it('scopes the navigation mobile surface to sessions only', () => {
        const tabs = resolveRightSidebarTabs({ scope: 'project', presentation: 'mobile' });

        expect(resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map((entry) => entry.tabId))
            .not.toContain('navigation');
    });

    it('hides the matching Project launcher without removing its mobile route destination', () => {
        const tabs = resolveRightSidebarTabs({ scope: 'project', activePage: 'changes', presentation: 'mobile' });
        expect(resolveRightSidebarMobileProjection({ scope: 'project', tabs }).map(entry => entry.tabId))
            .toEqual(['files', 'scripts', 'browser', 'services']);
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'project', surface: 'git', tabs })).toBe('git');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'project', surface: 'browse', tabs })).toBe('files');
        const scriptsPageTabs = resolveRightSidebarTabs({ scope: 'project', activePage: 'scripts', presentation: 'mobile' });
        expect(resolveRightSidebarMobileProjection({ scope: 'project', tabs: scriptsPageTabs }).map(entry => entry.tabId)).not.toContain('scripts');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'project', surface: 'scripts', tabs: scriptsPageTabs })).toBe('scripts');
        expect(resolveRightSidebarTabIdForMobileSurface({ scope: 'project', surface: 'terminal', tabs })).toBe('terminal');
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
            .not.toContain(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
    });
});
