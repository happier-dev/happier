// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme } from '@/theme';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';

const materialThemeState = vi.hoisted(() => ({ dark: false }));


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const boundary = await createUnistylesMock();
        return {
            ...boundary,
            useUnistyles: () => ({ ...boundary.useUnistyles(), theme: materialThemeState.dark ? darkTheme : lightTheme }),
        };
    },
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

const { useGlassMaterialColorResolver } = await import('@/components/ui/glass/useGlassSurfaceColor');
const { useUnistyles } = await import('react-native-unistyles');

// Collect the real component graph before the interaction-test deadline starts.
await import('./SegmentedTabBar');

const theme = lightTheme;

const TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
    { id: 'gamma', label: 'Gamma' },
];

function FloatingSegmentScene(props: Readonly<{ children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const resolveMaterialColor = useGlassMaterialColorResolver('floating');
    return <HappierMaterialRoleProvider role="floating" translucentColor={theme.colors.surface.selected} resolveMaterialColor={resolveMaterialColor}>
        {props.children}
    </HappierMaterialRoleProvider>;
}

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false, hovered: false, focused: false }));
    }
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return style !== null && typeof style === 'object'
        ? style as Record<string, unknown>
        : {};
}

function requireTab(screen: RenderedScreen, testID: string) {
    const tab = screen.findHostByTestId(testID);
    expect(tab).toBeTruthy();
    return tab!;
}

