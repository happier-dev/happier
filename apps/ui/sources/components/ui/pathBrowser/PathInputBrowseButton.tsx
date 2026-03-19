import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

import { PATH_BROWSER_TRIGGER_TEST_ID } from './pathBrowserTestIds';

const styles = StyleSheet.create((theme) => ({
    button: {
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
}));

export function PathInputBrowseButton(props: Readonly<{
    onPress: () => void | Promise<void>;
    disabled?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={props.testID ?? PATH_BROWSER_TRIGGER_TEST_ID}
            accessibilityRole="button"
            accessibilityLabel={t('newSession.pathPicker.enterPathTitle')}
            disabled={props.disabled === true}
            onPress={() => {
                void props.onPress();
            }}
            hitSlop={10}
            style={({ pressed }) => [
                styles.button,
                { opacity: props.disabled ? 0.45 : pressed ? 0.8 : 1 },
            ]}
        >
            <Ionicons name="folder-open-outline" size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
}
