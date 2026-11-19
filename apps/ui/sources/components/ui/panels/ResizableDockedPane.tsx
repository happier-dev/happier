import * as React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { t } from '@/text';
import { useResizableDockedPaneCore, type DockedPaneResizeCommitMeta } from './resizable/resizableDockedPaneCore';

const WEB_RESIZE_TARGET_WIDTH = 8;

export type ResizableDockedPaneCommitMeta = DockedPaneResizeCommitMeta;

export type ResizableDockedPaneProps = Readonly<{
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number, meta?: ResizableDockedPaneCommitMeta) => void;
    onDragWidthPx?: (widthPx: number | null, meta?: ResizableDockedPaneCommitMeta | null) => void;
    resizeEdge?: 'left' | 'right';
    children: React.ReactNode;
    contentStyle?: StyleProp<ViewStyle>;
    testID?: string;
}>;

export const ResizableDockedPane = React.memo((props: ResizableDockedPaneProps) => {
    const resizeEdge = props.resizeEdge ?? 'left';
    const isWeb = Platform.OS === 'web';
    const targetWidth = isWeb ? WEB_RESIZE_TARGET_WIDTH : 2;
    const { effectiveSizePx, canResize, panHandlers, webHandleProps } = useResizableDockedPaneCore({
        axis: 'x',
        resizeEdge: resizeEdge === 'left' ? 'start' : 'end',
        sizePx: props.widthPx,
        minSizePx: props.minWidthPx,
        maxSizePx: props.maxWidthPx,
        onCommitSizePx: props.onCommitWidthPx,
        onDragSizePx: props.onDragWidthPx,
    });

    return (
        <View
            testID={props.testID}
            style={{
                width: effectiveSizePx,
                position: 'relative',
                flexShrink: 0,
                alignSelf: 'stretch',
                height: '100%',
                minHeight: 0,
            }}
        >
            {canResize ? (
                <Pressable
                    focusable={Platform.OS === 'web'}
                    accessibilityRole="adjustable"
                    accessibilityLabel={t('ui.resizableDockedPane.resizeA11y')}
                    accessibilityHint={t('ui.resizableDockedPane.resizeHint')}
                    {...(Platform.OS === 'web'
                        ? ({
                            ...webHandleProps,
                        } as any)
                        : panHandlers as any)}
                    style={{
                        position: 'absolute',
                        // Keep the web hit area on the other side of the seam from the pane’s scrollbar.
                        [resizeEdge]: isWeb ? -targetWidth : 0,
                        top: 0,
                        bottom: 0,
                        width: targetWidth,
                        cursor: 'col-resize' as any,
                        zIndex: 1000,
                        userSelect: 'none' as any,
                        ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                    }}
                >
                    <View
                        style={{
                            position: 'absolute',
                            [resizeEdge]: isWeb ? targetWidth + 4 : 4,
                            top: 0,
                            bottom: 0,
                            width: 1,
                        }}
                    />
                </Pressable>
            ) : null}
            <View style={[{ flex: 1, width: '100%', minHeight: 0 }, props.contentStyle]}>{props.children}</View>
        </View>
    );
});