function requireTabLabel(screen: RenderedScreen, testID: string): string {
    const tab = requireTab(screen, testID);
    const labelNode = tab.findByType('Text' as never);
    return labelNode.children.filter((child): child is string => typeof child === 'string').join('');
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
    // Walk up from the segment to the element that announces itself as the tablist. `.parent` alone
    // lands on the Pressable mock's wrapper when `findByTestId` returns the host node.
    let node = requireTab(screen, testID).parent;
    while (node && node.props?.accessibilityRole !== 'tablist') node = node.parent;
    expect(node).toBeTruthy();
    return node!;
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
    it.each([false, true])('keeps the selected thumb and its gradient solid inside floating material (dark=%s)', async (dark) => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const activeTheme = dark ? darkTheme : lightTheme;
        materialThemeState.dark = dark;
        try {
            // Before its segment is measured the chosen segment paints itself; after, the shared thumb does.
            for (const measured of [false, true]) {
                const screen = await renderScreen(<FloatingSegmentScene>
                    <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="material-seg" />
                </FloatingSegmentScene>);
                if (measured) {
                    await act(async () => {
                        requireTab(screen, 'material-seg:beta').props.onLayout({ nativeEvent: { layout: { x: 46, width: 44, y: 2, height: 24 } } });
                    });
                }
                const thumb = measured ? screen.findByTestId('material-seg:thumb')! : requireTabSurface(screen, 'material-seg:beta');
                expect(flattenStyle(thumb.props.style).backgroundColor).toBe(activeTheme.colors.segmentedControl.activeBackground);
                const gradient = thumb.findAllByType('View' as never).map(node => flattenStyle(node.props.style))
                    .find(style => typeof style.backgroundImage === 'string');
                for (const color of activeTheme.colors.segmentedControl.activeGradient?.colors ?? []) {
                    expect(gradient?.backgroundImage).toContain(color);
                }
                await screen.unmount();
            }
        } finally {
            materialThemeState.dark = false;
        }
    });

    it('renders all tab labels', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(requireTabLabel(screen, 'seg:alpha')).toBe('Alpha');
        expect(requireTabLabel(screen, 'seg:beta')).toBe('Beta');
        expect(requireTabLabel(screen, 'seg:gamma')).toBe('Gamma');
    });

  it('draws a tab shortcut as one keycap per key beside its label, and names it', async () => {
    const { SegmentedTabBar } = await import('./SegmentedTabBar');
    const screen = await renderScreen(
      <SegmentedTabBar
        tabs={[{ id: 'alpha', label: 'Screenshot', shortcut: 'Cmd+Shift+2' }, { id: 'beta', label: 'Recording' }]}
        activeTabId="alpha"
        onSelectTab={() => {}}
        testIDPrefix="seg"
      />,
    );

    // The label stays the name alone: the keys are keycaps after it, not words run into it.
    const texts = requireTab(screen, 'seg:alpha')
      .findAllByType('Text' as never)
      .map((node) => node.children.filter((child): child is string => typeof child === 'string').join(''));
    expect(texts).toEqual(['Screenshot', '⇧', '⌘', '2']);
    expect(requireTab(screen, 'seg:alpha').props.accessibilityLabel).toBe('Screenshot Cmd+Shift+2');
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
        expect(regularSurface.paddingVertical).toBe(6);
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

                        // Under a finger the frame takes the whole track padding; under a precise pointer
                        // (web here) it grows only as far as the WCAG floor needs, never past the track.
                        if (platform === 'web') {
                            expect(measured.framePaddingY).toBeLessThanOrEqual(measured.trackPadding);
                        } else {
                            expect(`${context}: ${measured.framePaddingY}`)
                                .toBe(`${context}: ${measured.trackPadding}`);
                        }
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
                    // An icon bar is as tall as a label bar, still on the WCAG floor. Under a finger the frame
                    // adds the track padding (32 regular); under a precise pointer (web) the drawn bar already clears it.
                    expect(`${context}: ${targetHeight}`).toBe(`${context}: ${platform === 'web' ? (compact ? 24 : 28) : (compact ? 24 : 32)}`);
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

    it('never draws a segment taller or wider on touch; its press frame only reclaims the track padding', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;

        for (const [platform, minimum] of [['ios', 44], ['android', 48]] as const) {
            (Platform as { OS: string }).OS = platform;
            try {
                const screen = await renderScreen(
                    <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
                );
                // The drawn segment stays the padding-driven 28; only the transparent press frame grows by
                // the track's own 2px, cancelled by an equal negative margin so the row measures the drawn bar.
                expect(minimum).toBeGreaterThan(28);
                const frame = flattenStyle(requireTab(screen, 'seg:alpha').props.style);
                expect(frame.minWidth).toBe(24);
                expect(frame.paddingVertical).toBe(2);
                expect(frame.marginVertical).toBe(-2);
                expect(flattenStyle(requireTabSurface(screen, 'seg:alpha').props.style).minHeight).toBeUndefined();
            } finally {
                (Platform as { OS: string }).OS = previousPlatform;
            }
        }

        // A precise pointer (desktop, desktop web) keeps the lab's dense control: the drawn segment is
        // its padding-driven 28px inside the 2px track (32 tall), never a 44px phone target.
        (Platform as { OS: string }).OS = 'web';
        try {
            const screen = await renderScreen(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
            );
            const surface = flattenStyle(requireTabSurface(screen, 'seg:alpha').props.style);
            expect(surface.minHeight).toBeUndefined();
            expect(flattenStyle(requireTab(screen, 'seg:alpha').props.style).minWidth).toBe(24);
            expect((surface.paddingVertical as number) * 2 + 16 + 4).toBe(32);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
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

    it('draws an icon bar and a label bar at one height: the lab\'s 28px segment in a 32px track', async () => {
        const { SegmentedTabBar, SEGMENTED_TAB_ICON_SIZE_PX } = await import('./SegmentedTabBar');
        const drawn = async (tabs: typeof TABS, prefix: string) => {
            const screen = await renderScreen(<SegmentedTabBar tabs={tabs} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix={prefix} />);
            const surface = flattenStyle(requireTabSurface(screen, `${prefix}:alpha`).props.style);
            const label = requireTab(screen, `${prefix}:alpha`).findAllByType('Text' as never)[0];
            const content = label ? flattenStyle(label.props.style).lineHeight as number : measureIconSlotHeight(screen, `${prefix}:alpha`);
            return (surface.paddingVertical as number) * 2 + content;
        };
        const labelled = await drawn(TABS, 'txt');
        const iconic = await drawn(ICON_TABS, 'ico');
        expect(labelled).toBe(28);
        expect(iconic).toBe(labelled);
        expect(SEGMENTED_TAB_ICON_SIZE_PX).toBe(16);
    });

    // Icons replace labels only when EVERY tab supplies one. A mixed bar keeps all labels,
    // including identity marks beside the named dashboard they identify.
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
        expect(requireTab(mixed, 'mix:alpha').findAllByType('Glyph' as never)).toHaveLength(1);
        expect(requireTabLabel(mixed, 'mix:beta')).toBe('Beta');
        expect(requireTab(mixed, 'mix:beta').findAllByType('Glyph' as never)).toHaveLength(0);
        expect(requireTabLabel(mixed, 'mix:gamma')).toBe('Gamma');
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
        const gradientPaint = screen.findByTestId('seg:beta')?.findAllByType('View' as never)
            .map(node => flattenStyle(node.props.style)).find(style => typeof style.backgroundImage === 'string');
        for (const color of theme.colors.segmentedControl.activeGradient?.colors ?? []) {
            expect(gradientPaint?.backgroundImage).toContain(color);
        }

        // Inactive tabs should NOT have the active background color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(requireTabSurface(screen, testID).props.style).backgroundColor).not.toBe(theme.colors.surface.base);
        }

        // The active tab's label should use the active text color.
        const activeLabelFlat = flattenStyle(screen.findByTestId('seg:beta')?.findByType('Text' as never).props.style);
        expect(activeLabelFlat.color).toBe(theme.colors.text.primary);
        // The chosen label is drawn in the semibold face itself. A numeric weight over the regular
        // Inter face (registered at normal weight) makes the browser synthesize bold (U1 review).
        const { Typography } = await import('@/constants/Typography');
        expect(activeLabelFlat.fontFamily).toBe(Typography.default('semiBold').fontFamily);
        expect(activeLabelFlat.fontWeight).toBeUndefined();
        // Segment labels are control text: the body role, like a select's value.
        const { resolveHappierTypeScale } = await import('@happier-dev/plugin-ui/presentation');
        expect(activeLabelFlat.fontSize).toBe(resolveHappierTypeScale('body', 'web').fontSize);

        // Inactive labels should use the secondary text color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.findByType('Text' as never).props.style).color).toBe(
                theme.colors.text.secondary,
            );
        }
    });

    it('slides one shared thumb between segments by default, and paints the chosen segment until it is measured (D-R3-5)', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        // First paint: the selection is visible at once (no frame without a chosen segment).
        expect(screen.findByTestId('seg:thumb')).toBeFalsy();
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).backgroundColor)
            .toBe(theme.colors.segmentedControl.activeBackground);
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
        // Measured: the thumb owns the chosen surface, the segment no longer paints its own.
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).backgroundColor)
            .not.toBe(theme.colors.segmentedControl.activeBackground);
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
        // `flexBasis: 'auto'` + grow 0 and NEVER the `flex: 0` shorthand:
        // on react-native-web `flex: 0` forces `flex-basis: 0%`, which — with the
        // tab's `overflow: 'hidden'` — collapses the segment to padding-only
        // width and clips the label to nothing (the "naked Switch" regression).
        expect(tabFlat.flex).toBeUndefined();
        expect(tabFlat.flexBasis).toBe('auto');
        expect(tabFlat.flexGrow).toBe(0);
        // A bounded slot may shrink the intrinsic widths; value-choice labels wrap
        // there rather than sending the final strategy outside the viewport.
        expect(tabFlat.flexShrink).toBe(1);
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
        expect(requireTrack(screen, 'seg:beta').props.accessibilityLabel).toBe('Thinking effort');

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
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => {
            beta.props.onFocus?.({ target: { matches: (selector: string) => selector === ':focus-visible' } });
        });
        const focusedStyle = flattenStyle(requireTabSurface(screen, 'seg:beta').props.style);
        expect(focusedStyle.outlineStyle).toBe('solid');
        expect(focusedStyle.outlineWidth).toBeGreaterThanOrEqual(2);
        expect(focusedStyle.outlineColor).toBe(theme.colors.border.focus);
        // The shared ring stands off the segment: the page shows through the gap.
        expect(focusedStyle.outlineOffset).toBe(2);
        expect(requireTab(screen, 'seg:beta').props.accessibilityState).toEqual({ selected: false, disabled: false });

        await act(async () => {
            requireTab(screen, 'seg:beta').props.onBlur?.({});
        });
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).outlineStyle).toBeUndefined();
    });

    it('shows the focus ring for keyboard focus only, never for the focus a pointer press leaves', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );
        // The browser's own verdict on the focused element (`:focus-visible`) is the boundary:
        // a click leaves focus that does not match it, Tab moves focus that does.
        const focusedElement = (focusVisible: boolean) => ({
            matches: (selector: string) => selector === ':focus-visible' && focusVisible,
        });

        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await act(async () => {
            requireTab(screen, 'seg:beta').props.onFocus?.({ target: focusedElement(false) });
        });
        expect(flattenStyle(requireTabSurface(screen, 'seg:beta').props.style).outlineStyle).toBeUndefined();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => {
            requireTab(screen, 'seg:beta').props.onBlur?.({});
            requireTab(screen, 'seg:gamma').props.onFocus?.({ target: focusedElement(true) });
        });
        expect(flattenStyle(requireTabSurface(screen, 'seg:gamma').props.style).outlineStyle).toBe('solid');
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
        const track = requireTrack(screen, 'seg:beta');
        expect(flattenStyle(track.props.style).opacity).toBe(0.5);

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).not.toHaveBeenCalled();
    });

    // A value the options do not name (a custom schedule, a retired choice) leaves no active tab; the
    // tablist must still take keyboard focus somewhere, or it drops out of the tab order entirely.
    it('keeps the first enabled segment focusable when the value matches no tab', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar
                tabs={TABS}
                activeTabId={'custom' as 'alpha'}
                onSelectTab={() => {}}
                testIDPrefix="seg"
            />,
        );

        expect(requireTab(screen, 'seg:alpha').props.tabIndex).toBe(0);
        expect(requireTab(screen, 'seg:beta').props.tabIndex).toBe(-1);
        expect(requireTab(screen, 'seg:gamma').props.tabIndex).toBe(-1);
    });

    it('disables one segment on its own: announced, not pressable, skipped by the keyboard', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const tabs: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = [
            { id: 'alpha', label: 'Alpha' },
            { id: 'beta', label: 'Beta', disabled: true },
            { id: 'gamma', label: 'Gamma' },
        ];
        const screen = await renderScreen(
            <SegmentedTabBar tabs={tabs} activeTabId="alpha" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        const beta = requireTab(screen, 'seg:beta');
        expect(beta.props.accessibilityState).toEqual({ selected: false, disabled: true });
        expect(beta.props.disabled).toBe(true);
        expect(requireTab(screen, 'seg:alpha').props.accessibilityState).toEqual({ selected: true, disabled: false });

        screen.pressByTestId('seg:beta');
        expect(onSelectTab).not.toHaveBeenCalled();

        await act(async () => {
            requireTab(screen, 'seg:alpha').props.onKeyDown({ key: 'ArrowRight', nativeEvent: { key: 'ArrowRight' }, preventDefault: vi.fn() });
        });
        expect(onSelectTab).toHaveBeenLastCalledWith('gamma');
    });

    it('stays interactive and undimmed when disabled is not set', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        const track = requireTrack(screen, 'seg:beta');
        expect(flattenStyle(track.props.style).opacity).toBeUndefined();
        expect(requireTab(screen, 'seg:beta').props.tabIndex).toBe(0);

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });
});

