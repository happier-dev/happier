/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
    reactNative: async () => await import('react-native-web'),
});

// The filters reach Platform through Home profiles; select the DOM adapter before loading that graph.
const { createSessionListViewFilterDefaults } = await import('./sessionListViewFilters');
// Resolve the real web graph before the timed DOM/portal interaction begins.
const { PopoverScope } = await import('@/components/ui/popover');
const { SessionListFilterEditorControl } = await import('./SessionListFilterEditorControl');
const { buildSessionListFilterEditorLabels } = await import('./SessionListFilterControl');

const labels = {
    ...buildSessionListFilterEditorLabels(),
    search: 'Search filters', show: 'Show', myWork: 'My work', assignedToMe: 'Assigned to me',
    scope: 'Scope', sessions: 'Sessions', runs: 'Runs', both: 'Both', startedBy: 'Started by',
    startedByYou: 'You', startedByTriggers: 'Triggers', startedByAgents: 'Agents',
    runsNeedingYouAlwaysShow: 'Runs that need you always show',
    onlyCoordinators: 'Only coordinators', onlyCoordinatorsDescription: 'Sessions coordinating other work',
    following: 'Following', involvingMe: 'Involving me', allAccessible: 'All accessible',
    attention: 'Attention', anyAttention: 'Any', needsMyAttention: 'Only sessions that need me',
    inactiveSessions: 'Inactive sessions', showInactive: 'Show', hideInactive: 'Hide', homes: 'Homes',
    sharedWith: 'Shared with', outsideTeams: 'Personal & direct', tags: 'Tags', source: 'Source',
    allSources: 'All', persistedSource: 'Saved in Happier', directSource: 'External', noOptions: 'No options',
    clear: 'Reset', done: 'Done', title: 'Session filters', archived: 'Archived',
    needsMeOnly: 'Needs me only', needsMeOnlyDescription: 'Sessions waiting on you',
    moreTags: (count: number) => `+ ${count} more`,
    resultCount: (count: number) => `${count} sessions`,
} as const;

function rect(x: number, y: number, width: number, height: number): DOMRect {
    return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({}),
    };
}

describe('SessionListFilterEditorControl portal ownership', () => {
    it('mounts the opened web editor in the modal-aware portal host and closes it before opening Archived', async () => {
        const openArchived = vi.fn();
        const container = document.createElement('div');
        container.setAttribute('data-testid', 'sidebar-source');
        document.body.appendChild(container);
        const root = createRoot(container);
        const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

        HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this.getAttribute('data-testid') === 'session-list-filter-trigger') {
                return rect(24, 24, 180, 44);
            }
            return rect(24, 74, 360, 480);
        };
        globalThis.requestAnimationFrame = (callback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

        // A desktop web window: jsdom reports a 0×0 viewport, which the device owner reads as a phone,
        // and a phone takes the editor as a sheet (lab `clfilter:filterP`) instead of this anchored popover.
        const viewport = document.documentElement;
        Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1440 });
        Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 940 });
        window.dispatchEvent(new Event('resize'));

        try {
            const filters = createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] });
            await act(async () => {
                root.render(
                    <PopoverScope>
                        <div data-testid="sidebar-inline-branch">
                            <SessionListFilterEditorControl
                                label="My work"
                                active={false}
                                editor={{
                                    filters,
                                    includeInactive: false,
                                    queryEnabled: false,
                                    followingAvailable: false,
                                    sourceAvailable: true,
                                    homes: [{ serverId: 'home-a', label: 'Home A' }],
                                    audiences: [],
                                    tags: [],
                                    labels,
                                    updateFilters: () => {},
                                    removeAuthoritativelyDeletedSelections: () => {},
                                    setIncludeInactive: () => {},
                                    setSource: () => {},
                                    resetFilters: () => {},
                                    onOpenArchived: openArchived,
                                }}
                            />
                        </div>
                    </PopoverScope>,
                );
            });

            const trigger = container.querySelector<HTMLElement>('[data-testid="session-list-filter-trigger"]');
            expect(trigger).not.toBeNull();
            expect(trigger?.getAttribute('aria-expanded')).toBe('false');
            expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
            expect(trigger?.getAttribute('aria-pressed')).toBe('false');
            await act(async () => {
                trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            expect(trigger?.getAttribute('aria-expanded')).toBe('true');

            const editorSurface = document.querySelector<HTMLElement>(
                '[data-testid="session-list-filter-editor-surface"]',
            );
            const portalHost = document.querySelector<HTMLElement>('[data-happy-popover-portal-host]');
            const inlineBranch = container.querySelector<HTMLElement>('[data-testid="sidebar-inline-branch"]');
            expect(editorSurface).not.toBeNull();
            expect(portalHost).not.toBeNull();
            expect(portalHost?.contains(editorSurface)).toBe(true);
            expect(inlineBranch?.contains(editorSurface)).toBe(false);
            // The filter (lab `clfilter:filter`) is a compact ~356px surface, never the sidebar's full width.
            const surfaceMaxWidths: string[] = [];
            for (let node = editorSurface?.parentElement ?? null; node && node !== portalHost; node = node.parentElement) {
                if (node.style.maxWidth) surfaceMaxWidths.push(node.style.maxWidth);
            }
            expect(surfaceMaxWidths).toEqual(['356px']);

            // Archived is Whose's one destination: it leaves the editor, then opens the list.
            const whose = document.querySelector<HTMLElement>('[data-testid="collection-filter-condition:scope:is:value"]');
            expect(whose).not.toBeNull();
            await act(async () => {
                whose!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            const archivedOption = document.querySelector<HTMLElement>(
                '[data-testid="session-list-filter-editor:session-list-filters:option:destination:archived"]',
            );
            expect(archivedOption).not.toBeNull();
            await act(async () => {
                archivedOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            expect(openArchived).toHaveBeenCalledTimes(1);
            expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        } finally {
            await act(async () => root.unmount());
            HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            delete (viewport as unknown as Record<string, unknown>).clientWidth;
            delete (viewport as unknown as Record<string, unknown>).clientHeight;
            container.remove();
        }
    });
});
