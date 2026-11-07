import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { resolveHappierFocusRingVisible, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

type ModalBackButtonProps = Readonly<{
    onPress: () => void;
    testID?: string;
    accessibilityLabel?: string;
    size?: number;
}>;

/** The glyph's breathing room inside the drawn square, the same square `ModalCloseButton` draws. */
const BACK_SQUARE_PADDING_PX = 4;

const stylesheet = StyleSheet.create({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});

/**
 * The way back in a card or sheet that pushed a view inside itself: the close control's twin, on the
 * header's leading side. The glyph follows the platform's back (as the navigation bar's does).
 */
export function ModalBackButton(props: ModalBackButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const size = props.size ?? 20;
    const square = size + BACK_SQUARE_PADDING_PX * 2;
    const squareStyle = React.useMemo(() => ({ width: square, height: square }), [square]);
    const hitArea = useHappierHitArea({ restingStyle: () => squareStyle });

    return (
        <Pressable
            testID={props.testID ?? 'modal-card-back'}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? t('common.back')}
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
            <Icon name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'} size={size} color={theme.colors.text.primary} />
        </Pressable>
    );
}
