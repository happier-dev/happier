import * as React from 'react';
import { StyleSheet } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

type AppHeaderCloseButtonProps = Readonly<{
    onPress: () => void;
    testID: string;
    accessibilityLabel?: string;
    /**
     * `'glyph'` (default): the × of app modals. `'text'`: the word "Cancel", for task routes that
     * pick one value and return (the `new/pick/*` pickers): the native title plus Cancel is the whole
     * chrome there.
     */
    appearance?: 'glyph' | 'text';
}>;

export const AppHeaderCloseButton = React.memo(function AppHeaderCloseButton(props: AppHeaderCloseButtonProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <HappierPressable
            testID={props.testID}
            onPress={props.onPress}
            style={({ pressed }) => [styles.button, pressed ? { opacity: motionTokens.press.opacity } : null]}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? t('common.cancel')}
        >
            {props.appearance === 'text' ? (
                <Text style={{ color: theme.colors.chrome.header.foreground }}>
                    {props.accessibilityLabel ?? t('common.cancel')}
                </Text>
            ) : (
                <Icon name="x" size={20} color={theme.colors.chrome.header.foreground} />
            )}
        </HappierPressable>
    );
});

const styles = StyleSheet.create({
    button: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
});
