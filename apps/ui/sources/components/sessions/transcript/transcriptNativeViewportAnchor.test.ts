import { describe, expect, it } from 'vitest';

import {
    captureNativeTranscriptViewportAnchor,
    planNativeTranscriptViewportAnchorMeasuredOffsetRestore,
    planNativeTranscriptViewportAnchorRestore,
    resolveNativeTranscriptViewportAnchorRestoreObservation,
    type NativeTranscriptViewportFlashListRef,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';

type Item = Readonly<{
    kind: 'message';
    id: string;
    messageId: string;
}>;

const items: readonly Item[] = [
    { kind: 'message', id: 'item-1', messageId: 'message-1' },
    { kind: 'message', id: 'item-2', messageId: 'message-2' },
    { kind: 'message', id: 'item-3', messageId: 'message-3' },
];

function createRef(params: Readonly<{
    scrollOffset: number;
    visibleRange?: { startIndex: number; endIndex: number };
    layouts: Readonly<Record<number, { x: number; y: number; width: number; height: number }>>;
}>): NativeTranscriptViewportFlashListRef<Item> {
    return {
        scrollToIndex: () => undefined,
        scrollToOffset: () => undefined,
        computeVisibleIndices: params.visibleRange ? () => params.visibleRange! : undefined,
        getFirstVisibleIndex: () => params.visibleRange?.startIndex ?? 0,
        getLayout: (index: number) => params.layouts[index],
        getAbsoluteLastScrollOffset: () => params.scrollOffset,
    };
}

describe('transcriptNativeViewportAnchor', () => {
    it('captures the row crossing the focus line instead of the first partially visible row', () => {
        const result = captureNativeTranscriptViewportAnchor({
            ref: createRef({
                scrollOffset: 80,
                visibleRange: { startIndex: 1, endIndex: 2 },
                layouts: {
                    1: { x: 0, y: 40, width: 320, height: 80 },
                    2: { x: 0, y: 120, width: 320, height: 100 },
                },
            }),
            data: items,
            focusOffsetPx: 64,
            capturedAtMs: 123,
        });

        expect(result).toEqual({
            status: 'captured',
            index: 2,
            anchor: {
                kind: 'message',
                itemId: 'item-3',
                messageId: 'message-3',
                itemOffsetPx: 40,
                capturedAtMs: 123,
            },
        });
    });

    it('computes item offset from layout top minus absolute scroll offset', () => {
        const result = captureNativeTranscriptViewportAnchor({
            ref: createRef({
                scrollOffset: 175,
                visibleRange: { startIndex: 2, endIndex: 2 },
                layouts: {
                    2: { x: 0, y: 240, width: 320, height: 100 },
                },
            }),
            data: items,
            focusOffsetPx: 80,
            capturedAtMs: 456,
        });

        expect(result.status).toBe('captured');
        expect(result.status === 'captured' ? result.anchor.itemOffsetPx : null).toBe(65);
    });

    it('returns no_measurable_items when the native offset read throws during capture', () => {
        const result = captureNativeTranscriptViewportAnchor({
            ref: {
                scrollToIndex: () => undefined,
                scrollToOffset: () => undefined,
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 1 }),
                getLayout: (index: number) => (
                    index === 1 ? { x: 0, y: 180, width: 320, height: 90 } : undefined
                ),
                getAbsoluteLastScrollOffset: () => {
                    throw new Error('native recycler is recycling');
                },
            },
            data: items,
            focusOffsetPx: 64,
            capturedAtMs: 654,
        });

        expect(result).toEqual({ status: 'no_measurable_items' });
    });

    it.each([Number.NaN, Infinity])(
        'returns no_measurable_items when the native capture offset is %s',
        (scrollOffset) => {
            const result = captureNativeTranscriptViewportAnchor({
                ref: createRef({
                    scrollOffset,
                    visibleRange: { startIndex: 1, endIndex: 1 },
                    layouts: {
                        1: { x: 0, y: 180, width: 320, height: 90 },
                    },
                }),
                data: items,
                focusOffsetPx: 64,
                capturedAtMs: 655,
            });

            expect(result).toEqual({ status: 'no_measurable_items' });
        },
    );

    it('returns methods_unavailable when required FlashList measurement methods are absent', () => {
        const result = captureNativeTranscriptViewportAnchor({
            ref: {
                scrollToIndex: () => undefined,
                scrollToOffset: () => undefined,
            },
            data: items,
            focusOffsetPx: 64,
            capturedAtMs: 789,
        });

        expect(result).toEqual({
            status: 'methods_unavailable',
            missingMethods: ['getLayout', 'getAbsoluteLastScrollOffset', 'computeVisibleIndices|getFirstVisibleIndex'],
        });
    });

    it('bounds layout probes when only getFirstVisibleIndex is available', () => {
        const layoutCalls: number[] = [];
        const data = Array.from({ length: 100 }, (_, index): Item => ({
            kind: 'message',
            id: `item-${index}`,
            messageId: `message-${index}`,
        }));

        const result = captureNativeTranscriptViewportAnchor({
            ref: {
                scrollToIndex: () => undefined,
                scrollToOffset: () => undefined,
                getFirstVisibleIndex: () => 10,
                getLayout: (index) => {
                    layoutCalls.push(index);
                    return undefined;
                },
                getAbsoluteLastScrollOffset: () => 500,
            },
            data,
            focusOffsetPx: 64,
            capturedAtMs: 321,
        });

        expect(result.status).toBe('no_measurable_items');
        expect(layoutCalls.length).toBeLessThan(100);
        expect(Math.max(...layoutCalls)).toBeLessThanOrEqual(34);
    });

    it('plans a materialized native anchor restore with inverse scrollToIndex viewOffset', () => {
        const result = planNativeTranscriptViewportAnchorRestore({
            index: 4,
            itemOffsetPx: 36,
        });

        expect(result).toEqual({ status: 'planned', index: 4, viewOffset: -36 });
    });

    it('plans a direct native offset restore from a measured materialized anchor layout', () => {
        const result = planNativeTranscriptViewportAnchorMeasuredOffsetRestore({
            contentHeight: 2_200,
            itemLayoutY: 380,
            itemOffsetPx: 40,
            layoutHeight: 100,
        });

        expect(result).toEqual({
            status: 'planned',
            targetOffsetY: 340,
        });
    });

    it('does not plan a direct native offset restore from a stale anchor layout outside measured content', () => {
        expect(planNativeTranscriptViewportAnchorMeasuredOffsetRestore({
            contentHeight: 300,
            itemLayoutY: 380,
            itemOffsetPx: 40,
            layoutHeight: 100,
        })).toEqual({ status: 'layout_unavailable' });
    });

    it('confirms a native restore only when the anchor returns to its captured pixel offset', () => {
        const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
            ref: createRef({
                scrollOffset: 200,
                visibleRange: { startIndex: 1, endIndex: 2 },
                layouts: {
                    2: { x: 0, y: 240, width: 320, height: 100 },
                },
            }),
            index: 2,
            itemOffsetPx: 40,
            tolerancePx: 2,
        });

        expect(result).toEqual({
            status: 'aligned',
            deltaPx: 0,
            observedItemOffsetPx: 40,
        });
    });

    it('does not confirm a native restore when the anchor is visible at the wrong pixel offset', () => {
        const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
            ref: createRef({
                scrollOffset: 200,
                visibleRange: { startIndex: 1, endIndex: 2 },
                layouts: {
                    2: { x: 0, y: 270, width: 320, height: 100 },
                },
            }),
            index: 2,
            itemOffsetPx: 40,
            tolerancePx: 2,
        });

        expect(result).toEqual({
            status: 'misaligned',
            deltaPx: 30,
            observedItemOffsetPx: 70,
        });
    });

    it('waits for layout when measurement APIs exist but the anchor layout is not materialized yet', () => {
        const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
            ref: createRef({
                scrollOffset: 200,
                visibleRange: { startIndex: 1, endIndex: 2 },
                layouts: {},
            }),
            index: 2,
            itemOffsetPx: 40,
            tolerancePx: 2,
        });

        expect(result).toEqual({ status: 'waiting_for_layout' });
    });

    it('waits for layout when the native restore observation offset read throws', () => {
        const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
            ref: {
                scrollToIndex: () => undefined,
                scrollToOffset: () => undefined,
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 2 }),
                getLayout: (index: number) => (
                    index === 2 ? { x: 0, y: 240, width: 320, height: 100 } : undefined
                ),
                getAbsoluteLastScrollOffset: () => {
                    throw new Error('native recycler is recycling');
                },
            },
            index: 2,
            itemOffsetPx: 40,
            tolerancePx: 2,
        });

        expect(result).toEqual({ status: 'waiting_for_layout' });
    });

    it.each([Number.NaN, Infinity])(
        'waits for layout when the native restore observation offset is %s',
        (scrollOffset) => {
            const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
                ref: createRef({
                    scrollOffset,
                    visibleRange: { startIndex: 1, endIndex: 2 },
                    layouts: {
                        2: { x: 0, y: 240, width: 320, height: 100 },
                    },
                }),
                index: 2,
                itemOffsetPx: 40,
                tolerancePx: 2,
            });

            expect(result).toEqual({ status: 'waiting_for_layout' });
        },
    );

    it('falls back to visible-index confirmation only when pixel measurement APIs are unavailable', () => {
        const result = resolveNativeTranscriptViewportAnchorRestoreObservation({
            ref: {
                scrollToIndex: () => undefined,
                scrollToOffset: () => undefined,
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 2 }),
            },
            index: 2,
            itemOffsetPx: 40,
            tolerancePx: 2,
        });

        expect(result).toEqual({ status: 'visible_fallback' });
    });
});
