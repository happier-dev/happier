import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { resolveHappierFocusRingVisible, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

type ModalCloseButtonProps = Readonly<{
    onPress: () => void;
    testID?: string;
    accessibilityLabel?: string;
    size?: number;
}>;

/** The glyph's breathing room inside the drawn close square (the same square an `IconButton` draws). */
const CLOSE_SQUARE_PADDING_PX = 4;

const stylesheet = StyleSheet.create({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export function ModalCloseButton(props: ModalCloseButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const accessibilityLabel = props.accessibilityLabel ?? t('common.close');
    const size = props.size ?? 20;
    // The close square is the glyph plus its breathing room under every pointer; a finger reaches the
    // touch target through the shared hit area, never by drawing a larger button.
    const square = size + CLOSE_SQUARE_PADDING_PX * 2;
    const squareStyle = React.useMemo(() => ({ width: square, height: square }), [square]);
    const hitArea = useHappierHitArea({ restingStyle: () => squareStyle });

    return (
        <Pressable
            testID={props.testID ?? 'modal-card-close'}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            focusable
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            onPress={props.onPress}
            style={(interactionState) => {
                const webState = interactionState as typeof interactionState & { focused?: boolean };
                return [
                    styles.button,
                    squareStyle,
                    focusRingStyle({ focused: resolveHappierFocusRingVisible(webState.focused), color: theme.colors.border.focus }),
                    { opacity: interactionState.pressed ? motionTokens.press.opacity : 1 },
                ];
            }}
        >
            {hitArea.frame}
            <Icon name="x" size={size} color={theme.colors.text.secondary} />
        </Pressable>
    );
}
