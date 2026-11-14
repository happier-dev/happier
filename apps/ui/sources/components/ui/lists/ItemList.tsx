import * as React from 'react';
import { ScrollView, View, StyleProp, ViewStyle, Platform, ScrollViewProps, StyleSheet as RNStyleSheet } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BASE_CONTENT_PADDING_BOTTOM } from '@/components/ui/lists/pageListBottomPadding';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance/KeyboardAwareScrollView';
import { ListPresentationProvider, type ListPresentation } from './listPresentation';
import type { PageColumn } from '@/components/ui/layout/contentWidthMode';
import { usePageContentBackgroundColor } from './usePageContentBackgroundColor';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { HAPPIER_PAGE_METRICS, useContainingHappierMaterialRole, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { usePageScroller, type PageScrollTarget } from './pageScroller';


export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    /**
     * `page` makes this list a configuration page: paper background, and every `ItemGroup`/`Item` below
     * it uses the page anatomy (the default). Non-page lists opt into `grouped`.
     */
    presentation?: ListPresentation;
    /** A page's column: the reading measure (default), or `wide` for a grid or dashboard page. */
    pageColumn?: PageColumn;
    /** A notice already explains a cause on this page; repeated section states may defer to it. */
    pageNoticeActive?: boolean;
    onWheel?: (event: unknown) => void;
    /** Use the shared native keyboard owner for forms with focusable fields. */
    keyboardAware?: boolean;
    /**
     * The page's last block fills what the viewport leaves below the blocks above it (a code surface that
     * scrolls itself); the page still scrolls when its blocks are taller than the viewport.
     */
    fill?: boolean;
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
    },
    contentContainer: {
        paddingBottom: Platform.select({ ios: 34, default: 16 }),
        paddingTop: 0,
    },
    // A card modal's body has no padding of its own and its sections add none (`ItemGroup`, contained),
    // so the list owns the card's gutter, grouped or page: the header's text edge, which a sheet and a
    // bare button row (which bleeds by its row inset into that gutter) both sit on.
    fill: {
        flexGrow: 1,
    },
    containedGutter: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    },
    // A page's bottom run-out is for a scrolled page; in a card the footer follows, so the list ends one inset above it.
    containedBottom: {
        paddingBottom: HAPPIER_PAGE_METRICS.sheetInsetPx,
    },
}));

function setForwardedRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
    if (typeof ref === 'function') {
        ref(value);
        return;
    }
    if (ref && typeof ref === 'object') {
        (ref as React.MutableRefObject<T | null>).current = value;
    }
}

function isRefObject<T>(ref: React.ForwardedRef<T>): ref is React.MutableRefObject<T | null> {
    return Boolean(ref && typeof ref === 'object' && 'current' in ref);
}

export const ItemList = React.memo(React.forwardRef<ScrollView, ItemListProps>((props, ref) => {
    const styles = stylesheet;
    const internalRef = React.useRef<ScrollView>(null);

    const {
        children,
        style,
        containerStyle,
        presentation = 'page',
        pageColumn = 'reading',
        pageNoticeActive = false,
        onWheel,
        keyboardAware = false,
        fill = false,
        innerViewRef,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    const { onScroll, onLayout, onContentSizeChange, scrollEventThrottle, ...restScrollViewProps } = scrollViewProps;
    const page = usePageScroller({
        presentation,
        pageNoticeActive,
        style,
        horizontal: scrollViewProps.horizontal === true,
        scrollRef: internalRef as React.RefObject<PageScrollTarget | null>,
        onScroll,
        onLayout,
        onContentSizeChange,
        onWheel,
        scrollEventThrottle,
    });
    const { onWheel: pageOnWheel, ...pageHandlers } = page.handlers;

    const setRefs = React.useCallback((node: ScrollView | null) => {
        internalRef.current = node;
        // RNW ignores innerViewRef, but exposes its actual content node through this API.
        // Keep the native forwarder below; on web the returned host node implements View's ref API.
        if (isWeb && innerViewRef) {
            setForwardedRef(innerViewRef, (node?.getInnerViewNode() ?? null) as View | null);
        }
        setForwardedRef(ref, node);
    }, [innerViewRef, isWeb, ref]);

    const scrollProps = {
        ref: setRefs,
        style: [styles.container, ...page.style],
        contentContainerStyle: [
            styles.contentContainer,
            presentation === 'page' ? { paddingBottom: 0 } : null,
            page.contained ? styles.containedGutter : null,
            fill ? styles.fill : null,
            containerStyle,
            page.bottomChromeHeight > 0 ? { paddingBottom: (presentation === 'page' ? 0 : BASE_CONTENT_PADDING_BOTTOM) + page.bottomChromeHeight } : null,
        ],
        showsVerticalScrollIndicator: scrollViewProps.showsVerticalScrollIndicator !== undefined
            ? scrollViewProps.showsVerticalScrollIndicator
            : true,
        contentInsetAdjustmentBehavior: (isIOS && !isWeb) ? 'automatic' as const : undefined,
        ...(!isWeb && innerViewRef ? { innerViewRef } : {}),
        ...restScrollViewProps,
        ...pageHandlers,
        ...(pageOnWheel ? ({ onWheel: pageOnWheel } as any) : {}),
    };
    const listContent = presentation === 'page' ? (
        <PageFrame column={pageColumn} content="sections" testID="page-frame"
            style={[fill ? styles.fill : null, page.contained ? styles.containedBottom : null]}>
            <RoundButtonSizeScope size="normal">{children}</RoundButtonSizeScope>
        </PageFrame>
    ) : children;
    const content = page.isolate(listContent);
    return page.provide(keyboardAware ? (
        <KeyboardAwareScrollView {...scrollProps}>{content}</KeyboardAwareScrollView>
    ) : (
        <ScrollView {...scrollProps}>{content}</ScrollView>
    ));
}));

ItemList.displayName = 'ItemList';

const TRANSPARENT_GROUND = { backgroundColor: 'transparent' } as const;

export interface ItemListStaticProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    /** Static lists are picker/menu content, not page scroll owners. */
    presentation?: 'grouped';
}

export const ItemListStatic = React.memo<ItemListStaticProps>((props) => {
    const { theme } = useUnistyles();
    const materialRole = useContainingHappierMaterialRole();
    const paintColor = useHappierMaterialColorResolver();
    const pageBackground = usePageContentBackgroundColor(theme.colors.surface.base);
    const {
        children,
        style,
        containerStyle,
        presentation = 'grouped',
    } = props;
    const authoredBackground = RNStyleSheet.flatten(style)?.backgroundColor;

    return (
        <ListPresentationProvider value={presentation}>
            <View style={[{ backgroundColor: pageBackground }, style, materialRole !== undefined && typeof authoredBackground === 'string' ? { backgroundColor: paintColor(authoredBackground, 'transparent') } : null]}>
                <View style={containerStyle}>
                    {children}
                </View>
            </View>
        </ListPresentationProvider>
    );
});
