import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string) => true,
}));
const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        Text: 'Text',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => pathnameState.value,
        router: { navigate: routerNavigateSpy, push: routerPushSpy },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureGateState.enabled(featureId),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => {
            if (key === 'useProfiles') return false;
            return null;
        },
        useLocalSetting: (key: string) => {
            if (key === 'devModeEnabled') return false;
            if (key === 'uiFontScale') return 1;
            return null;
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: async () => {},
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

describe('SettingsSidebar', () => {
    afterEach(() => {
        pathnameState.value = '/settings';
        routerPushSpy.mockReset();
        routerNavigateSpy.mockReset();
        featureGateState.enabled = () => true;
        clearActiveUnsavedChangesGuard();
    });

    it('opens a sidebar destination within settings', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('exposes the Settings home page as the first/top-level entry', async () => {
        pathnameState.value = '/settings/account';

        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.settings');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings');
    });

    it('renders catalog groups as static section headers rather than pressable rows', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        // A group is a label, not a destination: no row, and nothing to press.
        expect(screen.findByTestId('settings-sidebar.section.groupGeneral')).toBeTruthy();
        expect(screen.findByTestId('settings-sidebar.item.groupGeneral')).toBeNull();
        expect(screen.findByTestId('settings-sidebar.toggle.groupGeneral')).toBeNull();

        // Its pages are therefore always reachable — there is no collapsed state to recover from.
        expect(screen.findByTestId('settings-sidebar.item.appearance')).toBeTruthy();
        expect(screen.findByTestId('settings-sidebar.item.language')).toBeTruthy();
    });

    it('keeps the Settings home row navigable and free of a disclosure toggle', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        expect(screen.findByTestId('settings-sidebar.item.settings')).toBeTruthy();
        expect(screen.findByTestId('settings-sidebar.toggle.settings')).toBeNull();
        // The home row stands alone above the first group — it gets no section label of its own.
        expect(screen.findByTestId('settings-sidebar.section.settings')).toBeNull();

        await screen.pressByTestIdAsync('settings-sidebar.item.settings');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings');
    });

    it('orders the rail as home row, then each section label above its own pages', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        // A row contributes several nodes carrying the same testID; keep first appearance only.
        const rail = [...new Set(screen
            .findAll((node: any) => typeof node.props?.testID === 'string'
                && /^settings-sidebar\.(item|section)\./.test(node.props.testID))
            .map((node: any) => node.props.testID.replace('settings-sidebar.', '')))];

        expect(rail[0]).toBe('item.settings');
        expect(rail[1]).toBe('section.groupProfileAndAccount');
        // A label owns the rows between it and the next label.
        expect(rail.slice(2, rail.indexOf('section.groupGeneral'))).toContain('item.account');
        expect(rail.indexOf('item.appearance')).toBeGreaterThan(rail.indexOf('section.groupGeneral'));
        expect(rail.indexOf('item.appearance')).toBeLessThan(rail.indexOf('section.groupAiAndAgents'));
    });

    it('seats the whole rail on the base surface, scroller included', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const root: any = screen.findByTestId('settings-sidebar');
        expect(flattenStyle(root.props.style).backgroundColor).toBe(lightTheme.colors.surface.base);

        // `ItemList` paints the canvas plane by default and covers the rail below the search
        // field, so the caller override is what actually makes the rail white.
        const scroller: any = screen.findAllByType('ScrollView')[0];
        expect(scroller).toBeTruthy();
        expect(flattenStyle(scroller.props.style).backgroundColor).toBe(lightTheme.colors.surface.base);
    });

    it('reveals the canonical scroll-edge affordances once the rail overflows', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const scroller: any = screen.findAllByType('ScrollView')[0];
        expect(scroller.props.onLayout).toBeTypeOf('function');
        // Nothing to signal until the rail knows it overflows.
        expect(collectIconNames(screen)).not.toContain('caret-down');

        await act(async () => {
            scroller.props.onLayout({ nativeEvent: { layout: { width: 230, height: 400 } } });
            scroller.props.onContentSizeChange(230, 1600);
        });

        // Trailing edge now has content behind it: the gradient fades into the rail's own
        // plane — any other colour would read as a band rather than a fade.
        const fade: any = screen.findAllByType('LinearGradient')[0];
        expect(fade).toBeTruthy();
        expect(fade.props.colors).toContain(lightTheme.colors.surface.base);
        expect(collectIconNames(screen)).toContain('caret-down');
    });

    it('marks the active row with a recessed chip and a weight change, not colour alone', async () => {
        pathnameState.value = '/settings/appearance';

        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const selected = resolveRowPressableStyle(screen, 'settings-sidebar.item.appearance');
        const plain = resolveRowPressableStyle(screen, 'settings-sidebar.item.language');

        // Grey chip on the white rail, and it comes from the app-wide selection token: the rail
        // must not become a second decision-maker for what "selected" looks like.
        expect(selected.backgroundColor).toBe(lightTheme.colors.surface.selected);
        expect(selected.backgroundColor).not.toBe(lightTheme.colors.surface.base);
        expect(selected.borderRadius).toBeGreaterThan(0);
        expect(plain.backgroundColor).not.toBe(lightTheme.colors.surface.selected);

        // WCAG 1.4.11: a ~1.09:1 fill cannot be the only selection indicator.
        const selectedWeight = resolveRowTitleWeight(screen, 'settings-sidebar.item.appearance');
        const plainWeight = resolveRowTitleWeight(screen, 'settings-sidebar.item.language');
        expect(selectedWeight).toBeTruthy();
        expect(selectedWeight).not.toBe(plainWeight);
    });

    it('supports page search and navigates when selecting a result', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'notif');
        });

        const row = screen.findByTestId('settings-sidebar.searchResult.notifications') as any;
        expect(row).toBeTruthy();
        const iconNames = row.findAllByType('Icon').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNames).toContain('magnifying-glass');
        expect(iconNames).not.toContain('caret-right');

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.notifications');

        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('keeps the current settings screen when a route row encounters dirty active work', async () => {
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsSidebar.test.route',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('discards dirty active work before navigating through a route row', async () => {
        const isDirtyRef = { current: true };
        const requestDecision = vi.fn(async () => 'discard' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef,
            requestDecision,
            tag: 'SettingsSidebar.test.discardRoute',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await screen.pressByTestIdAsync('settings-sidebar.item.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(isDirtyRef.current).toBe(false);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications');
    });

    it('keeps the current settings screen when a search result encounters dirty active work', async () => {
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsSidebar.test.search',
        });
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));
        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'notif');
        });

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.notifications');

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('finds the appearance page when searching for sidebar', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        await act(async () => {
            screen.changeTextByTestId('settings-sidebar.searchInput', 'sidebar');
        });

        await screen.pressByTestIdAsync('settings-sidebar.searchResult.appearance');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/appearance');
    });

    // Retargeted from `groupGeneral`: groups are static headers now, so the only rows that
    // still disclose children are the routed parents (machines / prompts / notifications).
    it('swaps a routed parent icon to a caret on hover', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const row = screen.findByTestId('settings-sidebar.item.machines') as any;
        expect(row).toBeTruthy();
        const iconNamesBefore = row.findAllByType('Icon').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesBefore).toContain('desktop');
        expect(iconNamesBefore).not.toContain('caret-down');
        expect(iconNamesBefore).not.toContain('caret-right');

        await act(async () => {
            row.props.onHoverIn?.();
        });

        const rowHovered = screen.findByTestId('settings-sidebar.item.machines') as any;
        expect(rowHovered).toBeTruthy();
        const iconNamesHovered = rowHovered.findAllByType('Icon').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesHovered).toContain('caret-right');

        await act(async () => {
            rowHovered.props.onHoverOut?.();
        });

        const rowAfter = screen.findByTestId('settings-sidebar.item.machines') as any;
        expect(rowAfter).toBeTruthy();
        const iconNamesAfter = rowAfter.findAllByType('Icon').map((node: any) => node.props?.name).filter(Boolean);
        expect(iconNamesAfter).toContain('desktop');
    });

    it('allows expanding a routed parent item via the hover chevron toggle', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        const machinesRow: any = screen.findByTestId('settings-sidebar.item.machines');
        expect(machinesRow).toBeTruthy();

        await act(async () => {
            machinesRow.props.onHoverIn?.();
        });

        await screen.pressByTestIdAsync('settings-sidebar.toggle.machines');
        expect(routerNavigateSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-sidebar.item.machinesAdd')).toBeTruthy();
    });
});

function collectIconNames(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.findAllByType('Icon').map((node: any) => node.props?.name).filter(Boolean);
}

function flattenStyle(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, any>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, any>;
    return {};
}

/** Item's row style is a function of press state; resolve it the way the renderer would. */
function resolveRowPressableStyle(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
): Record<string, any> {
    const row = screen.findAll((node: any) => (
        node.props?.testID === testID && typeof node.props?.style === 'function'
    ))[0];
    expect(row).toBeTruthy();
    return flattenStyle((row as any).props.style({ pressed: false }));
}

/** The non-colour half of the selection indicator: whatever carries the title's weight. */
function resolveRowTitleWeight(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
): string | number | undefined {
    const row: any = screen.findByTestId(testID);
    expect(row).toBeTruthy();
    const title = row.findAllByType('StyledText')[0];
    expect(title).toBeTruthy();
    const style = flattenStyle(title.props?.style);
    return style.fontWeight ?? style.fontFamily;
}