/** Six page tabs; Context is last, so a narrow pane puts it behind More (D44). */
const PAGE_TABS: ReadonlyArray<SegmentedTab<'overview' | 'code' | 'changes' | 'scripts' | 'services' | 'context'>> = [
    { id: 'overview', label: 'Overview', icon: React.createElement('Glyph') },
    { id: 'code', label: 'Code', icon: React.createElement('Glyph') },
    { id: 'changes', label: 'Changes', count: '3', icon: React.createElement('Glyph') },
    { id: 'scripts', label: 'Scripts', icon: React.createElement('Glyph') },
    { id: 'services', label: 'Services', icon: React.createElement('Glyph') },
    { id: 'context', label: 'Context', icon: React.createElement('Glyph') },
];

/** Feeds the measured boxes a browser would report: the row, each tab with and without its glyph, and More. */
function layOut(screen: RenderedScreen, rowWidth: number) {
    const layoutEvent = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: 30 } } });
    act(() => {
        const measurers = screen.root.findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        for (const node of measurers) {
            // The outermost layout owner is the row; every other one is a measured caption or a live tab.
            const text = node.findAll((child) => typeof child.type === 'string' && String(child.type) === 'Text');
            const label = text.flatMap((child) => child.children.filter((entry): entry is string => typeof entry === 'string')).join('');
            const hasGlyph = node.findAll((child) => String(child.type) === 'Glyph').length > 0;
            const width = node === measurers[0] ? rowWidth : label.length * 8 + (hasGlyph ? 22 : 0) + 22;
            node.props.onLayout(layoutEvent(width));
        }
    });
}

