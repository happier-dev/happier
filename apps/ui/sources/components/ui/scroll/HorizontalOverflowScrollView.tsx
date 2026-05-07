import * as React from 'react';
import {
    Platform,
    ScrollView,
    type ScrollViewProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { ScrollView as GestureHandlerScrollView } from 'react-native-gesture-handler';

type HorizontalOverflowScrollViewProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    contentContainerStyle?: StyleProp<ViewStyle>;
    showsHorizontalScrollIndicator?: boolean;
}>;

export const HorizontalOverflowScrollView = React.memo<HorizontalOverflowScrollViewProps>((props) => {
    const sharedProps: ScrollViewProps = {
        testID: props.testID,
        horizontal: true,
        nestedScrollEnabled: true,
        showsHorizontalScrollIndicator: props.showsHorizontalScrollIndicator,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        children: props.children,
    };

    if (Platform.OS === 'web') {
        return <ScrollView {...sharedProps} />;
    }

    return (
        <GestureHandlerScrollView
            {...sharedProps}
            disallowInterruption={true}
        />
    );
});
