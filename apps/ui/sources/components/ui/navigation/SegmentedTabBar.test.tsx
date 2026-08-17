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

/**
 * The drawn segment: the Pressable is the press FRAME (transparent, grown by padding and pulled
 * back by an equal negative margin), and its first child View is the box that actually paints.
 */
function requireTabSurface(screen: RenderedScreen, testID: string) {
    const surface = requireTab(screen, testID).findAllByType('View' as never)[0];
    expect(surface).toBeTruthy();
    return surface!;
}

/** The track the segments sit in. Its padding is the only vertical space the frame may take. */
function requireTrack(screen: RenderedScreen, testID: string) {
    const track = requireTab(screen, testID).parent;
    expect(track).toBeTruthy();
    return track!;
}

/**
 * Every vertical number this component actually renders, read back off the tree.
 *
 * Deliberately NOT a copy of the implementation's constants: a literal mirrored from the source
 * moves with it, so an assertion against that literal can never fail. These are the numbers a
 * browser would see.
 */
function measureSegment(screen: RenderedScreen, testID: string) {
    const frame = flattenStyle(requireTab(screen, testID).props.style);
    const surface = flattenStyle(requireTabSurface(screen, testID).props.style);
    const track = flattenStyle(requireTrack(screen, testID).props.style);
    return {
        framePaddingY: (frame.paddingVertical ?? 0) as number,
        frameMarginY: (frame.marginVertical ?? 0) as number,
        surfacePaddingY: (surface.paddingVertical ?? 0) as number,
        trackPadding: (track.padding ?? 0) as number,
    };
}

/** The rendered glyph slot of an icon-only bar — the one content box whose height IS in the tree. */
function measureIconSlotHeight(screen: RenderedScreen, testID: string): number {
    const slot = requireTab(screen, testID).findByType('Glyph' as never).parent!;
    return flattenStyle(slot.props.style).height as number;
}

const ICON_TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = TABS.map((tab) => ({
    ...tab,
    icon: React.createElement('Glyph', { key: tab.id }),
}));

