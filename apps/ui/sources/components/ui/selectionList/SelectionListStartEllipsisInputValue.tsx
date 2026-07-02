import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import {
    WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE,
    WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE,
} from '@/components/ui/text/webStartEllipsisTextStyles';

const IS_WEB = Platform.OS === 'web';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        overflow: 'hidden',
    },
    text: {
        flex: 1,
        minWidth: 0,
        padding: 0,
        margin: 0,
        fontSize: Platform.select({ ios: 16, default: 15 }),
        lineHeight: Platform.select({ ios: 20, default: 22 }),
        color: theme.colors.input.text,
        ...(IS_WEB ? WEB_START_ELLIPSIS_CONTAINER_TEXT_STYLE : {}),
    },
}));

export type SelectionListStartEllipsisInputValueProps = Readonly<{
    value: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
}>;

export function SelectionListStartEllipsisInputValue(
    props: SelectionListStartEllipsisInputValueProps,
): React.ReactElement | null {
    const styles = stylesheet;
    if (props.value.length === 0) return null;
    return (
        <View
            style={[styles.container, props.style]}
            pointerEvents="none"
            accessibilityElementsHidden={true}
            importantForAccessibility="no"
        >
            <Text
                testID={props.testID}
                style={[styles.text, props.textStyle]}
                numberOfLines={1}
                ellipsizeMode="head"
            >
                {IS_WEB ? (
                    <Text style={WEB_START_ELLIPSIS_CONTENT_TEXT_STYLE}>{props.value}</Text>
                ) : props.value}
            </Text>
        </View>
    );
}
