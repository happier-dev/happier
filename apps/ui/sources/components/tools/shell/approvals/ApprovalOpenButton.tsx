import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

/** The compact header control of an approval card that opens the request's own page or tool call. */
export const ApprovalOpenButton = React.memo(function ApprovalOpenButton(props: Readonly<{
    testID: string;
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    useCurrentUiContextLocalCommands([{
        key: 'approval.open', title: t('toolView.open'), invoke: props.onPress,
    }], { contextKey: props.testID });
    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={t('toolView.open')}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
            <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    button: {
        minWidth: Platform.select({ ios: 44, default: 48 }),
        minHeight: Platform.select({ ios: 44, default: 48 }),
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    buttonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
