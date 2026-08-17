import * as React from 'react';
import { Pressable, type PressableProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ModalCloseButtonProps = Readonly<{
    onPress: () => void;
    testID?: string;
    accessibilityLabel?: string;
    size?: number;
}> & Pick<PressableProps, 'hitSlop'>;

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        padding: 2,
    },
}));

export function ModalCloseButton(props: ModalCloseButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const accessibilityLabel = props.accessibilityLabel ?? t('common.close');
    const size = props.size ?? 20;

    return (
        <Pressable
            testID={props.testID ?? 'modal-card-close'}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            hitSlop={props.hitSlop ?? 10}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.button,
                { opacity: pressed ? 0.7 : 1 },
            ]}
        >
            <Icon name="x" size={size} color={theme.colors.text.secondary} />
        </Pressable>
    );
}
