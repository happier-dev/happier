/**
 * The offscreen measure host reads a mirror's natural height for the single
 * measurement owner (`SelectionList`). Its identity-free mirror is the body's
 * own `mode="measure"`, proven at the public boundary in
 * `SelectionList.measureIdentityFree.test.tsx`; what the host itself owns is
 * the cap on how tall that measurement may report.
 */

import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListMeasureHost', () => {
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

    it('is inert, so its hidden mirror of interactive content never takes a keyboard stop or a reader announcement', async () => {
        const { SelectionListMeasureHost } = await import('../SelectionListMeasureHost');
        const screen = await renderScreen(
            <SelectionListMeasureHost rootTestID="anim" onMeasureLayout={vi.fn()}>
                <View />
            </SelectionListMeasureHost>,
        );

        // `aria-hidden` alone hides the mirror from readers but leaves its inputs and buttons focusable, so Tab
        // walked through invisible copies of the real controls (a second search field, a second Refresh).
        const measure = screen.findByTestId('anim:measure') as unknown as { props: Record<string, unknown> };
        expect(measure.props.inert).toBe(true);
    });
});
