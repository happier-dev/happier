import * as React from 'react';
import { View } from 'react-native';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';

import { isSpanNearViewport, readNearViewportBuildWindow, useMeasuredNearViewport } from '@/components/widgets/nearViewport';

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
    const built = props.pinned || (measured
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
