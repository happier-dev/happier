/**
 * RV-8 / FRESH-1 — the offscreen measure host renders a SECOND copy of the
 * step body so its natural height can be read. That mirror must never
 * contribute identity to the live tree: duplicate `id` / `nativeID` breaks
 * HTML id-uniqueness on web, duplicate `testID`s break `findByTestId`
 * selectors, and duplicate `aria-*` / accessibility props leak into the a11y
 * tree even under an `aria-hidden` parent.
 *
 * `SelectionListBody mode='measure'` is the primary boundary (identity is
 * never generated in the first place); `stripIdentityProps` inside this host
 * is the SECOND line of defence for arbitrary caller-supplied subtrees, which
 * is what these tests pin.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SelectionListMeasureHost } from '../SelectionListMeasureHost';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function noop(): void {}

describe('SelectionListMeasureHost', () => {
    it('exposes its own measure testID and layout callback', async () => {
        const onMeasureLayout = vi.fn();
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={onMeasureLayout}>
                <Text>Step A</Text>
            </SelectionListMeasureHost>,
        );

        const host = screen.findByTestId('anim:measure');
        expect(host).not.toBeNull();
        expect(typeof host!.props.onLayout).toBe('function');
    });

    it('strips testID props from the mirrored subtree', async () => {
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={noop}>
                <View testID="dup-target">
                    <Text testID="dup-target-child">Hello</Text>
                </View>
            </SelectionListMeasureHost>,
        );

        expect(screen.findAllByTestId('dup-target').length).toBe(0);
        expect(screen.findAllByTestId('dup-target-child').length).toBe(0);
    });

    it('strips nativeID, role and aria-* props from the mirrored subtree', async () => {
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={noop}>
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

        const host = screen.findByTestId('anim:measure');
        expect(host).not.toBeNull();
        const matches = host!.findAll((n) => (
            n.props?.nativeID === 'listbox-id'
            || n.props?.id === 'listbox-id'
            || n.props?.role === 'listbox'
            || n.props?.accessibilityRole === 'list'
            || n.props?.['aria-label'] === 'Listbox'
            || n.props?.accessibilityLabel === 'Listbox'
        ));
        expect(matches.length).toBe(0);
    });

    it('applies the caller-supplied measure cap so a tall subtree cannot report past it', async () => {
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={noop} measureMaxHeight={480}>
                <Text>Step A</Text>
            </SelectionListMeasureHost>,
        );

        const host = screen.findByTestId('anim:measure');
        const style = host!.props.style;
        const flat = Array.isArray(style)
            ? style.reduce<Record<string, unknown>>((acc, s) => Object.assign(acc, s ?? {}), {})
            : (style as Record<string, unknown> | undefined) ?? {};
        expect((flat as { maxHeight?: unknown }).maxHeight).toBe(480);
    });
});
