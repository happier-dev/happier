import * as React from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

type ModalCloseButtonProps = Readonly<{
    onPress: () => void;
    testID?: string;
    accessibilityLabel?: string;
    size?: number;
}> & Pick<PressableProps, 'hitSlop'>;

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        })),
    },
}));

export function ModalCloseButton(props: ModalCloseButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const accessibilityLabel = props.accessibilityLabel ?? t('common.close');
    const size = props.size ?? 20;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    return (
        <Pressable
            testID={props.testID ?? 'modal-card-close'}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            focusable
            hitSlop={props.hitSlop}
            onPress={props.onPress}
            style={(interactionState) => {
                const webState = interactionState as typeof interactionState & { focused?: boolean };
                return [
                    styles.button,
                    {
                        minWidth: minimumInteractiveTargetSize,
                        minHeight: minimumInteractiveTargetSize,
                    },
                    webState.focused === true ? styles.buttonFocused : null,
                    { opacity: interactionState.pressed ? 0.7 : 1 },
                ];
            }}
        >
            <Icon name="x" size={size} color={theme.colors.text.secondary} />
        </Pressable>
    );
}
