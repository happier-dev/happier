import * as React from 'react';
import { Platform, View } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';

import { isSpanNearViewport, readNearViewportBuildWindow, useMeasuredNearViewport } from '@/components/widgets/nearViewport';

/**
 * Web only: a part holding keyboard focus or a drag in progress stays built wherever the host scrolls, since
 * removing it would drop focus to the document and cancel its drag (a drag source's node retiring ends the carry).
 * Capture phase: the entity drag binding stops its `dragstart` from bubbling.
 */
function useHeldByInteraction(shellRef: React.RefObject<View | null>): boolean {
    const [focused, setFocused] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    React.useEffect(() => {
        const node: unknown = shellRef.current;
        if (Platform.OS !== 'web' || typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) return;
        const focusIn = () => setFocused(true);
        // Leaving the window keeps the element active, and the browser returns focus to it on the way back.
        const focusOut = (event: FocusEvent) => {
            const next = event.relatedTarget instanceof Node ? event.relatedTarget : document.activeElement;
            if (!next || !node.contains(next)) setFocused(false);
        };
        const dragStart = () => setDragging(true);
        const dragEnd = () => setDragging(false);
        node.addEventListener('focusin', focusIn);
        node.addEventListener('focusout', focusOut);
        node.addEventListener('dragstart', dragStart, true);
        node.addEventListener('dragend', dragEnd, true);
        return () => {
            node.removeEventListener('focusin', focusIn);
            node.removeEventListener('focusout', focusOut);
            node.removeEventListener('dragstart', dragStart, true);
            node.removeEventListener('dragend', dragEnd, true);
        };
    }, [shellRef]);
    return focused || dragging;
}

/**
 * One part of a scrolling host (a page group, a roster row), built only while it is near the host's
 * viewport (the app's one near-viewport rule). Outside the window its last measured height holds its
 * place, so the host keeps its length and scroll position. A pinned part (an expanded row, a requested
 * anchor) always stays built so its reveal and focus have something to land on.
 *
 * Before its first measurement a part is placed by a lower bound (its rows at the minimum row height,
 * after the earlier parts' bounds) under the same rule, so opening the host builds only the parts that
 * can be near the viewport instead of building all of them and unbuilding the far ones once measured.
 */
export const NearViewportWindow = React.memo(function NearViewportWindow(props: Readonly<{
    id: string;
    testID: string;
    pinned: boolean;
    /** Lower bound of the part's start in the host content, before it is measured. */
    estimatedTop: number;
    /** Lower bound of the part's height, held while it is not built and not yet measured. */
    estimatedHeight: number;
    /** The host's tracker follows only its visible window: build ahead of it by the prebuild rule. */
    overscan?: boolean;
    children: React.ReactNode;
}>) {
    const tracker = useOptionalPluginUiScrollActivityTracker();
    const shellRef = React.useRef<View | null>(null);
    const overscan = props.overscan === true;
    const { near, measured } = useMeasuredNearViewport(tracker, shellRef, true, props.id, overscan);
    const [height, setHeight] = React.useState<number | null>(null);
    const held = useHeldByInteraction(shellRef);
    const built = props.pinned || held || (measured
        ? near
        : isSpanNearViewport(readNearViewportBuildWindow(tracker, overscan), { top: props.estimatedTop }));
    return (
        <View
            ref={shellRef}
            testID={props.testID}
            onLayout={built ? (event) => {
                const next = event.nativeEvent.layout.height;
                if (next > 0) setHeight(current => (current === next ? current : next));
            } : undefined}
            style={built ? undefined : { height: height ?? props.estimatedHeight }}
        >
            {built ? props.children : null}
        </View>
    );
});
