import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

import { resolveScrollOffsetForVisibleRect, useScrollRectIntoViewRegistry } from './useScrollRectIntoView';

const metrics = Object.freeze({
    offsetY: 0,
    viewportHeight: 600,
    contentHeight: 4000,
});

describe('resolveScrollOffsetForVisibleRect', () => {
    it('centers a target that fits inside the viewport', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 100 },
            metrics,
            alignment: 'center',
        })).toBe(750);
    });

    it('shows the start of a target taller than the viewport instead of centering past it', () => {
        // A settings section can be taller than the viewport. Centering it puts
        // the section's own start — the control the focus request named — above
        // the top edge, so the deep link scrolls past what it was asked to show.
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 200, height: 2000 },
            metrics,
            alignment: 'center',
        })).toBe(192);
    });

    it('shows the start of an oversized target already partly visible', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 300, height: 2000 },
            metrics: { ...metrics, offsetY: 250 },
            alignment: 'center',
        })).toBe(292);
    });

    it('leaves nearest alignment on its own edges, oversized targets included', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 100 },
            metrics,
            alignment: 'nearest',
        })).toBe(508);
        // The transcript navigation rail is the only nearest caller and passes
        // marker-sized rects. Pin its bottom-edge answer so the centre fix
        // cannot silently move it.
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 1000, height: 2000 },
            metrics,
            alignment: 'nearest',
        })).toBe(2408);
    });

    it('rests a nearest scroll on a whole row when the rows start at known offsets', () => {
        // Rows 66 tall, 8 apart, in a 244 viewport with a 32 margin: nearest alone would leave the row
        // above cut mid-text (offset 232); the list instead moves on to the next row start that still
        // keeps the target clear of the margin.
        const rowStarts = [8, 82, 156, 230, 304, 378, 452];
        const listMetrics = { offsetY: 0, viewportHeight: 244, contentHeight: 752 };
        expect(resolveScrollOffsetForVisibleRect({ rect: { y: 378, height: 66 }, metrics: listMetrics, padding: 32, alignment: 'nearest' })).toBe(232);
        expect(resolveScrollOffsetForVisibleRect({ rect: { y: 378, height: 66 }, metrics: listMetrics, padding: 32, alignment: 'nearest', rowStarts })).toBe(304);
        expect(resolveScrollOffsetForVisibleRect({ rect: { y: 452, height: 66 }, metrics: listMetrics, padding: 32, alignment: 'nearest', rowStarts })).toBe(378);
    });

    it('keeps the end of the list flush and a row that is already visible where it is', () => {
        const rowStarts = [8, 82, 156, 230, 304, 378, 452];
        const listMetrics = { offsetY: 0, viewportHeight: 244, contentHeight: 520 };
        expect(resolveScrollOffsetForVisibleRect({ rect: { y: 452, height: 66 }, metrics: listMetrics, padding: 32, alignment: 'nearest', rowStarts })).toBe(276);
        expect(resolveScrollOffsetForVisibleRect({ rect: { y: 82, height: 66 }, metrics: listMetrics, padding: 32, alignment: 'nearest', rowStarts })).toBeNull();
    });

    it('reports no scroll when the target is already fully visible', () => {
        expect(resolveScrollOffsetForVisibleRect({
            rect: { y: 100, height: 100 },
            metrics,
            alignment: 'center',
        })).toBeNull();
    });
});

it('reveals an empty-string row key instead of treating it as no active row', async () => {
    const hook = await renderHook(() => useScrollRectIntoViewRegistry({ activeKey: '', animated: false }));
    const offsets: number[] = [];
    // Physical scrolling and measured geometry are the ScrollView boundary.
    hook.getCurrent().scrollRef.current = {
        scrollTo: ({ y }: { y: number }) => offsets.push(y),
    } as unknown as import('react-native').ScrollView;
    await act(async () => {
        const scroll = hook.getCurrent();
        scroll.onScroll({ nativeEvent: {
            contentOffset: { y: 450 },
            layoutMeasurement: { height: 100 },
            contentSize: { height: 1000 },
        } });
        scroll.registerItemLayout('')({ nativeEvent: { layout: { y: 0, height: 40 } } });
    });
    expect(offsets).toContain(0);
    await hook.unmount();
});

it('keeps the scroller position when the same scroller is attached again, and starts a new scroller at its top', async () => {
    const hook = await renderHook(() => useScrollRectIntoViewRegistry({ activeKey: null, animated: false }));
    const scroller = { scrollTo: () => {} } as unknown as import('react-native').ScrollView;
    const scrolled = (y: number) => ({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height: 400 }, contentSize: { height: 100_000 } } });
    await act(async () => {
        hook.getCurrent().scrollRef.current = scroller;
        hook.getCurrent().onScroll(scrolled(2_500));
    });
    // A callback ref detaches and re-attaches the same scroller: it has not moved.
    await act(async () => {
        (hook.getCurrent().scrollRef as { current: unknown }).current = null;
        (hook.getCurrent().scrollRef as { current: unknown }).current = scroller;
    });
    expect(hook.getCurrent().viewport.get().offsetY).toBe(2_500);
    // A menu opened again mounts a new scroller, which starts at its top.
    await act(async () => {
        (hook.getCurrent().scrollRef as { current: unknown }).current = { scrollTo: () => {} };
    });
    expect(hook.getCurrent().viewport.get().offsetY).toBe(0);
    await hook.unmount();
});