describe('SegmentedTabBar measured overflow', () => {
    it('retains the resolved menu items when only the overflow configuration carrier is rebuilt', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const tabs = PAGE_TABS.slice(0, 2);
        const items = [{ id: 'actions', label: 'Actions', count: 'Running 2 · Failed 1' }];
        const orderedIds = ['overview', 'code', 'actions'];
        const onSelectTab = vi.fn();
        const scene = () => <SegmentedTabBar presentation="plain" tabs={tabs} activeTabId="actions" onSelectTab={onSelectTab}
            overflow={{ label: 'More', items, orderedIds }} testIDPrefix="page" />;
        const screen = await renderScreen(scene());
        layOut(screen, 1200);
        const baseline = screen.root.findByType(DropdownMenu).props.items;
        await screen.update(scene());
        expect(screen.root.findByType(DropdownMenu).props.items).toBe(baseline);
    });

    it('offers explicit overflow when pinned pages fit and keeps its selected count and disabled reason accessible', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelectTab = vi.fn();
        const customize = React.createElement(React.Fragment, null, 'Customize');
        const screen = await renderScreen(
            <SegmentedTabBar presentation="plain" tabs={PAGE_TABS.slice(0, 2)} activeTabId="actions" onSelectTab={onSelectTab}
                overflow={{ label: 'More', footer: customize, items: [{ id: 'actions', label: 'Actions', count: 'Running 2 · Failed 1', disabled: true, unavailableReason: 'Permission required' }] }} testIDPrefix="page" />,
        );
        layOut(screen, 1200);
        const more = requireTab(screen, 'page:more');
        expect(more.props.accessibilityState).toMatchObject({ selected: true });
        expect(more.props.accessibilityLabel).toBe('More, Actions Running 2 · Failed 1, Permission required');
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.footer).toBe(customize);
        expect(menu.props.selectedId).toBe('actions');
        expect(menu.props.items).toMatchObject([{ id: 'actions', title: 'Actions Running 2 · Failed 1', subtitle: 'Permission required', checked: true, disabled: true }]);
        expect(onSelectTab).not.toHaveBeenCalled();
    });

    it('unites fit and explicit overflow once in catalog order while preserving descriptors and resize selection', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar presentation="plain" tabs={PAGE_TABS} activeTabId="actions" onSelectTab={onSelectTab}
                overflow={{ label: 'More', items: [{ id: 'actions', label: 'Actions' }, PAGE_TABS[5]!, PAGE_TABS[0]!], orderedIds: ['actions', 'context', 'overview', 'code', 'changes', 'scripts', 'services'] }} testIDPrefix="page" />,
        );
        layOut(screen, 260);
        const menu = () => screen.root.findByType(DropdownMenu);
        const ids = () => menu().props.items.map((item: { id: string }) => item.id);
        expect(ids()).toEqual(['actions', 'context', ...PAGE_TABS.slice(1, 5).filter(tab => screen.findHostByTestId(`page:${tab.id}`) === null).map(tab => tab.id)]);
        expect(new Set(ids()).size).toBe(ids().length);
        expect(menu().props.items.find((item: { id: string }) => item.id === 'actions')?.checked).toBe(true);
        layOut(screen, 1200);
        expect(ids()).toEqual(['actions']);
        expect(requireTab(screen, 'page:more').props.accessibilityState.selected).toBe(true);
        act(() => menu().props.onSelect('actions'));
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('actions');
    });

    it('keeps an explicit-only bar reachable and removes More for an empty catalog', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(<SegmentedTabBar tabs={[]} activeTabId="actions" onSelectTab={onSelectTab}
            overflow={{ label: 'More', items: [{ id: 'actions', label: 'Actions' }] }} testIDPrefix="page" />);
        expect(requireTab(screen, 'page:more').props.accessibilityState.selected).toBe(true);
        await screen.update(<SegmentedTabBar tabs={[]} activeTabId="actions" onSelectTab={onSelectTab}
            overflow={{ label: 'More', items: [] }} testIDPrefix="page" />);
        expect(screen.findHostByTestId('page:more')).toBeNull();
    });

    it('keeps keyboard roving on enabled visible tabs while explicit pages stay in the same accessible menu', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(<SegmentedTabBar presentation="plain" tabs={PAGE_TABS.slice(0, 2)} activeTabId="actions" onSelectTab={onSelectTab}
            overflow={{ label: 'More', items: [{ id: 'actions', label: 'Actions' }] }} testIDPrefix="page" />);
        layOut(screen, 1200);
        const overview = requireTab(screen, 'page:overview');
        expect(overview.props.tabIndex).toBe(0);
        act(() => overview.props.onKeyDown({ key: 'End', preventDefault: vi.fn() }));
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('code');
        expect(requireTab(screen, 'page:more').props.accessibilityRole).toBe('button');
        expect(screen.root.findByType(DropdownMenu).props.selectedId).toBe('actions');
    });

    it('positions the selected hidden page at More in track coordinates across route and width changes', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();
        const scene = (activeTabId: (typeof PAGE_TABS)[number]['id']) => (
            <SegmentedTabBar presentation="plain" overflow={{ label: 'More' }} tabs={PAGE_TABS}
                activeTabId={activeTabId} onSelectTab={onSelectTab} testIDPrefix="page" />
        );
        const screen = await renderScreen(scene('context'));
        const layoutEvent = (x: number, width: number) => ({ nativeEvent: { layout: { x, y: 0, width, height: 30 } } });
        const layoutMore = (x: number, width: number) => {
            const more = requireTab(screen, 'page:more');
            const track = requireTrack(screen, 'page:overview');
            // Native onLayout reports coordinates in the immediate host parent's space.
            // The real DropdownMenu keeps its anchoring host around the trigger.
            act(() => {
                let node: typeof more | null = more;
                while (node && node !== track) {
                    if (typeof node.type === 'string' && typeof node.props.onLayout === 'function') {
                        let hostParent = node.parent;
                        while (hostParent && typeof hostParent.type !== 'string') hostParent = hostParent.parent;
                        node.props.onLayout(layoutEvent(hostParent === track ? x : 0, width));
                    }
                    node = node.parent;
                }
            });
        };
        // Read the geometry passed to the native animation boundary; its spring is not
        // simulated by the host renderer, but it must receive the currently selected box.
        const selectedRect = () => screen.root.findAll((node) =>
            node.props.testID === 'page:thumb' && node.props.rect !== undefined)[0]?.props.rect;

        layOut(screen, 260);
        layoutMore(180, 70);
        expect(requireTab(screen, 'page:more').props.accessibilityState.selected).toBe(true);
        expect(requireTab(screen, 'page:overview').props.accessibilityState.selected).toBe(false);
        expect(selectedRect()).toEqual({ x: 180, width: 70 });

        await screen.update(scene('overview'));
        act(() => requireTab(screen, 'page:overview').props.onLayout(layoutEvent(0, 86)));
        expect(selectedRect()).toEqual({ x: 0, width: 86 });
        await screen.update(scene('context'));
        expect(selectedRect()).toEqual({ x: 180, width: 70 });

        layOut(screen, 1200);
        expect(screen.findHostByTestId('page:more')).toBeNull();
        act(() => requireTab(screen, 'page:context').props.onLayout(layoutEvent(620, 100)));
        expect(selectedRect()).toEqual({ x: 620, width: 100 });

        layOut(screen, 260);
        layoutMore(180, 70);
        expect(selectedRect()).toEqual({ x: 180, width: 70 });
        layOut(screen, 180);
        layoutMore(92, 70);
        expect(selectedRect()).toEqual({ x: 92, width: 70 });
        expect(onSelectTab).not.toHaveBeenCalled();
    });

    it('keeps every page tab in a wide row and offers no More', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar presentation="plain" overflow={{ label: 'More' }} tabs={PAGE_TABS} activeTabId="overview" onSelectTab={() => {}} testIDPrefix="page" />,
        );
        layOut(screen, 1200);
        for (const tab of PAGE_TABS) expect(screen.findHostByTestId(`page:${tab.id}`)).toBeTruthy();
        expect(screen.findHostByTestId('page:more')).toBeNull();
    });

    it('moves the tabs that no longer fit behind More, which carries the selected hidden tab and selects through the same owner', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar presentation="plain" overflow={{ label: 'More' }} tabs={PAGE_TABS} activeTabId="context" onSelectTab={onSelectTab} testIDPrefix="page" />,
        );
        layOut(screen, 260);
        expect(screen.findHostByTestId('page:overview')).toBeTruthy();
        expect(screen.findHostByTestId('page:context')).toBeNull();
        const more = requireTab(screen, 'page:more');
        expect(more.props.accessibilityLabel).toBe('More, Context');
        expect(more.props.accessibilityState).toMatchObject({ selected: true });
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toContain('context');
        expect(menu.props.items.find((item: { id: string }) => item.id === 'context')?.checked).toBe(true);
        act(() => { menu.props.onSelect('services'); });
        expect(onSelectTab).toHaveBeenCalledWith('services');
    });
});

