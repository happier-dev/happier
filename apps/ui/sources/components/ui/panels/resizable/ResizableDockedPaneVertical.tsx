import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useResizableDockedPaneCore, type DockedPaneResizeCommitMeta } from './resizableDockedPaneCore';

export type ResizableDockedPaneVerticalCommitMeta = DockedPaneResizeCommitMeta;

export type ResizableDockedPaneVerticalProps = Readonly<{
    heightPx: number;
    minHeightPx: number;
    maxHeightPx: number;
    onCommitHeightPx: (heightPx: number, meta?: ResizableDockedPaneVerticalCommitMeta) => void;
    onDragHeightPx?: (heightPx: number | null, meta?: ResizableDockedPaneVerticalCommitMeta | null) => void;
    resizeEdge?: 'top' | 'bottom';
    children: React.ReactNode;
    testID?: string;
    resizeHandleTestID?: string;
}>;

export const ResizableDockedPaneVertical = React.memo((props: ResizableDockedPaneVerticalProps) => {
    const { theme } = useUnistyles();
    const resizeEdge = props.resizeEdge ?? 'top';
    const { effectiveSizePx, canResize, panHandlers, webHandleProps } = useResizableDockedPaneCore({
        axis: 'y',
        resizeEdge: resizeEdge === 'top' ? 'start' : 'end',
        sizePx: props.heightPx,
        minSizePx: props.minHeightPx,
        maxSizePx: props.maxHeightPx,
        onCommitSizePx: props.onCommitHeightPx,
        onDragSizePx: props.onDragHeightPx,
    });

    return (
        <View
            testID={props.testID}
            style={{
                height: effectiveSizePx,
                position: 'relative',
                flexShrink: 0,
                alignSelf: 'stretch',
                width: '100%',
                minHeight: 0,
            }}
        >
            {canResize ? (
                <Pressable
                    testID={props.resizeHandleTestID ?? (props.testID ? `${props.testID}-resize-handle` : undefined)}
                    focusable={Platform.OS === 'web'}
                    accessibilityRole="adjustable"
                    accessibilityLabel={t('ui.resizableDockedPane.resizeA11y')}
                    accessibilityHint={t('ui.resizableDockedPane.resizeHint')}
                    {...(Platform.OS === 'web'
                        ? (webHandleProps as any)
                        : (panHandlers as any))}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        ...(resizeEdge === 'top' ? { top: 0 } : { bottom: 0 }),
                        height: 18,
                        cursor: 'row-resize' as any,
                        zIndex: 1000,
                        userSelect: 'none' as any,
                        ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                    }}
                >
                    <View
                        style={{
                            position: 'absolute',
                            ...(resizeEdge === 'top' ? { top: 6 } : { bottom: 6 }),
                            alignSelf: 'center',
                            width: 56,
                            height: 5,
                            borderRadius: 999,
                            backgroundColor: theme.colors.textSecondary,
                            opacity: 0.5,
                        }}
                    />
                </Pressable>
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
