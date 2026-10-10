import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

const styles = StyleSheet.create((theme) => ({
    button: {
        width: 36,
        height: 36,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
}));

export function InputBrowseButton(props: Readonly<{
    onPress: () => void | Promise<void>;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    iconName?: IconName;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            disabled={props.disabled === true}
            onPress={() => {
                void props.onPress();
            }}
            hitSlop={10}
            style={({ pressed }) => [
                styles.button,
                { backgroundColor: paintColor(theme.colors.input.background) },
                { opacity: props.disabled ? 0.45 : pressed ? motionTokens.press.opacitySubtle : 1 },
            ]}
        >
            <Icon
                name={props.iconName ?? 'folder-open'}
                size={16}
                color={theme.colors.text.secondary}
            />
        </Pressable>
    );
}