describe('SegmentedTabBar value choice that no longer fits', () => {
    const STRATEGIES: ReadonlyArray<SegmentedTab<'order' | 'balance' | 'least' | 'most'>> = [
        { id: 'order', label: 'In order' },
        { id: 'balance', label: 'Balance' },
        { id: 'least', label: 'Least used' },
        { id: 'most', label: 'Most left' },
    ];

    it('retains explicit choices and the chosen value in the field select', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<SegmentedTabBar role="radiogroup" tabs={STRATEGIES.slice(0, 2)} activeTabId="most" onSelectTab={() => {}}
            overflow={{ label: 'More', items: STRATEGIES.slice(2) }} testIDPrefix="strategy" />);
        layOut(screen, 1200);
        expect(requireTab(screen, 'strategy:select').props.accessibilityLabel).toBe('Most left');
        expect(screen.root.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(STRATEGIES.map(tab => tab.id));
    });

    it('becomes one field select of every option, showing the chosen value, instead of hiding options behind More', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onSelectTab = vi.fn();
        const screen = await renderScreen(
            <SegmentedTabBar role="radiogroup" segmentSizing="content" overflow={{ label: 'More' }} tabs={STRATEGIES}
                activeTabId="balance" onSelectTab={onSelectTab} testIDPrefix="strategy" accessibilityLabel="Strategy" />,
        );
        layOut(screen, 240);
        for (const tab of STRATEGIES) expect(screen.findHostByTestId(`strategy:${tab.id}`)).toBeNull();
        expect(screen.findHostByTestId('strategy:more')).toBeNull();
        const select = requireTab(screen, 'strategy:select');
        expect(select.props.accessibilityLabel).toBe('Strategy, Balance');
        const menu = screen.root.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['order', 'balance', 'least', 'most']);
        expect(menu.props.selectedId).toBe('balance');
        act(() => { menu.props.onSelect('least'); });
        expect(onSelectTab).toHaveBeenCalledWith('least');

        layOut(screen, 1200);
        for (const tab of STRATEGIES) expect(screen.findHostByTestId(`strategy:${tab.id}`)).toBeTruthy();
        expect(screen.findHostByTestId('strategy:select')).toBeNull();
    });
});

