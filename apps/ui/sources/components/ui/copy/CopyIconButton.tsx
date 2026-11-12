import * as React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type CopyIconButtonProps = Readonly<{
    /** The text to copy; pass a function when building it is not free, so it only runs on press. */
    text: string | (() => string);
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** Short visible label beside the icon, for when several copy formats sit side by side. */
    label?: string;
    /** Defaults to the generic copy label. */
    accessibilityLabel?: string;
}>;

export const CopyIconButton = React.memo<CopyIconButtonProps>(({ text, style, testID, label, accessibilityLabel }) => {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const { markCopied, isCopied, clearCopiedFeedback } = useTemporaryCopyFeedback();
    const copied = isCopied();

    const onCopy = React.useCallback(async () => {
        if (await setClipboardStringSafe(typeof text === 'function' ? text() : text)) {
            markCopied();
        } else {
            clearCopiedFeedback();
        }
    }, [clearCopiedFeedback, markCopied, text]);

    return (
        <Pressable
            testID={testID}
            style={[styles.button, style, (isWeb && isHovered) ? styles.buttonHovered : null]}
            onPress={onCopy}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? t('common.copy')}
        >
            <Icon
                name={copied ? 'check' : 'copy'}
                size={14}
                color={copied ? (theme.colors.state.success.foreground ?? theme.colors.text.secondary) : theme.colors.text.secondary}
            />
            {label ? <Text style={styles.label}>{label}</Text> : null}
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
    },
    buttonHovered: {
        opacity: 0.85,
    },
    label: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 14,
        marginLeft: 4,
        color: theme.colors.text.secondary,
    },
}));
