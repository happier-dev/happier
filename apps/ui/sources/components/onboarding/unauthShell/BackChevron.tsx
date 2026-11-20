import * as React from 'react';
import { Platform } from 'react-native';
import Animated from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interactions/usePressFeedback';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export const UNAUTH_BACK_TEST_ID = 'unauth-shell-back-chevron';

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
    const feedback = usePressFeedback({ glyph: true });
    const testID = props.testID ?? UNAUTH_BACK_TEST_ID;
    return (
        <HappierPressable
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            testID={testID}
            nativeID={Platform.OS === 'web' ? undefined : testID}
            onPressIn={feedback.onPressIn}
            onPressOut={feedback.onPressOut}
            style={styles.button}
        >
            <Animated.View style={feedback.animatedStyle}>
                <Icon name="caret-left" size={24} color={theme.colors.text.primary} />
            </Animated.View>
        </HappierPressable>
    );
});

const stylesheet = StyleSheet.create(() => ({
    button: {
        padding: 8,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
