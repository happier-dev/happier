/**
 * RV-8 / FRESH-1 — the offscreen measure host renders a second copy of a
 * subtree purely to read its natural height. Every identity-bearing prop in
 * that copy (`id` / `nativeID` / `testID` / `role` / `aria-*` /
 * accessibility*) would otherwise appear TWICE in the live tree: two
 * `role="listbox"` nodes, two testIDs per option row, two aria-labels. The
 * `aria-hidden` wrapper shields the mirror from assistive tech, but not from
 * selectors or id-based DOM queries, so the host strips those props from the
 * subtree it renders.
 *
 * These contracts used to be exercised through `SelectionListAnimatedHeight`,
 * which rendered a measure host of its own. It no longer does — the
 * measurement has a single owner (`SelectionList`) — so they are asserted
 * against the host itself.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListMeasureHost', () => {
    it('strips testID props from the measured subtree so the live tree keeps one of each', async () => {
        const { SelectionListMeasureHost } = await import('../SelectionListMeasureHost');
        const screen = await renderScreen(
            <View>
                <View testID="dup-target">
                    <Text testID="dup-target-child">Hello</Text>
                </View>
                <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={vi.fn()}>
                    <View testID="dup-target">
                        <Text testID="dup-target-child">Hello</Text>
                    </View>
                </SelectionListMeasureHost>
            </View>,
        );

        // The visible subtree contributes each testID exactly once; the
        // measured copy must contribute none.
        expect(screen.findAllByTestId('dup-target').length).toBe(1);
        expect(screen.findAllByTestId('dup-target-child').length).toBe(1);
    });

    it('strips nativeID, role and aria-* props from the measured subtree', async () => {
        const { SelectionListMeasureHost } = await import('../SelectionListMeasureHost');
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={vi.fn()}>
                <View
                    testID="aria-target"
                    nativeID="listbox-id"
                    accessibilityRole="list"
                    accessibilityLabel="Listbox"
                    {...({ 'aria-label': 'Listbox', id: 'listbox-id', role: 'listbox' } as Record<string, unknown>)}
                >
                    <Text>options</Text>
                </View>
            </SelectionListMeasureHost>,
        );

        // The host wrapper itself owns its OWN testID (`anim:measure`). The
        // subtree under it must contain ZERO copies of the identity props.
        const measure = screen.findByTestId('anim:measure') as unknown as {
            findAll: (predicate: (n: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }>;
        };
        const matches = measure.findAll((n) => (
            n.props?.nativeID === 'listbox-id'
                || n.props?.id === 'listbox-id'
                || n.props?.role === 'listbox'
                || n.props?.accessibilityRole === 'list'
                || n.props?.['aria-label'] === 'Listbox'
                || n.props?.accessibilityLabel === 'Listbox'
        ));
        expect(matches.length).toBe(0);
    });

    it('caps the host at measureMaxHeight so a naturally-tall subtree cannot report past the visible cap', async () => {
        const { SelectionListMeasureHost } = await import('../SelectionListMeasureHost');
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={vi.fn()} measureMaxHeight={480}>
                <View style={{ height: 2000 }} />
            </SelectionListMeasureHost>,
        );

        const measure = screen.findByTestId('anim:measure') as unknown as { props: { style?: unknown } };
        const style = measure.props.style;
        const flat = Array.isArray(style)
            ? style.reduce<Record<string, unknown>>((acc, s) => Object.assign(acc, s ?? {}), {})
            : (style as Record<string, unknown> | undefined) ?? {};
        expect((flat as { maxHeight?: unknown }).maxHeight).toBe(480);
    });
});
