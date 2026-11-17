import * as React from 'react';
import { View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { DiffHunkRowViewportContext, type DiffHunkRowViewport } from '../hunks/DiffHunkRow';

/**
 * The unwrapped diff's horizontal scroller. It tells change rows the visible width and how far the code
 * has scrolled sideways, so their Discard / Keep stay at the pane's edge (as on Pierre) instead of at the
 * end of the longest line.
 */
export function DiffHorizontalScroll(props: Readonly<{ children: React.ReactNode }>) {
    const [viewport, setViewport] = React.useState<DiffHunkRowViewport | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setViewport((previous) => (previous?.width === width ? previous : { width, offsetX: previous?.offsetX ?? 0 }));
    }, []);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const offsetX = Math.max(0, Math.round(event.nativeEvent.contentOffset.x));
        setViewport((previous) => (!previous || previous.offsetX === offsetX ? previous : { ...previous, offsetX }));
    }, []);
    // In a bounded pane it shrinks to the pane (a virtualized list inside scrolls); under an
    // unbounded parent it still takes the content's height.
    return (
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0 }} onLayout={onLayout}>
            <DiffHunkRowViewportContext.Provider value={viewport}>
                <HorizontalOverflowScrollView showsHorizontalScrollIndicator={true} contentContainerStyle={{ flexGrow: 1 }}
                    onScroll={onScroll}>
                    {/* The rows are at least the viewport wide, so a short diff's band spans the card, not its longest line. */}
                    <View style={{ flexGrow: 1 }}>{props.children}</View>
                </HorizontalOverflowScrollView>
            </DiffHunkRowViewportContext.Provider>
        </View>
    );
}
