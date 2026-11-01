import * as React from 'react';
import { 
    ScrollView, 
    View, 
    StyleProp, 
    ViewStyle,
    Platform,
    ScrollViewProps,
    StyleSheet as RNStyleSheet,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';
import { PopoverScrollSourceProvider } from '@/components/ui/popover';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { KeyboardAwareScrollView } from '@/components/ui/keyboardAvoidance/KeyboardAwareScrollView';
import { ScreenBackdropBoundary, useScreenSafeAreaBackdrop } from '@/components/navigation/safeArea/HorizontalSafeArea';

const BASE_CONTENT_PADDING_BOTTOM = Platform.select({ ios: 34, default: 16 }) ?? 16;

export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
    onWheel?: (event: unknown) => void;
    /** Use the shared native keyboard owner for forms with focusable fields. */
    keyboardAware?: boolean;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        // Preserve intrinsic height in fit-content cards, while filling bounded screens.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 'auto',
        ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
        backgroundColor: theme.colors.background.canvas,
    },
    contentContainer: {
        paddingBottom: Platform.select({ ios: 34, default: 16 }),
        paddingTop: 0,
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
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const internalRef = React.useRef<ScrollView>(null);
    const isInsideModalBoundary = useIsInsideModalBoundary();
    // When the floating tab bar overlays this screen, extend the bottom padding so
    // the last rows clear it. 0 when no bar is present, so non-tab screens are unchanged.
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();

    const {
        children,
        style,
        containerStyle,
        insetGrouped = true,
        onWheel,
        keyboardAware = false,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';
    const rawOnWheel = onWheel;
    const installWebModalWheelFix = isWeb && isInsideModalBoundary && rawOnWheel == null;

    // Override background for non-inset grouped lists on iOS
    const backgroundColor = (isIOS && !insetGrouped) ? theme.colors.surface.base : theme.colors.background.canvas;
    // A screen-level list is the screen's backdrop: extend it under the side safe-area insets.
    const styleBackgroundColor = RNStyleSheet.flatten(style)?.backgroundColor;
    useScreenSafeAreaBackdrop(typeof styleBackgroundColor === 'string' ? styleBackgroundColor : backgroundColor);

    const { onScroll, ...restScrollViewProps } = scrollViewProps;

    const wheelScrollHandlers = useScrollViewWheelScrollTo(internalRef, {
        enabled: installWebModalWheelFix,
        onScroll,
        onWheel: rawOnWheel ?? undefined,
    });

    const setRefs = React.useCallback((node: ScrollView | null) => {
        internalRef.current = node;
        setForwardedRef(ref, node);
    }, [ref]);

    const scrollProps = {
        ref: setRefs,
        style: [
            styles.container,
            { backgroundColor },
            style,
        ],
        contentContainerStyle: [
            styles.contentContainer,
            containerStyle,
            bottomChromeHeight > 0 ? { paddingBottom: BASE_CONTENT_PADDING_BOTTOM + bottomChromeHeight } : null,
        ],
        showsVerticalScrollIndicator: scrollViewProps.showsVerticalScrollIndicator !== undefined
            ? scrollViewProps.showsVerticalScrollIndicator
            : true,
        contentInsetAdjustmentBehavior: (isIOS && !isWeb) ? 'automatic' as const : undefined,
        onScroll: installWebModalWheelFix ? wheelScrollHandlers.onScroll : onScroll,
        ...restScrollViewProps,
        ...(installWebModalWheelFix
            ? ({ onWheel: wheelScrollHandlers.onWheel } as any)
            : (rawOnWheel ? ({ onWheel: rawOnWheel } as any) : {})),
    };
    // Lists nested inside this one never own the screen backdrop.
    const boundedChildren = <ScreenBackdropBoundary>{children}</ScreenBackdropBoundary>;
    const scrollContent = keyboardAware ? (
        <KeyboardAwareScrollView {...scrollProps}>{boundedChildren}</KeyboardAwareScrollView>
    ) : (
        <ScrollView {...scrollProps}>{boundedChildren}</ScrollView>
    );

    return (
        <PopoverScrollSourceProvider scrollSourceRef={internalRef}>
            {scrollContent}
        </PopoverScrollSourceProvider>
    );
}));

ItemList.displayName = 'ItemList';

export const ItemListStatic = React.memo<Omit<ItemListProps, keyof ScrollViewProps> & {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}>((props) => {
    const { theme } = useUnistyles();
    
    const {
        children,
        style,
        containerStyle,
        insetGrouped = true
    } = props;

    const isIOS = Platform.OS === 'ios';

    // Override background for non-inset grouped lists on iOS
    const backgroundColor = (isIOS && !insetGrouped) ? theme.colors.surface.base : theme.colors.background.canvas;

    return (
        <View 
            style={[
                { backgroundColor },
                style
            ]}
        >
            <View style={containerStyle}>
                {children}
            </View>
        </View>
    );
});
