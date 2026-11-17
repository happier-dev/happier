import * as React from 'react';
import { Platform, ScrollView, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView as GestureHandlerScrollView } from 'react-native-gesture-handler';
import { HappierTextSelectabilityScope } from '@happier-dev/plugin-ui/presentation';

type HorizontalOverflowScrollViewProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    dataSet?: Readonly<Record<string, string>>;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsHorizontalScrollIndicator?: boolean;
    /** Preserve selection when the content has no replacement copy control. */
    keepNativeTextSelection?: boolean;
    onScroll?: ScrollViewProps['onScroll'];
}>;

export const HorizontalOverflowScrollView = React.memo<HorizontalOverflowScrollViewProps>((props) => {
    const sharedProps: ScrollViewProps = {
        testID: props.testID,
        ...{ dataSet: props.dataSet },
        horizontal: true,
        nestedScrollEnabled: true,
        showsHorizontalScrollIndicator: props.showsHorizontalScrollIndicator,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        ...(props.onScroll ? { onScroll: props.onScroll, scrollEventThrottle: 16 } : {}),
        // Android selection competes with hesitant horizontal drags and opens the native magnifier.
        children: <HappierTextSelectabilityScope suppressSelection={Platform.OS === 'android' && props.keepNativeTextSelection !== true}>
            {props.children}
        </HappierTextSelectabilityScope>,
    };

    // Native nested scrolling lets Android horizontal content cooperate with the transcript list.
    if (Platform.OS === 'web' || Platform.OS === 'android') {
        return <ScrollView {...sharedProps} />;
    }

    return (
        <GestureHandlerScrollView
            {...sharedProps}
            disallowInterruption={true}
        />
    );
});
