import * as React from 'react';
import { 
    ScrollView, 
    View, 
    StyleProp, 
    ViewStyle,
    Platform,
    ScrollViewProps
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PopoverBoundaryProvider } from '@/components/ui/popover/PopoverBoundary';

export interface ItemListProps extends ScrollViewProps {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    insetGrouped?: boolean;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
        backgroundColor: theme.colors.groupped.background,
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
    const boundaryRef = isRefObject(ref) ? ref : internalRef;

    const {
        children,
        style,
        containerStyle,
        insetGrouped = true,
        ...scrollViewProps
    } = props;

    const isIOS = Platform.OS === 'ios';
    const isWeb = Platform.OS === 'web';

    // Override background for non-inset grouped lists on iOS
    const backgroundColor = (isIOS && !insetGrouped) ? '#FFFFFF' : theme.colors.groupped.background;

    const setRefs = React.useCallback((node: ScrollView | null) => {
        internalRef.current = node;
        setForwardedRef(ref, node);
    }, [ref]);

    return (
        <PopoverBoundaryProvider boundaryRef={boundaryRef}>
            <ScrollView
                ref={setRefs}
                style={[
                    styles.container,
                    { backgroundColor },
                    style
                ]}
                contentContainerStyle={[
                    styles.contentContainer,
                    containerStyle
                ]}
                showsVerticalScrollIndicator={scrollViewProps.showsVerticalScrollIndicator !== undefined
                    ? scrollViewProps.showsVerticalScrollIndicator
                    : true}
                contentInsetAdjustmentBehavior={(isIOS && !isWeb) ? 'automatic' : undefined}
                {...scrollViewProps}
            >
                {children}
            </ScrollView>
        </PopoverBoundaryProvider>
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
    const backgroundColor = (isIOS && !insetGrouped) ? '#FFFFFF' : theme.colors.groupped.background;

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
