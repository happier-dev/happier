import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type CodeBlockViewFrameProps = Readonly<{
    code: string;
    language?: string | null;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerRight?: React.ReactNode;
    children: React.ReactNode;
}>;

export const CodeBlockViewFrame = React.memo<CodeBlockViewFrameProps>(({
    code,
    language = null,
    selectable = true,
    wrap = false,
    showCopyButton = false,
    headerRight,
    children,
}) => {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const onCopy = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(code);
            setCopied(true);
            if (resetTimer.current) {
                clearTimeout(resetTimer.current);
            }
            resetTimer.current = setTimeout(() => {
                setCopied(false);
            }, 1200);
        } catch {
            // Silent failure: no modal/toast here by design (matches message copy UX).
        }
    }, [code]);

    React.useEffect(() => {
        return () => {
            if (resetTimer.current) {
                clearTimeout(resetTimer.current);
            }
        };
    }, []);

    const shouldRenderHeaderRow = Boolean(language) || Boolean(headerRight);
    const shouldOverlayCopyButton = showCopyButton && !shouldRenderHeaderRow;
    const contentPaddingStyle = shouldOverlayCopyButton ? [styles.codePadding, styles.codePaddingOverlay] : styles.codePadding;

    const copyButton = showCopyButton ? (
        <Pressable
            style={[
                styles.copyButton,
                shouldOverlayCopyButton ? styles.copyButtonOverlay : null,
                shouldOverlayCopyButton ? { backgroundColor: theme.colors.surfaceHighest, borderColor: theme.colors.divider } : null,
                (isWeb && isHovered) ? styles.copyButtonHovered : null,
            ]}
            onPress={onCopy}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
            accessibilityRole="button"
            accessibilityLabel={t('common.copy')}
        >
            <Ionicons
                name={copied ? 'checkmark-outline' : 'copy-outline'}
                size={12}
                color={copied ? (theme.colors.success ?? theme.colors.textSecondary) : theme.colors.textSecondary}
            />
        </Pressable>
    ) : null;

    const header = shouldRenderHeaderRow ? (
        <View style={styles.headerRow}>
            {language ? (
                <Text selectable={selectable} style={[styles.headerText, { color: theme.colors.textSecondary }]}>
                    {language}
                </Text>
            ) : (
                <View />
            )}
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
                { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider },
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View style={contentPaddingStyle}>
                    {children}
                </View>
            ) : (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    nestedScrollEnabled={true}
                    style={styles.scroll}
                    contentContainerStyle={contentPaddingStyle}
                >
                    {children}
                </ScrollView>
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
        paddingVertical: 10,
    },
    headerText: {
        ...Typography.mono(),
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
    codePaddingOverlay: {
        paddingTop: 18,
    },
}));