/** WCAG 2.2 Level AA, SC 2.5.8 Target Size (Minimum): 24 x 24 CSS px. */
const WCAG_MINIMUM_TARGET_PX = 24;

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

    // The visible control is padding-driven, exactly as it was before a `minHeight: 44` was added
    // to buy a web target: that inflated the DRAWN box by ~15px in every consumer. The target now
    // comes from the press frame, which is invisible because its padding is cancelled by an equal
    // negative margin.
    it('draws each segment at its padding-driven height, not at the platform target', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');

        const regular = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );
        const regularFrame = flattenStyle(requireTab(regular, 'seg:alpha').props.style);
        const regularSurface = flattenStyle(requireTabSurface(regular, 'seg:alpha').props.style);
        expect(regularSurface.paddingVertical).toBe(7);
        expect(regularSurface.minHeight).toBeUndefined();
        expect(regularFrame.minHeight).toBeUndefined();

        const compact = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" compact />,
        );
        const compactSurface = flattenStyle(requireTabSurface(compact, 'seg:alpha').props.style);
        expect(compactSurface.paddingVertical).toBe(4);
        expect(compactSurface.minHeight).toBeUndefined();
        expect(flattenStyle(requireTab(compact, 'seg:alpha').props.style).minHeight).toBeUndefined();

        // Compact stays meaningfully shorter than the default.
        expect(
            flattenStyle(requireTabSurface(compact, 'seg:alpha').props.style).paddingVertical as number,
        ).toBeLessThan(
            flattenStyle(requireTabSurface(regular, 'seg:alpha').props.style).paddingVertical as number,
        );
    });

    /**
     * The press frame may fill the track and may NOT leave it.
     *
     * A segment has no sibling above or below it INSIDE the track, which is why the frame can grow
     * at all — but the track is not the end of the world. Every consumer stacks this bar against
     * something: in the model card the next control's own segmented bar is ~13px below, so a frame
     * overhanging the track by 10-12px on each side puts two tab targets on top of one another,
     * which DESIGN.md forbids in the same sentence that asks for 44/48. The track's own padding is
     * the only vertical space this component owns, so that is all it may take.
     */
    it('never lets a press frame leave the track it sits in', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;

        for (const platform of ['web', 'ios', 'android'] as const) {
            (Platform as { OS: string }).OS = platform;
            try {
                for (const compact of [false, true] as const) {
                    for (const tabs of [TABS, ICON_TABS] as const) {
                        const screen = await renderScreen(
                            <SegmentedTabBar
                                tabs={tabs}
                                activeTabId="alpha"
                                onSelectTab={() => {}}
                                testIDPrefix="seg"
                                compact={compact}
                            />,
                        );
                        const measured = measureSegment(screen, 'seg:alpha');
                        const context = `${platform}/${compact ? 'compact' : 'regular'}/${tabs === ICON_TABS ? 'icon' : 'label'}`;

                        expect(`${context}: ${measured.framePaddingY}`)
                            .toBe(`${context}: ${measured.trackPadding}`);
                        // Cancelled by an equal negative margin, so the row still measures the
                        // drawn segment and the frame stays invisible.
                        expect(measured.frameMarginY).toBe(-measured.framePaddingY);
                        // Nothing sideways: segments are flush siblings, so the horizontal budget
                        // is zero on every platform.
                        expect(measured.trackPadding).toBeGreaterThan(0);
                    }
                }
            } finally {
                (Platform as { OS: string }).OS = previousPlatform;
            }
        }
    });

    /**
     * CEILING, recorded honestly: the frame stops at the track, so the 44pt/48dp platform floor is
     * NOT reached on any variant. What the control does clear on every variant is WCAG 2.2 Level AA
     * SC 2.5.8 (24 x 24 CSS px), which DESIGN.md routes a dense pointer layout to. The icon-only
     * path is the one where the whole target height is readable from the tree, because its content
     * box carries an explicit height; the label path's content box is a font line box that no
     * test renderer measures.
     */
    it('clears the WCAG minimum target on the icon-only path without reaching the platform floor', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;

        for (const platform of ['web', 'android'] as const) {
            (Platform as { OS: string }).OS = platform;
            try {
                for (const compact of [false, true] as const) {
                    const screen = await renderScreen(
                        <SegmentedTabBar
                            tabs={ICON_TABS}
                            activeTabId="alpha"
                            onSelectTab={() => {}}
                            testIDPrefix="seg"
                            compact={compact}
                        />,
                    );
                    const measured = measureSegment(screen, 'seg:alpha');
                    const targetHeight = measureIconSlotHeight(screen, 'seg:alpha')
                        + measured.surfacePaddingY * 2
                        + measured.framePaddingY * 2;
                    const context = `${platform}/${compact ? 'compact' : 'regular'}`;

                    expect(`${context}: ${targetHeight >= WCAG_MINIMUM_TARGET_PX}`).toBe(`${context}: true`);
                    // 38 regular / 32 compact — the real per-variant numbers, not the 28/20 that
                    // only ever applied to a LABEL bar.
                    expect(`${context}: ${targetHeight}`).toBe(`${context}: ${compact ? 32 : 38}`);
                    expect(targetHeight).toBeLessThan(44);
                }
            } finally {
                (Platform as { OS: string }).OS = previousPlatform;
            }
        }
    });

    // Segments sit flush inside the track (no gap), so the horizontal budget is zero: any sideways
    // growth would put two tab targets on top of each other, which DESIGN.md forbids outright.
    it('never widens a segment press frame into its flush neighbour', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        for (const tabId of ['alpha', 'beta', 'gamma'] as const) {
            const frame = flattenStyle(requireTab(screen, `seg:${tabId}`).props.style);
            expect(frame.marginHorizontal ?? 0).toBe(0);
            expect(frame.marginLeft ?? 0).toBe(0);
            expect(frame.marginRight ?? 0).toBe(0);
            expect(frame.paddingHorizontal ?? 0).toBe(0);
        }
    });

    // A 44px per-segment floor multiplies: six effort segments needed 6x44 + 4 = 268px of track,
    // and `minWidth` beats `flexShrink`, so a narrower card overflowed instead of sharing the row.
    // WCAG 2.2 AA SC 2.5.8's 24px is the floor that actually governs a dense flush row.
    it('caps the per-segment width floor at the WCAG target size so a many-segment bar still fits', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" compact />,
        );

        const frame = flattenStyle(requireTab(screen, 'seg:alpha').props.style);
        expect(frame.minWidth).toBe(24);
        expect((frame.minWidth as number) * 6 + 4).toBeLessThanOrEqual(148);
    });

    // The frame is plain box model rather than `hitSlop` because react-native-web 0.21 implements
    // `hitSlop` only in its legacy `Touchable` export, and the desktop app IS the web bundle. It
    // must not come back on native either: hit-slop is exactly the overhang this control cannot
    // afford, and a target the web cannot see is not a target.
    it('declares no hit-slop on any platform', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        try {
            for (const platform of ['web', 'ios', 'android'] as const) {
                (Platform as { OS: string }).OS = platform;
                const { SegmentedTabBar } = await import('./SegmentedTabBar');
                const screen = await renderScreen(
                    <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" compact />,
                );
                expect(`${platform}: ${requireTab(screen, 'seg:alpha').props.hitSlop}`).toBe(`${platform}: undefined`);
            }
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    // Icons replace labels only when EVERY tab supplies one; a half-iconic row reads as broken.
    it('renders an icon-only bar with the label as its accessible name, and keeps mixed bars textual', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { SEGMENTED_TAB_ICON_SIZE_PX } = await import('./SegmentedTabBar');

        const iconic = await renderScreen(
            <SegmentedTabBar tabs={ICON_TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );
        const alpha = requireTab(iconic, 'seg:alpha');
        expect(alpha.findAllByType('Text' as never)).toHaveLength(0);
        expect(alpha.findAllByType('Glyph' as never)).toHaveLength(1);
        // The label survives as the accessible name and as the pointer tooltip.
        expect(alpha.props.accessibilityLabel).toBe('Alpha');
        expect((alpha.props as { title?: string }).title).toBe('Alpha');
        // The glyph slot is sized to the glyph, not to the 16px label it replaces.
        expect(measureIconSlotHeight(iconic, 'seg:alpha')).toBe(SEGMENTED_TAB_ICON_SIZE_PX);

        const mixed = await renderScreen(
            <SegmentedTabBar
                tabs={[ICON_TABS[0]!, TABS[1]!, TABS[2]!]}
                activeTabId="alpha"
                onSelectTab={() => {}}
                testIDPrefix="mix"
            />,
        );
        expect(requireTabLabel(mixed, 'mix:alpha')).toBe('Alpha');
        expect(requireTab(mixed, 'mix:alpha').findAllByType('Glyph' as never)).toHaveLength(0);
        expect((requireTab(mixed, 'mix:alpha').props as { title?: string }).title).toBeUndefined();
    });

    // Selection still works through an icon-only bar: the glyph is the only thing to press.
    it('selects through an icon-only segment', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar tabs={ICON_TABS} activeTabId="alpha" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });

    it('applies active styles only to the active tab', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        // Tabs should expose the selected state for accessibility (web: aria-selected).
        expect(screen.findByTestId('seg:beta')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:beta')?.props.accessibilityState).toEqual({ selected: true, disabled: false });
        expect(screen.findByTestId('seg:beta')?.props['aria-selected']).toBe(true);
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(screen.findByTestId('seg:alpha')?.props['aria-selected']).toBe(false);
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(screen.findByTestId('seg:gamma')?.props['aria-selected']).toBe(false);

        // The active tab ("beta") should include the tabActive background color — on the DRAWN
        // surface, never on the press frame, which would paint the enlarged target.
        const activeFlat = flattenStyle(requireTabSurface(screen, 'seg:beta').props.style);
        expect(activeFlat.backgroundColor).toBe(theme.colors.surface.base);
        expect(flattenStyle(screen.findByTestId('seg:beta')?.props.style).backgroundColor).toBeUndefined();
        expect(screen.findByTestId('seg:beta')?.findByType('LinearGradient' as never).props.colors).toEqual(
            theme.colors.segmentedControl.activeGradient?.colors,
        );

        // Inactive tabs should NOT have the active background color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(requireTabSurface(screen, testID).props.style).backgroundColor).not.toBe(theme.colors.surface.base);
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
        const activeFlat = flattenStyle(requireTabSurface(screen, 'seg:beta').props.style);
        expect(activeFlat.backgroundColor).not.toBe(theme.colors.surface.base);
        // Selection state + label emphasis still apply.
        expect(screen.findByTestId('seg:beta')?.props.accessibilityState).toEqual({ selected: true, disabled: false });
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
        const surfaceFlat = flattenStyle(requireTabSurface(screen, 'seg:alpha').props.style);
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
        // The horizontal breathing room belongs to the DRAWN surface: on the press frame it would
        // inset the active background by 12px on each side.
        expect(surfaceFlat.paddingHorizontal).toBe(12);
    });

    it('roves focus across tabs and supports Arrow, Home, End, Space, and single-fire Enter', async () => {
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

        // The ring rides the DRAWN surface, not the taller press frame — a ring around the frame
        // would outline a box ~16px taller than the control the user can see.
        const beta = requireTab(screen, 'seg:beta');
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).outlineStyle).toBeUndefined();
        await act(async () => {
            beta.props.onFocus?.({});
        });
        const focusedStyle = flattenStyle(requireTabSurface(screen, 'seg:beta').props.style);
        expect(focusedStyle.outlineStyle).toBe('solid');
        expect(focusedStyle.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(focusedStyle.outlineColor).toBe(theme.colors.border.strong);
        expect(requireTab(screen, 'seg:beta').props.accessibilityState).toEqual({ selected: false, disabled: false });

        await act(async () => {
            requireTab(screen, 'seg:beta').props.onBlur?.({});
        });
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).outlineStyle).toBeUndefined();
    });

    // A `pointerEvents: 'none'` wrapper silences the pointer but leaves every segment announcing
    // as an enabled tab and reachable by keyboard. `disabled` has to reach the rendered segments.
    it('announces every segment as disabled, dims the track, and refuses selection when disabled', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={onSelectTab} testIDPrefix="seg" disabled />,
        );

        for (const tabId of ['alpha', 'beta', 'gamma'] as const) {
            const tab = requireTab(screen, `seg:${tabId}`);
            expect(tab.props.accessibilityState).toEqual({ selected: tabId === 'beta', disabled: true });
            expect(tab.props['aria-disabled']).toBe(true);
            expect(tab.props.disabled).toBe(true);
            // Never focusable while disabled — not even the selected segment.
            expect(tab.props.tabIndex).toBe(-1);
        }

        // The dim comes from the bar's own themed track style, not a caller-side opacity wrapper.
        const track = requireTab(screen, 'seg:beta').parent!;
        expect(flattenStyle(track.props.style).opacity).toBe(0.5);

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).not.toHaveBeenCalled();
    });

    it('stays interactive and undimmed when disabled is not set', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        const track = requireTab(screen, 'seg:beta').parent!;
        expect(flattenStyle(track.props.style).opacity).toBeUndefined();
        expect(requireTab(screen, 'seg:beta').props.tabIndex).toBe(0);

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });
});
