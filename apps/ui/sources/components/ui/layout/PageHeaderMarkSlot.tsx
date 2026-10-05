import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** Bare entity artwork, with stable page/row space and no backing or clipping. */
export function PageHeaderMarkSlot(props: Readonly<{
    children: React.ReactNode;
    testID?: string;
    size?: 'page' | 'row';
}>) {
    return (
        <View testID={props.testID} style={[stylesheet.markSlot, props.size === 'row' ? stylesheet.markSlotRow : null]}>
            {props.children}
        </View>
    );
}

const stylesheet = StyleSheet.create({
    markSlot: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    markSlotRow: {
        width: 36,
        height: 36,
    },
});
