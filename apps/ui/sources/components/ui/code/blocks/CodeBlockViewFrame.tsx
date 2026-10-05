import * as React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { t } from '@/text';
import { resolveCodeMonoFontFamily } from '../codeTypography';
import { Icon } from '@/components/ui/icons/Icon';
import { useHappierCodeBlockBehavior } from '@happier-dev/plugin-ui/presentation';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

export type CodeBlockViewFrameProps = Readonly<{
    code: string;
    language?: string | null;
    showHeaderRow?: boolean;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerLeft?: React.ReactNode;
    headerRight?: React.ReactNode;
    scrollTestID?: string;
    containerStyle?: StyleProp<ViewStyle>;
    children: React.ReactNode;
}>;

/** The overlaid copy button's padding, icon and border, as drawn by `styles.copyButton`/`copyButtonOverlay`. */
const COPY_BUTTON_OVERLAY_OFFSET = 8;
const COPY_BUTTON_ICON_SIZE = 14;
const COPY_BUTTON_PADDING_X = 8;
const COPY_BUTTON_BORDER = 1;
/**
 * How far the code's viewport stops short of the block's right edge while the copy button is overlaid,
 * so a command scrolls or wraps beside the button instead of running under it.
 */
export const CODE_BLOCK_OVERLAY_COPY_INSET = COPY_BUTTON_OVERLAY_OFFSET
    + COPY_BUTTON_PADDING_X * 2 + COPY_BUTTON_ICON_SIZE + COPY_BUTTON_BORDER * 2;

export const CodeBlockViewFrame = React.memo<CodeBlockViewFrameProps>(({
    code,
    language = null,
    showHeaderRow = true,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerLeft,
    headerRight,
    scrollTestID,
    containerStyle,
    children,
}) => {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const writeClipboard = React.useCallback(() => Clipboard.setStringAsync(code), [code]);
    const behavior = useHappierCodeBlockBehavior({
        language,
        showHeaderRow,
        showCopyButton,
        hasHeaderLeft: Boolean(headerLeft),
        hasHeaderRight: Boolean(headerRight),
        onCopy: writeClipboard,
    });
    const shouldRenderHeaderRow = behavior.shouldRenderHeaderRow;
    const shouldOverlayCopyButton = behavior.shouldOverlayCopyButton;
    const contentPaddingStyle = shouldOverlayCopyButton
        ? [styles.codePadding]
        : (shouldRenderHeaderRow ? styles.codePaddingWithHeader : styles.codePadding);
    const besideOverlaidCopy = showCopyButton && shouldOverlayCopyButton ? styles.besideOverlaidCopy : null;

    const copyButton = showCopyButton ? (
        <Pressable
            style={[
                styles.copyButton,
                shouldOverlayCopyButton ? styles.copyButtonOverlay : null,
                shouldOverlayCopyButton ? { backgroundColor: theme.colors.surface.elevated, borderColor: theme.colors.border.default } : null,
                (isWeb && isHovered) ? styles.copyButtonHovered : null,
            ]}
            onPress={behavior.copy}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
            accessibilityRole="button"
            accessibilityLabel={t('common.copy')}
        >
            <Icon
                name={behavior.copied ? 'check' : 'copy'}
                size={COPY_BUTTON_ICON_SIZE}
                color={behavior.copied ? (theme.colors.state.success.foreground ?? theme.colors.text.secondary) : theme.colors.text.secondary}
            />
        </Pressable>
    ) : null;

    const header = shouldRenderHeaderRow ? (
        <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
                {headerLeft ? (
                    headerLeft
                ) : behavior.language ? (
                    <Text selectable={selectable} style={[styles.headerText, { color: theme.colors.text.secondary }]}>
                        {behavior.language}
                    </Text>
                ) : (
                    <View />
                )}
            </View>
            <View style={styles.headerRight}>
                {headerRight}
                {copyButton}
            </View>
        </View>
    ) : null;

    return (
        <View
            style={[
                styles.container,
                { backgroundColor: glassSurfaceBackgroundColor(theme.colors.surface.inset, 'content', true), borderColor: theme.colors.border.default },
                containerStyle,
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View style={[contentPaddingStyle, besideOverlaidCopy]}>
                    {children}
                </View>
            ) : (
                <HorizontalOverflowScrollView
                    testID={scrollTestID}
                    showsHorizontalScrollIndicator={false}
                    style={[styles.scroll, besideOverlaidCopy]}
                    contentContainerStyle={contentPaddingStyle}
                >
                    {children}
                </HorizontalOverflowScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        alignSelf: 'stretch',
        borderRadius: theme.parts.codeBlock.radius,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    scroll: {
        width: '100%',
        alignSelf: 'stretch',
    },
    besideOverlaidCopy: {
        width: 'auto',
        marginRight: CODE_BLOCK_OVERLAY_COPY_INSET,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 4,
    },
    headerLeft: {
        flex: 1,
        minWidth: 0,
        paddingRight: 8,
    },
    headerText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 12,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    copyButton: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: COPY_BUTTON_PADDING_X,
        paddingVertical: 6,
        borderRadius: 8,
    },
    copyButtonOverlay: {
        position: 'absolute',
        top: COPY_BUTTON_OVERLAY_OFFSET,
        right: COPY_BUTTON_OVERLAY_OFFSET,
        zIndex: 10,
        borderWidth: COPY_BUTTON_BORDER,
    },
    copyButtonHovered: {
        opacity: 0.85,
    },
    codePadding: {
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    codePaddingWithHeader: {
        paddingHorizontal: 12,
        paddingTop: 4,
        paddingBottom: 12,
    },
}));
