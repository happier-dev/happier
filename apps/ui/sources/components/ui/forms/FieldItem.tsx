import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type FieldItemProps = Readonly<{
    label: React.ReactNode;
    /** Lets the field name itself by this label (`accessibilityLabelledBy`). */
    labelNativeID?: string;
    supportingText?: React.ReactNode;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    labelStyle?: StyleProp<TextStyle>;
    supportingTextStyle?: StyleProp<TextStyle>;
    controlContainerStyle?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        minWidth: 0,
    },
    // A field's name reads as words above its box (credentials lab `cc-f .lb`): the label role in
    // primary ink, never a tracked meta caption.
    label: {
        ...Typography.variant('label'),
        color: theme.colors.text.primary,
        marginBottom: theme.space.s6,
    },
    controlContainer: {
        minWidth: 0,
    },
    supportingText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginTop: Platform.select({ ios: 4, default: 5 }),
    },
}));

export const FieldItem = React.memo<FieldItemProps>((props) => {
    const styles = stylesheet;

    return (
        <View style={[styles.container, props.style]}>
            {typeof props.label === 'string'
                ? (
                    <Text nativeID={props.labelNativeID} style={[styles.label, props.labelStyle]}>
                        {props.label}
                    </Text>
                )
                : props.label}
            <View style={[styles.controlContainer, props.controlContainerStyle]}>
                {props.children}
            </View>
            {props.supportingText
                ? (
                    typeof props.supportingText === 'string'
                        ? (
                            <Text style={[styles.supportingText, props.supportingTextStyle]}>
                                {props.supportingText}
                            </Text>
                        )
                        : props.supportingText
                )
                : null}
        </View>
    );
});
