import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type BackChevronProps = Readonly<{
    onPress: () => void;
    /** Accessibility label, e.g. translated "Back". */
    accessibilityLabel: string;
    testID?: string;
}>;

/**
 * Slim back affordance rendered at the top-left of the workflow pane when the
 * current wizard/route step supports back navigation. The shell decides
 * visibility by passing/omitting `onBack`.
 */
export const BackChevron = React.memo(function BackChevron(props: BackChevronProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            testID={props.testID ?? 'unauth-shell-back-chevron'}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
            <Ionicons name="chevron-back" size={24} color={theme.colors.text.primary} />
        </Pressable>
    );
});

const stylesheet = StyleSheet.create(() => ({
    button: {
        padding: 8,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.6,
    },
}));
