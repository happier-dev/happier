import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

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
            style={(state) => {
                const { pressed } = state;
                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                const hovered = (state as WebHoverablePressableState).hovered === true;
                return {
                    opacity: pressed ? 0.68 : hovered ? 0.82 : 1,
                };
            }}
        >
            <Ionicons name={props.icon} size={18} color={theme.colors.text.secondary} />
        </Pressable>
    );
});
