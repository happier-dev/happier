/**
 * `optionPresentation: 'card'` — the per-option surface.
 *
 * Four contracts, each of which a plausible wrong implementation would break:
 *
 *  1. The DEFAULT is untouched. This is the one that protects every other
 *     SelectionList consumer, so it asserts the absence of each card artifact
 *     individually rather than trusting a single flag.
 *  2. The card OWNS the fill, from theme tokens, in whichever theme is live —
 *     nothing unselected (quiet on any pane, base or glass: a filled idle card
 *     reads as a grey slab on a floating material) and
 *     `surface.selected` when selected. Run against the REAL light and dark
 *     themes rather than the flat test palette, so "reads a token" and "reads
 *     the right token" are distinguishable.
 *  3. The card is ONE shape: rounded, clipping, and the ancestor of both the
 *     row and its expanded controls — so a selected option and its inline
 *     controls cannot read as two differently-shaped surfaces.
 *  4. The trailing accessory becomes an absolute top-right overlay in its own
 *     grid cell, and the row still reserves horizontal room for it.
 */

import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// A LIVE theme holder rather than the flat setup palette: the card's fill is
// resolved per render, so swapping this between renders is what turns
// "theme-aware" into an assertion.
const themeHolder = vi.hoisted(() => ({ current: null as unknown as Theme }));
vi.mock('react-native-unistyles', async () => {
    const theme = (await import('@/theme')).lightTheme;
    themeHolder.current = theme;
    return {
        StyleSheet: {
            create: (styles: unknown) => (typeof styles === 'function'
                ? (styles as (t: Theme) => unknown)(themeHolder.current)
                : styles),
            configure: () => {},
            absoluteFillObject: {},
        },
        useUnistyles: () => ({ theme: themeHolder.current, rt: { colorScheme: 'light' } }),
        UnistylesRuntime: {
            setRootViewBackgroundColor: () => {},
            setAdaptiveThemes: () => {},
            setTheme: () => {},
            updateTheme: () => {},
        },
    };
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PlanOptionRow } = await import('../SelectionListOptionRow');
const { renderSelectionListAccessory } = await import('../renderSelectionListAccessory');

import { View } from 'react-native';

import { SelectionListA11yPatternContext } from '../SelectionListA11yPatternContext';
import { SelectionListOptionPresentationContext } from '../SelectionListOptionPresentationContext';
import {
    SELECTION_LIST_CARD_ACCESSORY_BOX_PX,
    SELECTION_LIST_CARD_ACCESSORY_GAP_PX,
    SELECTION_LIST_CARD_CONTENT_INSET_PX,
    SELECTION_LIST_CARD_INSET_PX,
} from '../_constants';
import type { SelectionListOption } from '../_types';

const EXPANDED_TEST_ID = 'expanded-controls';
const ACCESSORY_TEST_ID = 'trailing-accessory';
const WRAPPER_TEST_ID = 'models:root:option-wrapper:opt-a';
const OVERLAY_TEST_ID = 'models:root:option-card-accessory:opt-a';
const OPTION_TEST_ID = 'models:root:option:opt-a';

function readItemProps(screen: Awaited<ReturnType<typeof renderScreen>>) {
    // React Test Renderer exposes the function inside memo, not the memo wrapper.
    return screen.tree.root.find(node => typeof node.type === 'function'
        && node.props.title === 'Option A').props;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const resolved = typeof style === 'function'
        ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
        : style;
    const parts = (Array.isArray(resolved) ? resolved.flat(Infinity) : [resolved]).filter(Boolean);
    return Object.assign({}, ...(parts as Array<Record<string, unknown>>));
}

function isDescendantOf(node: ReactTestInstance, ancestor: ReactTestInstance): boolean {
    let current: ReactTestInstance | null = node.parent;
    while (current) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
}

function makeOption(overrides: Partial<SelectionListOption> = {}): SelectionListOption {
    return {
        id: 'opt-a',
        label: 'Option A',
        rightAccessory: <View testID={ACCESSORY_TEST_ID} />,
        rightAccessoryOutsidePressable: true,
        expandedContent: <View testID={EXPANDED_TEST_ID} />,
        ...overrides,
    };
}

it('leaves section and header factories without row state', async () => {
    const header = renderSelectionListAccessory(row => row
        ? <View testID="unexpected-row-visual" /> : <View testID="header-visual" />);
    const screen = await renderScreen(<View>{header}</View>);
    expect(screen.findByTestId('header-visual')).not.toBeNull();
    expect(screen.findByTestId('unexpected-row-visual')).toBeNull();
});

it('resolves a stable accessory factory from current row selection before reserving a card gutter', async () => {
    const option = makeOption({ expandedContent: undefined,
        rightAccessory: state => state?.selected ? <View testID={ACCESSORY_TEST_ID} /> : null });
    const row = (isSelected: boolean) => (
        <SelectionListA11yPatternContext.Provider value="grid">
            <SelectionListOptionPresentationContext.Provider value="card">
                <PlanOptionRow option={option} rootTestID="models" stepId="root" isSelected={isSelected}
                    isFocused={false} onSelect={() => {}} onPushStep={() => {}} />
            </SelectionListOptionPresentationContext.Provider>
        </SelectionListA11yPatternContext.Provider>
    );
    const screen = await renderScreen(row(false));
    expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
    expect(readItemProps(screen).rightElement).toBeUndefined();
    await screen.update(row(true));
    expect(screen.findByTestId(ACCESSORY_TEST_ID)).not.toBeNull();
    expect(screen.findByTestId(OVERLAY_TEST_ID)).not.toBeNull();
    expect(readItemProps(screen).rightElement).toBeDefined();
    await screen.update(row(false));
    expect(screen.findByTestId(OVERLAY_TEST_ID)).toBeNull();
    expect(readItemProps(screen).rightElement).toBeUndefined();
});

it('keeps selection-dependent accessory placement consistent with the row accessibility owner', async () => {
    const option = makeOption({ expandedContent: undefined,
        rightAccessoryOutsidePressable: state => state?.selected === true });
    const row = (isSelected: boolean) => (
        <SelectionListA11yPatternContext.Provider value="grid">
            <PlanOptionRow option={option} rootTestID="models" stepId="root" isSelected={isSelected}
                isFocused={false} onSelect={() => {}} onPushStep={() => {}} />
        </SelectionListA11yPatternContext.Provider>
    );
    const screen = await renderScreen(row(false));
    expect(readItemProps(screen).rightElementOutsidePressable).toBe(false);
    await screen.update(row(true));
    expect(readItemProps(screen).rightElementOutsidePressable).toBe(true);
    await screen.update(row(false));
    expect(readItemProps(screen).rightElementOutsidePressable).toBe(false);
});

async function renderRow(params: Readonly<{
    presentation: 'row' | 'card';
    isSelected: boolean;
    option?: SelectionListOption;
    theme?: Theme;
    measureMode?: boolean;
}>) {
    themeHolder.current = params.theme ?? lightTheme;
    return renderScreen(
        <SelectionListA11yPatternContext.Provider value="grid">
            <SelectionListOptionPresentationContext.Provider value={params.presentation}>
                <PlanOptionRow
                    option={params.option ?? makeOption()}
                    rootTestID="models"
                    stepId="root"
                    isSelected={params.isSelected}
                    isFocused={false}
                    onSelect={() => {}}
                    onPushStep={() => {}}
                    positionInSet={1}
                    setSize={3}
                    measureMode={params.measureMode}
                />
            </SelectionListOptionPresentationContext.Provider>
        </SelectionListA11yPatternContext.Provider>,
    );
}

beforeEach(() => {
    themeHolder.current = lightTheme;
});

describe('optionPresentation default — the untouched path', () => {
    it('adds no card surface, no overlay, and no accessory rewrite', async () => {
        const screen = await renderRow({ presentation: 'row', isSelected: true });

        const wrapper = screen.findByTestId(WRAPPER_TEST_ID);
        expect(wrapper).not.toBeNull();
        // No style prop at all — not an empty one. A card that leaked into the
        // default would show up here first.
        expect(wrapper!.props.style).toBeUndefined();

        // The accessory still travels through Item's right slot, still flagged
        // as an out-of-pressable secondary action.
        const itemProps = readItemProps(screen);
        expect(itemProps.rightElementOutsidePressable).toBe(true);
        const rightElement = itemProps.rightElement as React.ReactElement | undefined;
        expect((rightElement?.props as { testID?: string } | undefined)?.testID)
            .toBe(ACCESSORY_TEST_ID);

        // And no corner overlay was created at all.
        expect(screen.findAllByTestId(OVERLAY_TEST_ID)).toHaveLength(0);

        // The flush row keeps the density inset it has always had: no style prop on the Item
        // either, so `Item` resolves the user's density setting as it does for every other list.
        expect(itemProps.style).toBeUndefined();
    });
});

describe('optionPresentation card — fill ownership', () => {
    it.each([
        ['light', lightTheme],
        ['dark', darkTheme],
    ] as const)('paints nothing unselected and selected when selected (%s theme)', async (_name, theme) => {
        const idle = await renderRow({ presentation: 'card', isSelected: false, theme });
        expect(flattenStyle(idle.findByTestId(WRAPPER_TEST_ID)!.props.style).backgroundColor)
            .toBe('transparent');

        const selected = await renderRow({ presentation: 'card', isSelected: true, theme });
        expect(flattenStyle(selected.findByTestId(WRAPPER_TEST_ID)!.props.style).backgroundColor)
            .toBe(theme.colors.surface.selected);

        // The two tokens must differ, or "paints the selected surface" would be
        // satisfied by an implementation that never repaints at all; and the two
        // themes must differ, or the two runs could not tell a themed card from a
        // hardcoded one.
        expect(theme.colors.surface.base).not.toBe(theme.colors.surface.selected);
        expect(lightTheme.colors.surface.selected).not.toBe(darkTheme.colors.surface.selected);
    });

    it('leaves the selected fill to the card alone for custom-content rows', async () => {
        const option = makeOption({ content: <View testID="custom-content" /> });

        const carded = await renderRow({ presentation: 'card', isSelected: true, option });
        expect(flattenStyle(carded.findByTestId(OPTION_TEST_ID)!.props.style).backgroundColor)
            .toBeUndefined();

        // Without the card the same row still paints its own selected fill, so
        // the change is scoped to card mode rather than a deletion.
        const flush = await renderRow({ presentation: 'row', isSelected: true, option });
        expect(flattenStyle(flush.findByTestId(OPTION_TEST_ID)!.props.style).backgroundColor)
            .toBe(lightTheme.colors.surface.selected);
    });
});

describe('optionPresentation card — one shape', () => {
    it('rounds and clips the card so the row and its expanded controls share an envelope', async () => {
        const screen = await renderRow({ presentation: 'card', isSelected: true });

        const wrapper = screen.findByTestId(WRAPPER_TEST_ID);
        const style = flattenStyle(wrapper!.props.style);
        expect(style.borderRadius).toBe(lightTheme.borderRadius.xl);
        // Clipping is what makes the square selected fill beneath, and the
        // controls panel below, take the card's corners.
        expect(style.overflow).toBe('hidden');
        expect(style.position).toBe('relative');

        // The expanded controls live INSIDE the filled, clipped card.
        const expanded = screen.findByTestId(EXPANDED_TEST_ID);
        expect(expanded).not.toBeNull();
        expect(isDescendantOf(expanded!, wrapper!)).toBe(true);
    });
});

describe('optionPresentation card — content inset', () => {
    it('gives the card its own inset instead of inheriting the list row inset', async () => {
        const screen = await renderRow({ presentation: 'card', isSelected: false });
        const style = flattenStyle(readItemProps(screen).style);
        expect(style.paddingHorizontal).toBe(SELECTION_LIST_CARD_CONTENT_INSET_PX);
        expect(style.paddingVertical).toBe(SELECTION_LIST_CARD_CONTENT_INSET_PX);

        // Nothing else may ride along: an inset that also pinned the height
        // would drop the row under its density's touch-target floor.
        expect(Object.keys(style).sort()).toEqual(['paddingHorizontal', 'paddingVertical']);

        // The inset matches the corner the accessory is anchored to, so the
        // overlay and the text it clears share one right edge.
        expect(SELECTION_LIST_CARD_CONTENT_INSET_PX).toBe(SELECTION_LIST_CARD_INSET_PX);
    });

    it('lets a card description wrap to two lines (a model card: name, then one or two lines)', async () => {
        const card = await renderRow({ presentation: 'card', isSelected: false });
        expect(readItemProps(card).subtitleLines).toBe(2);

        const row = await renderRow({ presentation: 'row', isSelected: false });
        expect(readItemProps(row).subtitleLines).toBeUndefined();
    });

    it('applies the same inset to the measure mirror', async () => {
        // The mirror exists to report the live row's natural height. An inset
        // it did not share would make every card animate to the wrong height.
        const screen = await renderRow({ presentation: 'card', isSelected: true, measureMode: true });
        expect(flattenStyle(readItemProps(screen).style).paddingVertical)
            .toBe(SELECTION_LIST_CARD_CONTENT_INSET_PX);
    });
});

describe('optionPresentation card — corner accessory', () => {
    it('lifts the accessory into an absolute top-right overlay inside the option cell', async () => {
        const screen = await renderRow({ presentation: 'card', isSelected: true });

        // It is no longer Item's right element…
        const itemProps = readItemProps(screen);
        const rightElement = itemProps.rightElement as React.ReactElement | undefined;
        expect((rightElement?.props as { testID?: string } | undefined)?.testID)
            .not.toBe(ACCESSORY_TEST_ID);
        expect(itemProps.rightElementOutsidePressable).toBe(false);

        // …but Item still RESERVES its width, or a long title would run under it.
        expect(flattenStyle((rightElement?.props as { style?: unknown } | undefined)?.style).width)
            .toBe(SELECTION_LIST_CARD_ACCESSORY_BOX_PX);

        const overlay = screen.findByTestId(OVERLAY_TEST_ID);
        expect(overlay).not.toBeNull();
        // The accessory the option supplied is what the overlay hosts.
        expect(isDescendantOf(screen.findByTestId(ACCESSORY_TEST_ID)!, overlay!)).toBe(true);
        const overlayStyle = flattenStyle(overlay!.props.style);
        expect(overlayStyle.position).toBe('absolute');
        expect(overlayStyle.top).toBe(SELECTION_LIST_CARD_INSET_PX);
        expect(overlayStyle.right).toBe(SELECTION_LIST_CARD_INSET_PX);
        // Stacked and top-aligned, so the selection mark sits ABOVE the star.
        expect(overlayStyle.alignItems).toBe('flex-end');
        expect(overlayStyle.justifyContent).toBe('flex-start');
        expect(overlayStyle.gap).toBe(SELECTION_LIST_CARD_ACCESSORY_GAP_PX);
        // React Native's default axis is column; a row axis would put the star
        // beside the mark instead of under it.
        expect(overlayStyle.flexDirection).toBeUndefined();

        // The overlay carries no role of its own. It is part of the option, and
        // the option is ONE cell — the wrapper at two columns, a node inside it
        // at one. Giving the overlay a cell of its own is how the single-column
        // grid grew a column it never declared.
        expect(overlay!.props.role).toBeUndefined();
        const cell = screen.findByTestId(WRAPPER_TEST_ID)!
            .findAll((node) => typeof node.type === 'string' && node.props?.role === 'gridcell');
        expect(cell).toHaveLength(1);
        expect(isDescendantOf(overlay!, cell[0]!)).toBe(true);

        // The overlay is inside the card, so it anchors to the card's corner.
        expect(isDescendantOf(overlay!, screen.findByTestId(WRAPPER_TEST_ID)!)).toBe(true);
    });
});
