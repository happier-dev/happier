/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// Keep the rail, DropdownMenu, IconButton and HappierPressable real. Native
// styling, routing and the web/native package adapters are platform boundaries.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsRealModule());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';

describe('AppRail More activation through DropdownMenu', () => {
    it.each(['pointer', 'Enter', ' '] as const)('opens and announces its menu with %s', async (input) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
        const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(577);
        window.dispatchEvent(new Event('resize'));
        const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 100, 36, 36));
        const entries = buildAppRailEntries(resolveCompactAppDestinations({
            builtins: { externalSessions: true, inbox: true, workflows: true, friends: true }, pages: [],
        }));
        try {
            await act(async () => {
                root.render(<InjectedAuthProvider credentials={null}><InboxSummaryProvider>
                    <AppRailSurface entries={entries} activeId={null} onOpen={() => {}}
                        preferences={{ orderedIds: [], placements: { projects: 'overflow' } }}
                        renderFooter={() => null} onCustomize={() => {}} />
                </InboxSummaryProvider></InjectedAuthProvider>);
            });
            const trigger = container.querySelector<HTMLElement>('[data-testid="app-rail-more.trigger"]');
            expect(trigger).not.toBeNull();
            expect(trigger!.getAttribute('aria-expanded')).toBe('false');
            await act(async () => {
                if (input === 'pointer') {
                    trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                    trigger!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                    trigger!.click();
                } else {
                    trigger!.focus();
                    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: input, bubbles: true }));
                    trigger!.dispatchEvent(new KeyboardEvent('keyup', { key: input, bubbles: true }));
                    // jsdom does not synthesize native button activation from keys.
                    if (trigger!.tagName === 'BUTTON') trigger!.click();
                }
            });
            await vi.waitFor(() => {
                expect(trigger!.getAttribute('aria-expanded')).toBe('true');
                expect(document.querySelector('[data-testid="app-rail-more:projects"]')).not.toBeNull();
            });
        } finally {
            await act(async () => root.unmount());
            container.remove();
            bounds.mockRestore();
            width.mockRestore();
            height.mockRestore();
        }
    });

    // SHELL-ACCEPT-1116 (b): Machines, the last row of More, did nothing on click. A footer control in More runs its
    // own trigger (its roster popover) from the row.
    it('runs a footer control from its More row by pointer', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        const width = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
        const height = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(577);
        window.dispatchEvent(new Event('resize'));
        const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 100, 36, 36));
        const entries = buildAppRailEntries(resolveCompactAppDestinations({
            builtins: { externalSessions: true, inbox: true, workflows: true, friends: true }, pages: [],
        }));
        const openRoster = vi.fn();
        try {
            await act(async () => {
                root.render(<InjectedAuthProvider credentials={null}><InboxSummaryProvider>
                    <AppRailSurface entries={entries} activeId={null} onOpen={() => {}}
                        preferences={{ orderedIds: [], placements: { projects: 'overflow' } }}
                        renderFooter={(item, trigger) => item.id === 'app-rail-machines' && trigger
                            ? trigger({ onPress: openRoster, open: false }) : null}
                        onCustomize={() => {}} />
                </InboxSummaryProvider></InjectedAuthProvider>);
            });
            const trigger = container.querySelector<HTMLElement>('[data-testid="app-rail-more.trigger"]')!;
            await act(async () => { trigger.click(); });
            const row = await vi.waitFor(() => {
                const found = document.querySelector<HTMLElement>('[data-testid="app-rail-more:app-rail-machines"]');
                expect(found).not.toBeNull();
                return found!;
            });
            await act(async () => {
                row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                row.click();
            });
            await vi.waitFor(() => expect(openRoster).toHaveBeenCalledTimes(1));
        } finally {
            await act(async () => root.unmount());
            container.remove();
            bounds.mockRestore();
            width.mockRestore();
            height.mockRestore();
        }
    });
});
