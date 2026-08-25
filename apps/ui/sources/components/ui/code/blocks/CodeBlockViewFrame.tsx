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
                size={14}
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
                { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default },
                containerStyle,
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View style={contentPaddingStyle}>
                    {children}
                </View>
            ) : (
                <HorizontalOverflowScrollView
                    testID={scrollTestID}
                    showsHorizontalScrollIndicator={false}
                    style={styles.scroll}
                    contentContainerStyle={contentPaddingStyle}
                >
                    {children}
                </HorizontalOverflowScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    container: {
        width: '100%',
        alignSelf: 'stretch',
        borderRadius: 10,
        borderWidth: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    scroll: {
        width: '100%',
        alignSelf: 'stretch',
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
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
    },
    copyButtonOverlay: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        borderWidth: 1,
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
