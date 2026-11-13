import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import type { PageColumn } from '@/components/ui/layout/contentWidthMode';

import { PageColumnProvider, type ListPresentation } from './listPresentation';
import { BASE_CONTENT_PADDING_BOTTOM } from './pageListBottomPadding';
import { usePageScroller, type PageScrollTarget } from './pageScroller';
import { VirtualizedList, type VirtualizedListProps, type VirtualizedListRef } from './virtualized';

export type VirtualizedItemListProps<T> = Omit<VirtualizedListProps<T>, 'webScrollHandlers'> & Readonly<{
    /** `page` (the default) is a configuration page, as `ItemList`'s. */
    presentation?: ListPresentation;
    /** A page's column: the reading measure (default), or `wide` for a grid or dashboard page. */
    pageColumn?: PageColumn;
    /** A notice already explains a cause on this page; repeated section states may defer to it. */
    pageNoticeActive?: boolean;
    /**
     * Page content that stays over the page's bottom however far it scrolls (a dock), in the page's column and
     * above the floating tab bar. The list's end makes room for its measured height.
     */
    bottomOverlay?: React.ReactNode;
    onWheel?: (event: unknown) => void;
    onTouchMove?: (event: unknown) => void;
}>;

/**
 * `ItemList` for a page too long to mount whole: the same page (ground, column, section anatomy, the pane
 * header's shade, the scroll source popovers follow, the tab bar's clearance), drawn by the canonical
 * virtualized list so only the rows near the viewport mount. The page's header goes in `ListHeaderComponent`
 * and its sections are the rows (long sheets cut into `ItemGroup virtualizedSegment` runs).
 */
function VirtualizedItemListInner<T>(props: VirtualizedItemListProps<T>, ref: React.ForwardedRef<VirtualizedListRef>): React.ReactElement {
    const {
        presentation = 'page',
        pageColumn = 'reading',
        pageNoticeActive,
        bottomOverlay,
        style,
        contentContainerStyle,
        onScroll,
        onLayout,
        onContentSizeChange,
        onWheel,
        onTouchMove,
        scrollEventThrottle,
        horizontal,
        ...listProps
    } = props;
    const listRef = React.useRef<VirtualizedListRef | null>(null);
    const [overlayHeight, setOverlayHeight] = React.useState(0);
    const [scrollRef] = React.useState(() => createVirtualizedPageScrollTarget(listRef));
    const page = usePageScroller({
        presentation,
        pageNoticeActive,
        style,
        horizontal,
        scrollRef,
        onScroll,
        onLayout: onLayout as Parameters<typeof usePageScroller>[0]['onLayout'],
        onContentSizeChange,
        onWheel,
        scrollEventThrottle,
    });
    const setRefs = React.useCallback((node: VirtualizedListRef | null) => {
        listRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
    }, [ref]);
    const { onWheel: pageOnWheel, ...handlers } = page.handlers;
    const bottom = (presentation === 'page' ? HAPPIER_PAGE_METRICS.pagePaddingBottomPx : BASE_CONTENT_PADDING_BOTTOM) + page.bottomChromeHeight + (bottomOverlay ? overlayHeight : 0);
    const list = (
        <VirtualizedList<T>
            {...listProps}
            ref={setRefs}
            horizontal={horizontal}
            style={[FILL, ...page.style]}
            contentContainerStyle={[
                page.contained && presentation === 'grouped' ? { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx } : null,
                { paddingBottom: bottom },
                contentContainerStyle,
            ]}
            onScroll={handlers.onScroll}
            onLayout={handlers.onLayout as VirtualizedListProps<T>['onLayout']}
            onContentSizeChange={handlers.onContentSizeChange}
            scrollEventThrottle={handlers.scrollEventThrottle}
            webScrollHandlers={pageOnWheel || onTouchMove ? { onWheel: pageOnWheel, onTouchMove } : undefined}
        />
    );
    // One stable tree whether or not an overlay is shown, so the list never remounts when a dock appears.
    const body = (
        <View style={styles.body}>
            {list}
            {bottomOverlay ? (
                <View pointerEvents="box-none" style={[styles.overlay, { bottom: page.bottomChromeHeight }]}
                    onLayout={(event) => setOverlayHeight(Math.round(event.nativeEvent.layout.height))}>
                    {bottomOverlay}
                </View>
            ) : null}
        </View>
    );
    return page.provide(page.isolate(presentation === 'page' ? (
        <PageColumnProvider value={pageColumn}>
            <RoundButtonSizeScope size="normal">{body}</RoundButtonSizeScope>
        </PageColumnProvider>
    ) : body));
}

export const VirtualizedItemList = React.forwardRef(VirtualizedItemListInner) as <T>(
    props: VirtualizedItemListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;

const styles = StyleSheet.create((theme) => ({
    body: { flex: 1, minHeight: 0 },
    overlay: { position: 'absolute', left: 0, right: 0, paddingBottom: theme.space.s12 },
}));

const FILL: ViewStyle = Platform.OS === 'web' ? { flex: 1, minHeight: 0 } : { flex: 1 };

/**
 * The recycler's own scroll owner as the page's scroll target: the native ScrollView (its content view for
 * near-viewport measurement), or on web the recycler's scroll element, whose content is its last child.
 */
function createVirtualizedPageScrollTarget(listRef: React.RefObject<VirtualizedListRef | null>): React.RefObject<PageScrollTarget | null> {
    const scroller = () => listRef.current?.getNativeScrollRef?.() as PageScrollTarget | null | undefined;
    const scrollableNode = () => listRef.current?.getScrollableNode?.();
    const target: PageScrollTarget = Platform.OS === 'web' ? {
        scrollTo: (options) => scroller()?.scrollTo?.(options),
        getScrollableNode: scrollableNode,
        getInnerViewNode: () => (scrollableNode() as { lastElementChild?: unknown } | null | undefined)?.lastElementChild ?? null,
    } : {
        scrollTo: (options) => scroller()?.scrollTo?.(options),
        getScrollableNode: scrollableNode,
        getInnerViewRef: () => scroller()?.getInnerViewRef?.() ?? null,
    };
    return { current: target };
}
