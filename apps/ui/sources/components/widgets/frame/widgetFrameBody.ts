import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';

import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';

/**
 * The body room of the frame a widget's content sits in: `null` outside a widget frame. A body that
 * is still on its first load (a plugin surface whose runtime is establishing) reads it to draw the
 * frame's own loading rows instead of a second, different loading state inside the card.
 */
export const WidgetFrameBodyRowsContext = React.createContext<number | null>(null);

/**
 * Whether this content is a widget's body inside its frame. Every framed widget has it, sized or not
 * (a widget in a side area or a stacked column carries no size presentation), so a body that drops
 * its page tools inside a card asks this, never whether a size presentation happens to exist.
 */
export function useIsWidgetFrameBody(): boolean {
    return React.useContext(WidgetFrameBodyRowsContext) !== null;
}

/** One body row: the height of a described list row, so a widget's rows line up with the page's. */
export function useWidgetBodyRowHeight(): number {
    const rowMetrics = usePageRowMetrics('list');
    return Math.max(
        rowMetrics.minHeightPx,
        2 * rowMetrics.paddingVerticalPx
            + rowMetrics.title.lineHeight
            + rowMetrics.subtitle.marginTop
            + rowMetrics.subtitle.lineHeight,
    );
}

/**
 * A card body's last laid-out height, for the placeholder the card leaves while its body is deferred
 * (scrolled away, a hidden tab), so returning never moves the page. The height is a render-synced
 * handle, not state: it is read only when the placeholder renders, and deferring is its own render, so
 * a body settling its height (first layout, a transient 0, its loaded height) re-renders neither its
 * card nor itself.
 */
export function useWidgetBodyLastHeight(): Readonly<{ onBodyLayout: (event: LayoutChangeEvent) => void; read: () => number }> {
    const height = React.useRef(0);
    return React.useMemo(() => ({
        onBodyLayout: (event: LayoutChangeEvent) => { height.current = event.nativeEvent.layout.height; },
        read: () => height.current,
    }), []);
}

/** The body rows a size's footprint declares; the one rule lives with the public widget presentation owner. */
export { widgetFootprintBodyRows } from '@happier-dev/plugin-ui';
