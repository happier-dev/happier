import { describe, expect, it } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    getRightSidebarBuiltinTab,
    resolveRightSidebarActiveTab,
    resolveRightSidebarTabSelection,
    resolveRightSidebarMobileSurface,
    resolveRightSidebarTabs,
} from './rightSidebarTabRegistry';

const REVIEW_PLUGIN_ID = 'acme.review';
const APP_PLUGIN_ID = 'acme.panels';
const BROWSER_PLUGIN_ID = 'acme.browser';

function rightSidebarBinding(
    pluginId: string,
    destinationId: string,
    targetKind: 'app' | 'session' | 'project',
): PluginUiSurfacePlacementProjection['binding'] {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId,
        rendererId: `${destinationId}-renderer`,
        container: 'rightSidebarTab',
        target: { kind: targetKind },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 right-sidebar binding');
    }
    return binding;
}

const reviewSidebarBinding = rightSidebarBinding(REVIEW_PLUGIN_ID, 'review-panel', 'session');
const disabledReviewSidebarBinding = rightSidebarBinding(REVIEW_PLUGIN_ID, 'blocked-review', 'session');
const appSidebarBinding = rightSidebarBinding(APP_PLUGIN_ID, 'app-panel', 'app');

const reviewSidebarPlacement = {
    id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
    pluginId: REVIEW_PLUGIN_ID,
    contributionKind: 'surfacePlacement',
    descriptorId: 'review-panel',
    binding: reviewSidebarBinding,
    target: reviewSidebarBinding.target,
    renderer: { kind: 'host', rendererId: 'review.panel' },
    display: { developerFallback: 'Review' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
} satisfies PluginUiSurfacePlacementProjection;

const disabledReviewSidebarPlacement = {
    ...reviewSidebarPlacement,
    id: `surfacePlacement:${REVIEW_PLUGIN_ID}:blocked-review`,
    descriptorId: 'blocked-review',
    binding: disabledReviewSidebarBinding,
    target: disabledReviewSidebarBinding.target,
    availability: {
        state: 'disabled',
        reason: 'feature_disabled',
        diagnostics: ['feature_disabled'],
    },
} satisfies PluginUiSurfacePlacementProjection;

const appSidebarPlacement = {
    id: `surfacePlacement:${APP_PLUGIN_ID}:app-panel`,
    pluginId: APP_PLUGIN_ID,
    contributionKind: 'surfacePlacement',
    descriptorId: 'app-panel',
    binding: appSidebarBinding,
    target: appSidebarBinding.target,
    renderer: { kind: 'host', rendererId: 'app.panel' },
    display: { developerFallback: 'App panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    // This is exactly the canonical app-union stamp. It models a selected
    // current app contribution while another eligible machine is establishing.
    hostOrigin: {
        machineId: 'machine-a',
        serverId: 'server-1',
        generation: 3,
        phase: 'current',
        interactionEnabled: true,
        executionOrigin: {
            serverIdentityId: 'srv_test',
            materializationRef: {
                pluginId: APP_PLUGIN_ID,
                machineId: 'machine-a',
                materializationId: 'machine-a:acme.panels',
            },
        },
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

    it('keeps a restored plugin selection unresolved until its projection is current, then tombstones it when absent', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
        });

        expect(resolveRightSidebarTabSelection({
            activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
            tabs,
            projectionPhase: 'establishing',
        })).toEqual({
            kind: 'unresolved',
            tabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
        });

        expect(resolveRightSidebarTabSelection({
            activeTabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
            tabs,
            projectionPhase: 'current',
        })).toEqual({
            kind: 'unavailable',
            tabId: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
            reason: 'plugin_destination_unavailable',
        });
    });

    it('returns no app-scope plugin selection until a user or qualified opener selects one', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'app',
            pluginPlacements: [appSidebarPlacement],
        });

        expect(resolveRightSidebarTabSelection({
            activeTabId: null,
            tabs,
            projectionPhase: 'current',
            scope: 'app',
        })).toEqual({ kind: 'none' });
    });

    it('keeps an already-published app tab available while another app member is establishing', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'app',
            pluginPlacements: [appSidebarPlacement],
        });

        // The aggregate catalog is incomplete, but this selected tab has an
        // exact current origin. Treating it as unresolved would unnecessarily
        // blank a known-current surface while machine-b describes another one.
        expect(resolveRightSidebarTabSelection({
            activeTabId: `plugin:${APP_PLUGIN_ID}:app-panel`,
            tabs,
            projectionPhase: 'establishing',
        })).toMatchObject({
            kind: 'available',
            tab: { id: `plugin:${APP_PLUGIN_ID}:app-panel` },
        });
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
            'files',
            'agents',
            'navigation',
            'services',
            `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
        ]);
        expect(tabs.find((tab) => tab.id === `plugin:${REVIEW_PLUGIN_ID}:review-panel`)).toMatchObject({
            owner: 'plugin',
            label: 'Review',
            plugin: {
                pluginId: REVIEW_PLUGIN_ID,
                descriptorId: 'review-panel',
            },
        });
    });

    it('falls back away from disabled plugin tabs that the current host policy hides', () => {
        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
            pluginPlacements: [disabledReviewSidebarPlacement],
        });

        expect(tabs.find((tab) => tab.id === `plugin:${REVIEW_PLUGIN_ID}:blocked-review`)).toBeUndefined();
        expect(resolveRightSidebarActiveTab(`plugin:${REVIEW_PLUGIN_ID}:blocked-review`, tabs)).toBe('git');
    });

    it('resolves app-scope plugin right-sidebar tabs through the shared registry', () => {
        const appSidebarBinding = rightSidebarBinding(APP_PLUGIN_ID, 'app-panel', 'app');
        const appSidebarPlacement = {
            ...reviewSidebarPlacement,
            id: `surfacePlacement:${APP_PLUGIN_ID}:app-panel`,
            pluginId: APP_PLUGIN_ID,
            descriptorId: 'app-panel',
            binding: appSidebarBinding,
            target: appSidebarBinding.target,
            renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        } satisfies PluginUiSurfacePlacementProjection;

        const tabs = resolveRightSidebarTabs({
            scope: 'app',
            pluginPlacements: [appSidebarPlacement],
        });

        // No app-scope built-in tabs exist; only the plugin tab resolves for scope 'app'.
        expect(tabs.map((tab) => tab.id)).toEqual([`plugin:${APP_PLUGIN_ID}:app-panel`]);
        expect(tabs.find((tab) => tab.id === `plugin:${APP_PLUGIN_ID}:app-panel`)).toMatchObject({
            owner: 'plugin',
            plugin: { pluginId: APP_PLUGIN_ID, descriptorId: 'app-panel' },
        });
    });

    // UI-D25: plugin tab ids are qualified `plugin:<pluginId>:<slug>`, so a plugin slug
    // spelled like a built-in tab id cannot collide with it. The tab must therefore stay
    // fully usable and merge alongside the built-in tab of the same NAME, not be reserved
    // away by a raw-slug guard.
    it('admits a plugin tab whose slug matches a built-in tab id, alongside that built-in tab', () => {
        const builtInNamedBinding = rightSidebarBinding(BROWSER_PLUGIN_ID, 'browser', 'session');
        const builtInNamedPlacement = {
            ...reviewSidebarPlacement,
            id: `surfacePlacement:${BROWSER_PLUGIN_ID}:browser`,
            pluginId: BROWSER_PLUGIN_ID,
            descriptorId: 'browser',
            binding: builtInNamedBinding,
            target: builtInNamedBinding.target,
            display: { developerFallback: 'Acme Browser' },
        } satisfies PluginUiSurfacePlacementProjection;

        const tabs = resolveRightSidebarTabs({
            scope: 'session',
            terminalTabAvailable: false,
            // Mobile presentation is the one that publishes the built-in `browser` tab (D1),
            // so both ids are live at once here.
            presentation: 'mobile',
            pluginPlacements: [builtInNamedPlacement],
        });

        expect(tabs.map((tab) => tab.id)).toContain('browser');
        const pluginTab = tabs.find((tab) => tab.id === `plugin:${BROWSER_PLUGIN_ID}:browser`);
        expect(pluginTab).toMatchObject({
            owner: 'plugin',
            label: 'Acme Browser',
            plugin: { pluginId: BROWSER_PLUGIN_ID, descriptorId: 'browser' },
        });
        expect(pluginTab?.disabledReason).toBeUndefined();
        // It is selectable, which a reserved/disabled tab never is.
        expect(resolveRightSidebarActiveTab(`plugin:${BROWSER_PLUGIN_ID}:browser`, tabs))
            .toBe(`plugin:${BROWSER_PLUGIN_ID}:browser`);
    });
});
