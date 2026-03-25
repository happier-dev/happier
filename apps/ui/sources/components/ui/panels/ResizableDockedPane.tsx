import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { t } from '@/text';
import { useResizableDockedPaneCore, type DockedPaneResizeCommitMeta } from './resizable/resizableDockedPaneCore';

export type ResizableDockedPaneCommitMeta = DockedPaneResizeCommitMeta;

export type ResizableDockedPaneProps = Readonly<{
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number, meta?: ResizableDockedPaneCommitMeta) => void;
    onDragWidthPx?: (widthPx: number | null, meta?: ResizableDockedPaneCommitMeta | null) => void;
    resizeEdge?: 'left' | 'right';
    children: React.ReactNode;
    testID?: string;
}>;

export const ResizableDockedPane = React.memo((props: ResizableDockedPaneProps) => {
    const resizeEdge = props.resizeEdge ?? 'left';
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
                        ...(resizeEdge === 'left' ? { left: 0 } : { right: 0 }),
                        top: 0,
                        bottom: 0,
                        width: 2,
                        cursor: 'col-resize' as any,
                        zIndex: 1000,
                        userSelect: 'none' as any,
                        ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                    }}
                >
                    <View
                        style={{
                            position: 'absolute',
                            ...(resizeEdge === 'left' ? { left: 4 } : { right: 4 }),
                            top: 0,
                            bottom: 0,
                            width: 1,
                        }}
                    />
                </Pressable>
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
