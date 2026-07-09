import * as React from 'react';
import { View } from 'react-native';

/**
 * How a hot row's array position maps to the DISPLAY (rendered) index passed to
 * `renderItemAtIndex`. The hot slice is ALWAYS canonical oldest-first, and `startIndex` is ALWAYS
 * the display index of the FIRST (oldest, array position 0) hot row. The orientation of the list
 * the slot lives in only changes the DIRECTION the display index moves across the slice:
 *
 * - `'sequential'` (web / standard, non-inverted): the displayed list is also oldest-first, so
 *   the cold rows occupy display indices `[0, startIndex)`, the oldest hot row displays at
 *   `startIndex`, and a hot row at array position `i` displays at `startIndex + i`. The footer
 *   slot renders rows top→bottom in chronological (oldest→newest) order — the correct visual
 *   order — so callers pass `startIndex = coldCount`.
 *
 * - `'invertedEdgeSlot'` (native / inverted): the displayed list is newest-first, and the
 *   visual-bottom edge slot's nested `scaleY(-1)` transforms compose to a pure translation that
 *   PRESERVES child DOM stacking order. Rendering the canonical rows top→bottom (oldest→newest)
 *   in DOM therefore places the newest row at the VISUAL bottom (just above the composer). In the
 *   full newest-first `displayItems` the hot block occupies indices `[0, hotCount)` with the
 *   NEWEST hot row at display 0, so the oldest hot row (array position 0) is at display index
 *   `hotCount - 1` and a hot row at array position `i` displays at `startIndex - i`. Callers pass
 *   `startIndex = hotCount - 1`. That display index is what the cold list would have assigned to
 *   the same row, so the host's older-neighbor lookup and tool-stack tightening resolve to the
 *   identical `displayItems` entry as the pre-carve render.
 */
export type TranscriptHotTailDisplayIndexMode = 'sequential' | 'invertedEdgeSlot';

/**
 * Shared hot-tail host (platform-agnostic JSX). Renders the trailing "hot" transcript
 * items directly — outside the virtualized recycler — followed by the real footer node,
 * so a per-token-growing live-tail row flows in real layout and can never be positioned
 * from a recycler's stale committed height (the device-proven streaming-overlap root).
 *
 * Web composes this in the FlashList footer slot (non-inverted); native composes it in
 * the inverted FlashList visual-bottom edge slot. The only platform difference is the
 * outer slot + flip transform handled by the caller — the row rendering itself is shared
 * and reuses the same `renderItemAtIndex` the cold list uses. The hot slice is ALWAYS
 * canonical oldest-first; `displayIndexMode` selects how each row's display index is
 * computed for the host neighbor lookup (see {@link TranscriptHotTailDisplayIndexMode}).
 */
function TranscriptHotTailInner<T extends { id: string }>(props: {
    hotItems: readonly T[];
    startIndex: number;
    renderItemAtIndex: (item: T, index: number) => React.ReactNode;
    footer: React.ReactNode;
    /** testID prefix; keeps web's stable `transcript-web-hot-tail` ids while letting native scope its own. */
    testIDPrefix: string;
    /**
     * Maps each hot row's array position to its rendered display index (default `'sequential'`
     * for web). Native passes `'invertedEdgeSlot'` so the canonical (oldest-first) rows render in
     * the correct visual order under the inverted edge slot while keeping the host neighbor-lookup
     * display index intact. See {@link TranscriptHotTailDisplayIndexMode}.
     */
    displayIndexMode?: TranscriptHotTailDisplayIndexMode;
    /**
     * Fired with the rendered HOT-ROWS height only (the footer is EXCLUDED). Native folds this
     * into the inverted bottom command's viewOffset, which already adds the composer inset; the
     * footer carries that same inset spacer, so measuring it here would double-count the inset
     * and float the pinned content a composer-inset above the composer (device-proven gap).
     */
    onHeightChange?: (height: number) => void;
}) {
    const { onHeightChange } = props;
    const handleLayout = React.useCallback(
        (event: { nativeEvent: { layout: { height: number } } }) => {
            if (!onHeightChange) return;
            const height = event?.nativeEvent?.layout?.height;
            onHeightChange(typeof height === 'number' && Number.isFinite(height) ? Math.max(0, height) : 0);
        },
        [onHeightChange],
    );

    if (props.hotItems.length === 0) {
        return props.footer;
    }

    // Both modes render the canonical (oldest-first) rows top→bottom in DOM. Only the DISPLAY
    // index handed to `renderItemAtIndex` differs: web counts UP from `startIndex` (oldest-first
    // displayed list), the inverted edge slot counts DOWN from `startIndex` (newest-first
    // `displayItems`), so the host neighbor-lookup resolves the same entry either way.
    const displayIndexMode = props.displayIndexMode ?? 'sequential';
    const resolveDisplayIndex = (arrayIndex: number): number =>
        displayIndexMode === 'invertedEdgeSlot'
            ? props.startIndex - arrayIndex
            : props.startIndex + arrayIndex;

    const rowNodes = props.hotItems.map((item, index) => (
        <View key={item.id} testID={`${props.testIDPrefix}-item-${item.id}`}>
            {props.renderItemAtIndex(item, resolveDisplayIndex(index))}
        </View>
    ));

    // Native folds the hot-tail height into the bottom-command inset (composerInset + hotTail).
    // Measure ONLY the hot rows: the footer (composer-inset spacer) renders as an unmeasured
    // sibling so the inset is counted exactly once.
    if (onHeightChange) {
        return (
            <View testID={props.testIDPrefix}>
                <View testID={`${props.testIDPrefix}-rows`} onLayout={handleLayout}>
                    {rowNodes}
                </View>
                {props.footer}
            </View>
        );
    }

    // Web (no height folding): keep the flat structure byte-identical to before.
    return (
        <View testID={props.testIDPrefix}>
            {rowNodes}
            {props.footer}
        </View>
    );
}

export const TranscriptHotTail = React.memo(TranscriptHotTailInner) as typeof TranscriptHotTailInner;
