import * as React from 'react';
import { Platform, View } from 'react-native';
import { useResizableDockedPaneCore, type DockedPaneResizeCommitMeta } from '@/components/ui/panels/resizable/resizableDockedPaneCore';
import { ResizablePaneDividerHandle } from '@/components/ui/panels/resizable/ResizablePaneDividerHandle';

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
    const {
        effectiveSizePx,
        canResize,
        panHandlers,
        webHandleProps,
        accessibilityHandleProps,
    } = useResizableDockedPaneCore({
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
                <ResizablePaneDividerHandle
                    axis="x"
                    edge={resizeEdge === 'left' ? 'start' : 'end'}
                    interactionProps={Platform.OS === 'web'
                        ? ({
                            ...webHandleProps,
                        } as any)
                        : panHandlers as any}
                    accessibilityHandleProps={accessibilityHandleProps}
                    style={{
                        position: 'absolute',
                        ...(resizeEdge === 'left' ? { left: 0 } : { right: 0 }),
                        top: 0,
                        bottom: 0,
                        width: 10,
                        zIndex: 1000,
                    }}
                    showIndicator={false}
                />
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
