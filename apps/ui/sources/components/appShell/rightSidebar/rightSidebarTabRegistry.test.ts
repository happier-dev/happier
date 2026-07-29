import { describe, expect, it } from 'vitest';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    getRightSidebarBuiltinTab,
    resolveRightSidebarActiveTab,
    resolveRightSidebarMobileSurface,
    resolveRightSidebarTabs,
} from './rightSidebarTabRegistry';

const reviewSidebarPlacement = {
    id: 'pluginUi:review:surfacePlacement:review-panel',
    pluginId: 'review',
    contributionKind: 'surfacePlacement',
    descriptorId: 'review-panel',
    placement: 'session.rightSidebarTab',
    target: { kind: 'session' },
    renderer: { kind: 'host', rendererId: 'review.panel' },
    display: { developerFallback: 'Review' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    order: 15,
    rightSidebar: {
        tabId: 'review',
        scope: 'session',
        order: 15,
        mobile: { enabled: true, surface: 'pluginTab' },
        lifecycle: { retention: 'unmountOnDisable', unmountOnGenerationChange: true },
        disabledPolicy: 'disable',
        collisionPolicy: 'reject',
    },
} satisfies PluginUiSurfacePlacementProjection;

const disabledReviewSidebarPlacement = {
    ...reviewSidebarPlacement,
    id: 'pluginUi:review:surfacePlacement:blocked-review-panel',
    descriptorId: 'blocked-review-panel',
    availability: {
        state: 'disabled',
        reason: 'feature_disabled',
        diagnostics: ['feature_disabled'],
    },
    rightSidebar: {
        ...reviewSidebarPlacement.rightSidebar,
        tabId: 'blocked-review',
        order: 16,
    },
} satisfies PluginUiSurfacePlacementProjection;

describe('rightSidebarTabRegistry', () => {
    it('orders session built-in tabs deterministically and gates terminal availability', () => {
        // Browser is mobile-only after D1; the default presentation is desktop, so it is absent.
        expect(resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: true,
        }).map((tab) => tab.id)).toEqual([
            'git',
            'files',
            'agents',
            'navigation',
            'terminal',
            'services',
        ]);

        expect(resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
        }).map((tab) => tab.id)).toEqual([
            'git',
            'files',
            'agents',
            'navigation',
            'services',
        ]);

        // Mobile keeps the full-screen Browser surface tab.
        expect(resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: true,
            presentation: 'mobile',
        }).map((tab) => tab.id)).toEqual([
            'git',
            'files',
            'agents',
            'navigation',
            'terminal',
            'browser',
            'services',
        ]);
    });

    it('orders project built-in tabs without session-only entries', () => {
        // Browser is mobile-only after D1; desktop drops it, mobile keeps it.
        expect(resolveRightSidebarTabs({
            scope: 'project',
            terminalTabAvailable: true,
        }).map((tab) => tab.id)).toEqual([
            'git',
            'files',
            'services',
        ]);

        expect(resolveRightSidebarTabs({
            scope: 'project',
            terminalTabAvailable: true,
            presentation: 'mobile',
        }).map((tab) => tab.id)).toEqual([
            'git',
            'files',
            'browser',
            'services',
        ]);
    });

    it('falls back to the first available built-in tab when persisted state is stale', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
        });

        expect(resolveRightSidebarActiveTab('terminal', tabs)).toBe('git');
        // Browser is absent on desktop after D1, so a stale 'browser' selection falls back.
        expect(resolveRightSidebarActiveTab('browser', tabs)).toBe('git');
        expect(resolveRightSidebarActiveTab(null, tabs)).toBe('git');

        // On mobile the Browser surface tab is still selectable.
        const mobileTabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
            presentation: 'mobile',
        });
        expect(resolveRightSidebarActiveTab('browser', mobileTabs)).toBe('browser');
    });

    it('removes the Browser tab on desktop while keeping it on mobile (D1)', () => {
        const desktopSession = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: true,
            presentation: 'desktop',
        }).map((tab) => tab.id);
        const desktopProject = resolveRightSidebarTabs({
            scope: 'project',
            presentation: 'desktop',
        }).map((tab) => tab.id);
        expect(desktopSession).not.toContain('browser');
        expect(desktopProject).not.toContain('browser');
        // Services remains the desktop services/launch surface.
        expect(desktopSession).toContain('services');
        expect(desktopProject).toContain('services');

        const mobileSession = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: true,
            presentation: 'mobile',
        }).map((tab) => tab.id);
        const mobileProject = resolveRightSidebarTabs({
            scope: 'project',
            presentation: 'mobile',
        }).map((tab) => tab.id);
        expect(mobileSession).toContain('browser');
        expect(mobileProject).toContain('browser');
    });

    it('keeps the Browser mobile-surface projection unchanged after the desktop removal (D1)', () => {
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('browser'), 'session')).toBe('browser');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('browser'), 'project')).toBe('browser');
    });

    it('projects Browser and Services to mobile through the shared registry metadata', () => {
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('git'), 'session')).toBe('git');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('files'), 'session')).toBe('browse');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('terminal'), 'session')).toBe('terminal');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('browser'), 'session')).toBe('browser');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('services'), 'session')).toBe('services');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('browser'), 'project')).toBe('browser');
        expect(resolveRightSidebarMobileSurface(getRightSidebarBuiltinTab('services'), 'project')).toBe('services');
    });

    it('merges validated plugin tabs into host-owned ordering without shadowing built-ins', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
            pluginPlacements: [reviewSidebarPlacement],
        });

        expect(tabs.map((tab) => tab.id)).toEqual([
            'git',
            'plugin:review:review',
            'files',
            'agents',
            'navigation',
            'services',
        ]);
        expect(tabs.find((tab) => tab.id === 'plugin:review:review')).toMatchObject({
            owner: 'plugin',
            label: 'Review',
            plugin: {
                pluginId: 'review',
                descriptorId: 'review-panel',
            },
        });
    });

    it('falls back away from disabled plugin tabs while keeping their disabled tab state', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
            pluginPlacements: [disabledReviewSidebarPlacement],
        });

        expect(tabs.find((tab) => tab.id === 'plugin:review:blocked-review')).toMatchObject({
            disabledReason: 'feature_disabled',
        });
        expect(resolveRightSidebarActiveTab('plugin:review:blocked-review', tabs)).toBe('git');
    });

    it('resolves app-scope plugin right-sidebar tabs through the shared registry', () => {
        const appSidebarPlacement = {
            ...reviewSidebarPlacement,
            id: 'pluginUi:acme:surfacePlacement:app-panel',
            pluginId: 'acme',
            descriptorId: 'app-panel',
            placement: 'app.rightSidebarTab',
            target: { kind: 'app' },
            renderer: { kind: 'host', rendererId: 'descriptorPanel' },
            rightSidebar: {
                ...reviewSidebarPlacement.rightSidebar,
                tabId: 'app-tab',
                scope: 'app',
            },
        } satisfies PluginUiSurfacePlacementProjection;

        const tabs = resolveRightSidebarTabs({
            scope: 'app',
            pluginPlacements: [appSidebarPlacement],
        });

        // No app-scope built-in tabs exist; only the plugin tab resolves for scope 'app'.
        expect(tabs.map((tab) => tab.id)).toEqual(['plugin:acme:app-tab']);
        expect(tabs.find((tab) => tab.id === 'plugin:acme:app-tab')).toMatchObject({
            owner: 'plugin',
            plugin: { pluginId: 'acme', descriptorId: 'app-panel' },
        });
    });
});
