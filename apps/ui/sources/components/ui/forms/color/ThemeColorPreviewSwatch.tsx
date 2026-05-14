import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

export const ThemeColorPreviewSwatch = React.memo(function ThemeColorPreviewSwatch(props: Readonly<{
    color: string;
    testID?: string;
}>) {
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.color}
            style={[styles.swatch, { backgroundColor: props.color }]}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    swatch: {
        width: 28,
        height: 28,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
}));
