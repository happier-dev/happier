import * as React from 'react';
import { themeSurfaceDataSet } from '@happier-dev/plugin-ui';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import { Text } from '@/components/ui/text/Text';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { resolveCodeMonoFontFamily } from '../codeTypography';
import { CopyIconButton, COPY_ICON_BUTTON_SIZE } from '@/components/ui/copy/CopyIconButton';
import { resolveHappierCodeBlockLayout } from '@happier-dev/plugin-ui/presentation';

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

/** Placement around the copy button; its hit area may take this much of the block's padding. */
const COPY_BUTTON_OVERLAY_OFFSET = 8;
const HEADER_ROW_PADDING_HORIZONTAL = 12;
/**
 * How far the code's viewport stops short of the block's right edge while the copy button is overlaid,
 * so a command scrolls or wraps beside the button instead of running under it.
 */
export const CODE_BLOCK_OVERLAY_COPY_INSET = COPY_BUTTON_OVERLAY_OFFSET
    + COPY_ICON_BUTTON_SIZE;

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
    const behavior = resolveHappierCodeBlockLayout({
        language,
        showHeaderRow,
        showCopyButton,
        hasHeaderLeft: Boolean(headerLeft),
        hasHeaderRight: Boolean(headerRight),
    });
    const shouldRenderHeaderRow = behavior.shouldRenderHeaderRow;
    const shouldOverlayCopyButton = behavior.shouldOverlayCopyButton;
    const contentPaddingStyle = shouldOverlayCopyButton
        ? [styles.codePadding]
        : (shouldRenderHeaderRow ? styles.codePaddingWithHeader : styles.codePadding);
    const besideOverlaidCopy = showCopyButton && shouldOverlayCopyButton ? styles.besideOverlaidCopy : null;

    const copyButton = showCopyButton ? (
        <CopyIconButton
            text={code}
            variant={shouldOverlayCopyButton ? 'outlined' : 'plain'}
            style={shouldOverlayCopyButton ? styles.copyButtonOverlay : null}
            // Overlaid, the button's hit area takes the padding beside it, never the code viewport; in the header it takes the row's padding.
            interactiveTargetEdgesPx={shouldOverlayCopyButton
                ? { leading: 0, trailing: COPY_BUTTON_OVERLAY_OFFSET, top: COPY_BUTTON_OVERLAY_OFFSET, bottom: COPY_BUTTON_OVERLAY_OFFSET }
                : { leading: 4, trailing: HEADER_ROW_PADDING_HORIZONTAL }}
        />
    ) : null;

    const header = shouldRenderHeaderRow ? (
        <View {...{ dataSet: themeSurfaceDataSet('code-block', 'header', 'default') }} style={[styles.headerRow, themeSurfaceStyles.surface({ surface: 'code-block', part: 'header', state: 'default' })]}>
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
            // Selection sources (Ask about a transcript code block) find the block they sit in.
            {...{ dataSet: { ...themeSurfaceDataSet('code-block', 'root', 'default'), ...(Platform.OS === 'web' ? { happierCodeBlock: 'true' } : {}) } }}
            style={[
                styles.container,
                showCopyButton && shouldOverlayCopyButton ? styles.containerWithOverlaidCopy : null,
                // Working content: solid it is its own fill; over glass content the material's inner translucent fill, never the cleared page plane.
                { backgroundColor: glassContentFill(theme.colors.surface.inset, theme.colors), borderColor: theme.colors.border.default },
                containerStyle,
                themeSurfaceStyles.surface({ surface: 'code-block', part: 'root', state: 'default' }),
            ]}
        >
            {header}
            {shouldOverlayCopyButton ? copyButton : null}
            {wrap ? (
                <View {...{ dataSet: themeSurfaceDataSet('code-block', 'body', 'default') }} style={[contentPaddingStyle, besideOverlaidCopy, themeSurfaceStyles.surface({ surface: 'code-block', part: 'body', state: 'default' })]}>
                    {children}
                </View>
            ) : (
                <HorizontalOverflowScrollView
                    dataSet={themeSurfaceDataSet('code-block', 'body', 'default')}
                    keepNativeTextSelection={!showCopyButton}
                    testID={scrollTestID}
                    showsHorizontalScrollIndicator={false}
                    style={[styles.scroll, besideOverlaidCopy, themeSurfaceStyles.surface({ surface: 'code-block', part: 'body', state: 'default' })]}
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
    containerWithOverlaidCopy: {
        // The button and the padding its hit area may reach into stay inside the block's clipping boundary.
        minHeight: COPY_BUTTON_OVERLAY_OFFSET * 2 + COPY_ICON_BUTTON_SIZE,
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
        paddingHorizontal: HEADER_ROW_PADDING_HORIZONTAL,
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
    copyButtonOverlay: {
        position: 'absolute',
        top: COPY_BUTTON_OVERLAY_OFFSET,
        right: COPY_BUTTON_OVERLAY_OFFSET,
        zIndex: 10,
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
