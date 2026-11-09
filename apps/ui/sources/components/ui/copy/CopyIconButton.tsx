import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { IconButton, type IconButtonVariant } from '@/components/ui/buttons/IconButton';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { t } from '@/text';

const ICON_SIZE = 14;
const HORIZONTAL_PADDING = 8;
/** The drawn square. A finger reaches past it through the button's hit area, never by drawing it larger. */
export const COPY_ICON_BUTTON_SIZE = ICON_SIZE + HORIZONTAL_PADDING * 2;

export type CopyIconButtonProps = Readonly<{
    /** The text to copy; pass a function when building it is not free, so it only runs on press. */
    text: string | (() => string);
    /** Placement only; interaction chrome belongs to IconButton. */
    style?: StyleProp<ViewStyle>;
    variant?: IconButtonVariant;
    /**
     * The free space on each side the hit area may take: the block's padding at its ends, and nothing
     * toward the content the button sits beside.
     */
    interactiveTargetEdgesPx?: Readonly<{ leading: number; trailing: number; top?: number; bottom?: number }>;
    testID?: string;
}>;

export const CopyIconButton = React.memo<CopyIconButtonProps>(({ text, style, testID, variant = 'plain', interactiveTargetEdgesPx }) => {
    const { theme } = useUnistyles();
    const { copy, isCopied } = useHappierCopyFeedback();
    const copied = isCopied();
    const writeClipboard = useClipboardWrite();

    const onCopy = React.useCallback(() => copy(
        () => writeClipboard(typeof text === 'function' ? text() : text),
    ), [copy, text, writeClipboard]);

    return (
        <View style={style}>
            <IconButton
                testID={testID}
                size={COPY_ICON_BUTTON_SIZE}
                iconSize={ICON_SIZE}
                variant={variant}
                interactiveTargetEdgesPx={interactiveTargetEdgesPx}
                onPress={onCopy}
                accessibilityLabel={t('common.copy')}
                icon={(
                    <Icon
                        name={copied ? 'check' : 'copy'}
                        size={ICON_SIZE}
                        color={copied ? (theme.colors.state.success.foreground ?? theme.colors.text.secondary) : theme.colors.text.secondary}
                    />
                )}
            />
        </View>
    );
});
