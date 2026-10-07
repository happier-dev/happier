import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { AppRailSurface } from './AppRail';
import { buildAppRailEntries, buildAppRailPlacementItems } from './appRailModel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ styleSheet: { hairlineWidth: 1 } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Portal measurement is a platform boundary; the rail, menu and placement owner stay real.
vi.mock('@/components/ui/popover', () => ({ Popover: (props: { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) =>
    <>{props.children({ maxHeight: 600, maxWidth: 400 })}</> }));

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

describe('AppRail native customization recovery', () => {
    it('keeps a touch-accessible Customize entry when every catalog control is hidden', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const entries = buildAppRailEntries(resolveCompactAppDestinations({
            builtins: { externalSessions: true, inbox: true, workflows: true, friends: true }, pages: [],
        }), { includeHidden: true });
        const items = buildAppRailPlacementItems(entries, true);
        const customize = vi.fn();
        const screen = await renderScreen(<AppRailSurface entries={entries} activeId={null} onOpen={() => {}}
            updatesVisible onCustomize={customize}
            preferences={{ orderedIds: [], placements: Object.fromEntries(items.map(item => [item.id, 'hidden' as const])) }} />);

        expect(screen.findHostByTestId('app-rail')?.props.onContextMenu).toBeUndefined();
        const more = screen.findHostByTestId('app-rail-more.trigger');
        expect(more).not.toBeNull();
        expect(more?.props.accessibilityRole).toBe('button');
        expect(more?.props.accessibilityLabel).toBeTruthy();
        for (const item of items) {
            expect(screen.findHostByTestId(item.kind === 'destination' ? `app-rail:${item.id}` : item.id)).toBeNull();
        }
        await screen.pressByTestIdAsync('app-rail-more.trigger');
        await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
        for (const item of items) expect(screen.findHostByTestId(`app-rail-more:${item.id}`)).toBeNull();
        await screen.pressByTestIdAsync('app-rail-more.customize');
        expect(customize).toHaveBeenCalledOnce();
    });
});
