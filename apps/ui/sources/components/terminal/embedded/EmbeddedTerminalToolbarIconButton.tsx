import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

export type EmbeddedTerminalToolbarIconButtonProps = Readonly<{
    icon: React.ComponentProps<typeof Ionicons>['name'];
    testID?: string;
    accessibilityLabel: string;
    onPress: () => void;
}>;

export const EmbeddedTerminalToolbarIconButton = React.memo((props: EmbeddedTerminalToolbarIconButtonProps) => {
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            hitSlop={8}
            onPress={props.onPress}
            style={({ pressed, hovered }) => ({
                opacity: pressed ? 0.68 : hovered ? 0.82 : 1,
            })}
        >
            <Ionicons name={props.icon} size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
});