describe('SegmentedTabBar measured overflow on the track', () => {
    it('fits the segments inside the track padding, dropping glyphs before any label is cut short', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar presentation="segmented" iconPlacement="leading" segmentSizing="content" overflow={{ label: 'More' }}
                tabs={PAGE_TABS} activeTabId="overview" onSelectTab={() => {}} testIDPrefix="page" />,
        );
        // The row is exactly as wide as the six segments with their glyphs (layOut's caption widths sum to 608),
        // so only the track's own padding is left over: with glyphs the labels would be squeezed ("Overvi…").
        layOut(screen, 608);
        for (const tab of PAGE_TABS) {
            const node = requireTab(screen, `page:${tab.id}`);
            expect(node.findAll((child) => String(child.type) === 'Glyph')).toHaveLength(0);
        }
        expect(screen.findHostByTestId('page:more')).toBeNull();
    });
});

describe('SegmentedTabBar plain labels', () => {
    it('draws only the glyphs when labels are "none", and every tab keeps its accessible name', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const tabs = PAGE_TABS.slice(0, 2);
        const screen = await renderScreen(
            <SegmentedTabBar presentation="plain" labels="none" tabs={tabs} activeTabId="overview" onSelectTab={() => {}} testIDPrefix="page" />,
        );
        for (const tab of tabs) {
            const node = requireTab(screen, `page:${tab.id}`);
            expect(node.findAll((child) => String(child.type) === 'Text')).toHaveLength(0);
            expect(node.findAll((child) => String(child.type) === 'Glyph')).toHaveLength(1);
            expect(node.props.accessibilityLabel).toBe(tab.label);
        }
    });
});
