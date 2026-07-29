import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: React.forwardRef((props: any, ref: any) => (
                React.createElement('Pressable', { ...props, ref }, props.children)
            )),
        });
    },
});

const theme = lightTheme;

const TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
    { id: 'gamma', label: 'Gamma' },
];

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false, hovered: false, focused: false }));
    }
    if (!Array.isArray(style)) {
        return (style ?? {}) as Record<string, unknown>;
    }

    return style.reduce<Record<string, unknown>>((acc, entry) => ({
        ...acc,
        ...(entry ?? {}),
    }), {});
}

function requireTab(screen: RenderedScreen, testID: string) {
    const tab = screen.findByTestId(testID);
    expect(tab).toBeTruthy();
    return tab!;
}

function requireTabLabel(screen: RenderedScreen, testID: string): string {
    const tab = requireTab(screen, testID);
    const labelNode = tab.findByType('Text' as never);
    return labelNode.props.children;
}

describe('SegmentedTabBar', () => {
    it('renders all tab labels', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(requireTabLabel(screen, 'seg:alpha')).toBe('Alpha');
        expect(requireTabLabel(screen, 'seg:beta')).toBe('Beta');
        expect(requireTabLabel(screen, 'seg:gamma')).toBe('Gamma');
    });

    it('calls onSelectTab with the tab id when a tab is pressed', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();

        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        screen.pressByTestId('seg:beta');
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('beta');

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledTimes(2);
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });

    it('sets testIDs when testIDPrefix is provided', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(screen.findByTestId('seg:alpha')?.props.testID).toBe('seg:alpha');
        expect(screen.findByTestId('seg:beta')?.props.testID).toBe('seg:beta');
        expect(screen.findByTestId('seg:gamma')?.props.testID).toBe('seg:gamma');
    });

    it('does not set testIDs when testIDPrefix is omitted', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(<SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} />);

        for (const tabId of ['alpha', 'beta', 'gamma'] as const) {
            expect(screen.findByTestId(tabId)).toBeNull();
        }
    });

    it('keeps a ≥44px web target without relying on unsupported web hit-slop', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');

        const regular = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );
        const regularTab = regular.findByTestId('seg:alpha');
        const regularFlat = flattenStyle(regularTab?.props.style);
        expect(regularFlat.minHeight).toBeGreaterThanOrEqual(44);
        expect(regularFlat.minWidth).toBeGreaterThanOrEqual(44);

        const compact = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" compact />,
        );
        const compactTab = compact.findByTestId('seg:alpha');
        const compactFlat = flattenStyle(compactTab?.props.style);
        expect(compactFlat.minHeight).toBeGreaterThanOrEqual(44);
        expect(compactFlat.minWidth).toBeGreaterThanOrEqual(44);
    });

    it('keeps a ≥48dp Android target for regular and compact tabs', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const { SegmentedTabBar } = await import('./SegmentedTabBar');
            const regular = await renderScreen(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
            );
            const compact = await renderScreen(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="compact" compact />,
            );

            const regularTab = requireTab(regular, 'seg:alpha');
            const compactTab = requireTab(compact, 'compact:alpha');
            expect(flattenStyle(regularTab.props.style).minWidth).toBeGreaterThanOrEqual(48);
            expect(flattenStyle(compactTab.props.style).minWidth).toBeGreaterThanOrEqual(48);
            expect(regularTab.props.hitSlop).toMatchObject({ top: 10, bottom: 10 });
            expect(compactTab.props.hitSlop).toMatchObject({ top: 14, bottom: 14 });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('applies active styles only to the active tab', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        // Tabs should expose the selected state for accessibility (web: aria-selected).
        expect(screen.findByTestId('seg:beta')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:beta')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('seg:beta')?.props['aria-selected']).toBe(true);
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityState).toEqual({ selected: false });
        expect(screen.findByTestId('seg:alpha')?.props['aria-selected']).toBe(false);
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityState).toEqual({ selected: false });
        expect(screen.findByTestId('seg:gamma')?.props['aria-selected']).toBe(false);

        // The active tab ("beta") should include the tabActive background color.
        const activeFlat = flattenStyle(screen.findByTestId('seg:beta')?.props.style);
        expect(activeFlat.backgroundColor).toBe(theme.colors.surface.base);
        expect(screen.findByTestId('seg:beta')?.findByType('LinearGradient' as never).props.colors).toEqual(
            theme.colors.segmentedControl.activeGradient?.colors,
        );

        // Inactive tabs should NOT have the active background color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.props.style).backgroundColor).not.toBe(theme.colors.surface.base);
        }

        // The active tab's label should use the active text color.
        const activeLabelFlat = flattenStyle(screen.findByTestId('seg:beta')?.findByType('Text' as never).props.style);
        expect(activeLabelFlat.color).toBe(theme.colors.text.primary);
        expect(activeLabelFlat.fontWeight).toBe('600');

        // Inactive labels should use the secondary text color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.findByType('Text' as never).props.style).color).toBe(
                theme.colors.text.secondary,
            );
        }
    });

    it('slidingThumb replaces per-tab active surfaces with one shared thumb (D-R3-5)', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" slidingThumb />,
        );

        // No per-tab active background: the active tab must NOT carry the
        // activeBackground color (the thumb owns the active surface).
        const activeFlat = flattenStyle(screen.findByTestId('seg:beta')?.props.style);
        expect(activeFlat.backgroundColor).not.toBe(theme.colors.surface.base);
        // Selection state + label emphasis still apply.
        expect(screen.findByTestId('seg:beta')?.props.accessibilityState).toEqual({ selected: true });
        const activeLabelFlat = flattenStyle(screen.findByTestId('seg:beta')?.findByType('Text' as never).props.style);
        expect(activeLabelFlat.color).toBe(theme.colors.text.primary);
        // Thumb mounts once the active tab reports a layout rect.
        const { act } = await import('react');
        const beta = screen.findByTestId('seg:beta');
        expect(typeof beta?.props.onLayout).toBe('function');
        await act(async () => {
            beta!.props.onLayout({ nativeEvent: { layout: { x: 46, width: 44, y: 2, height: 24 } } });
        });
        expect(screen.findByTestId('seg:thumb')).toBeTruthy();
    });

    it('content sizing hugs labels instead of splitting the row equally (D-R3-3)', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" segmentSizing="content" />,
        );

        const tabFlat = flattenStyle(screen.findByTestId('seg:alpha')?.props.style);
        // Segments hug their label (label-sized, no equal stretch) so a short
        // label never ellipsizes into "Tok…". Must be expressed as
        // `flexBasis: 'auto'` + grow/shrink 0 and NEVER the `flex: 0` shorthand:
        // on react-native-web `flex: 0` forces `flex-basis: 0%`, which — with the
        // tab's `overflow: 'hidden'` — collapses the segment to padding-only
        // width and clips the label to nothing (the "naked Switch" regression).
        expect(tabFlat.flex).toBeUndefined();
        expect(tabFlat.flexBasis).toBe('auto');
        expect(tabFlat.flexGrow).toBe(0);
        expect(tabFlat.flexShrink).toBe(0);
        expect(tabFlat.paddingHorizontal).toBe(12);
    });

    it('uses a roving 44px tab target and supports Arrow, Home, End, Space, and single-fire Enter', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const focusByTestId = new Map<string, ReturnType<typeof vi.fn>>();
        const screen = await renderScreen(
            <SegmentedTabBar
                tabs={TABS}
                activeTabId="beta"
                onSelectTab={onSelectTab}
                testIDPrefix="seg"
                compact
                accessibilityLabel="Thinking effort"
            />,
            {
                createNodeMock: (element) => {
                    const testID = (element.props as { testID?: string }).testID;
                    if (typeof testID !== 'string' || !testID.startsWith('seg:')) return {};
                    const focus = vi.fn();
                    focusByTestId.set(testID, focus);
                    return { focus };
                },
            },
        );

        const alpha = requireTab(screen, 'seg:alpha');
        const beta = requireTab(screen, 'seg:beta');
        const gamma = requireTab(screen, 'seg:gamma');
        expect(beta.props.tabIndex).toBe(0);
        expect(alpha.props.tabIndex).toBe(-1);
        expect(gamma.props.tabIndex).toBe(-1);
        expect(beta.parent?.props.accessibilityLabel).toBe('Thinking effort');
        expect(flattenStyle(alpha.props.style).minHeight).toBeGreaterThanOrEqual(44);

        const keyEvent = (key: string) => ({
            key,
            nativeEvent: { key },
            preventDefault: vi.fn(),
        });
        await act(async () => {
            beta.props.onKeyDown(keyEvent('ArrowRight'));
        });
        expect(onSelectTab).toHaveBeenLastCalledWith('gamma');
        expect(focusByTestId.get('seg:gamma')).toHaveBeenCalledOnce();

        await act(async () => {
            beta.props.onKeyDown(keyEvent('ArrowLeft'));
            beta.props.onKeyDown(keyEvent('Home'));
            beta.props.onKeyDown(keyEvent('End'));
            beta.props.onKeyDown(keyEvent(' '));
        });
        expect(onSelectTab.mock.calls.map(([id]) => id)).toEqual([
            'gamma',
            'alpha',
            'alpha',
            'gamma',
            'beta',
        ]);

        // React Native Web's Pressable owns Enter and dispatches `onPress` on
        // keyup. The tab's supplemental key handler must not also select on
        // keydown, otherwise one Enter activation fires twice.
        await act(async () => {
            beta.props.onKeyDown(keyEvent('Enter'));
        });
        screen.pressByTestId('seg:beta');
        expect(onSelectTab.mock.calls.map(([id]) => id)).toEqual([
            'gamma',
            'alpha',
            'alpha',
            'gamma',
            'beta',
            'beta',
        ]);
    });

    it('follows visual ArrowLeft and ArrowRight order in RTL layouts', async () => {
        const { I18nManager } = await import('react-native');
        const previousIsRTL = I18nManager.isRTL;
        (I18nManager as { isRTL: boolean }).isRTL = true;
        try {
            const { SegmentedTabBar } = await import('./SegmentedTabBar');
            const onSelectTab = vi.fn();
            const screen = await renderScreen(
                <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={onSelectTab} testIDPrefix="seg" />,
            );
            const beta = requireTab(screen, 'seg:beta');
            beta.props.onKeyDown({ key: 'ArrowRight', nativeEvent: { key: 'ArrowRight' }, preventDefault: vi.fn() });
            beta.props.onKeyDown({ key: 'ArrowLeft', nativeEvent: { key: 'ArrowLeft' }, preventDefault: vi.fn() });
            expect(onSelectTab.mock.calls.map(([id]) => id)).toEqual(['alpha', 'gamma']);
        } finally {
            (I18nManager as { isRTL: boolean }).isRTL = previousIsRTL;
        }
    });

    it('paints a visible web focus ring without changing the selected tab state', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        const beta = requireTab(screen, 'seg:beta');
        expect(typeof beta.props.style).toBe('function');
        const focusedStyle = flattenStyle(beta.props.style({
            pressed: false,
            hovered: false,
            focused: true,
        }));
        expect(focusedStyle.outlineStyle).toBe('solid');
        expect(focusedStyle.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(focusedStyle.outlineColor).toBe(theme.colors.border.strong);
        expect(beta.props.accessibilityState).toEqual({ selected: false });
    });
});
