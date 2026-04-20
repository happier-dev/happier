import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useResizableDockedPaneCore, type DockedPaneResizeCommitMeta } from '@/components/ui/panels/resizable/resizableDockedPaneCore';
import { ResizablePaneDividerHandle } from '@/components/ui/panels/resizable/ResizablePaneDividerHandle';
import type { SplitCanvasAxis } from '../model/splitCanvasTypes';

function roundRatio(value: number): number {
    return Number(value.toFixed(4));
}

export const SplitCanvasDivider = React.memo((props: Readonly<{
    splitId: string;
    axis: SplitCanvasAxis;
    containerSizePx: number;
    ratio: number;
    minRatio: number;
    maxRatio: number;
    onCommitRatio: (ratio: number, meta?: DockedPaneResizeCommitMeta) => void;
    onDragRatio?: (ratio: number | null, meta?: DockedPaneResizeCommitMeta | null) => void;
}>) => {
    const { theme } = useUnistyles();
    const safeContainerSizePx = Math.max(props.containerSizePx, 1);
    const {
        panHandlers,
        webHandleProps,
    } = useResizableDockedPaneCore({
        axis: props.axis === 'row' ? 'x' : 'y',
        resizeEdge: 'end',
        sizePx: safeContainerSizePx * props.ratio,
        minSizePx: safeContainerSizePx * props.minRatio,
        maxSizePx: safeContainerSizePx * props.maxRatio,
        onCommitSizePx: (sizePx, meta) => {
            props.onCommitRatio(roundRatio(sizePx / safeContainerSizePx), meta);
        },
        onDragSizePx: (sizePx, meta) => {
            props.onDragRatio?.(
                typeof sizePx === 'number' ? roundRatio(sizePx / safeContainerSizePx) : null,
                meta ?? null,
            );
        },
    });

    const vertical = props.axis === 'row';

    return (
        <View
            testID={`split-canvas-divider-${props.splitId}`}
            style={{
                width: vertical ? 10 : '100%',
                height: vertical ? '100%' : 18,
                flexShrink: 0,
                position: 'relative',
            }}
        >
            <ResizablePaneDividerHandle
                axis={vertical ? 'x' : 'y'}
                testID={`split-canvas-divider-handle-${props.splitId}`}
                interactionProps={Platform.OS === 'web'
                    ? (webHandleProps as any)
                    : (panHandlers as any)}
                style={{
                    position: 'absolute',
                    ...(vertical
                        ? {
                            top: 0,
                            bottom: 0,
                            width: 10,
                            left: 0,
                        }
                        : {
                            left: 0,
                            right: 0,
                            height: 18,
                        }),
                    zIndex: 100,
                }}
                indicatorColor={vertical ? theme.colors.divider : theme.colors.textSecondary}
                indicatorOpacity={vertical ? 0.9 : 0.5}
            />
        </View>
    );
});
