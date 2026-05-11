import * as React from 'react';
import { Platform, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type FieldItemProps = Readonly<{
    label: React.ReactNode;
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
    label: {
        fontSize: 12,
        fontWeight: '700',
        color: theme.colors.text.secondary,
        letterSpacing: 0.6,
        marginBottom: Platform.select({ ios: 4, default: 5 }),
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
                    <Text style={[styles.label, props.labelStyle]}>
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
