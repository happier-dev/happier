import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { HAPPIER_PAGE_METRICS, useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';

import { useLayoutMaxWidth } from './layout';
import type { PageColumn } from './contentWidthMode';
import { PageColumnProvider } from '@/components/ui/lists/listPresentation';

export type PageFrameProps = Readonly<{
    children?: React.ReactNode;
    column?: PageColumn | 'conversation';
    /** Sections own their header/gutters/gaps; free content gets the page anatomy here. */
    content?: 'free' | 'sections' | 'column';
    underNativeChrome?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

/** One frame for pages and the existing constrained-column adapters. */
export const PageFrame = React.memo(function PageFrame(props: PageFrameProps) {
    const content = props.content ?? 'free';
    const column = props.column ?? (content === 'column' ? undefined : 'reading');
    const maxWidth = useLayoutMaxWidth(column);
    // Beside a collection's list (a settings rail) the page keeps a side of its own; alone in a pane, a phone
    // included, its sheets sit on the sheet inset.
    const side = useHappierCollectionLayout()?.detailBeside === true && content !== 'column'
        ? HAPPIER_PAGE_METRICS.detailSideInsetPx : 0;
    const frame = (
        <View
            testID={props.testID}
            style={[
                { width: '100%', alignSelf: 'center' },
                // A section header measures the whole pane before placing Back in its gutter.
                // The sections cap their inner content through the same named-column context.
                content === 'sections' ? (side > 0 ? { paddingHorizontal: side } : null) : { maxWidth: maxWidth + 2 * side },
                content === 'free' ? {
                    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx + side,
                    paddingTop: props.underNativeChrome
                        ? HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx
                        : HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx,
                    gap: HAPPIER_PAGE_METRICS.sectionGapPx,
                } : null,
                content === 'column' ? null : { paddingBottom: HAPPIER_PAGE_METRICS.pagePaddingBottomPx },
                props.style,
            ]}
        >
            {props.children}
        </View>
    );
    return column && column !== 'conversation'
        ? <PageColumnProvider value={column}>{frame}</PageColumnProvider>
        : frame;
});
