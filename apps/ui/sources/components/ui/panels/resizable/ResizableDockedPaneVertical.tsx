import * as React from 'react';
import { t } from '@/text';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useResizableSize, type DockedPaneResizeCommitMeta, HappierResizeHandle as ResizablePaneDividerHandle } from '@happier-dev/plugin-ui/presentation';

export type ResizableDockedPaneVerticalCommitMeta = DockedPaneResizeCommitMeta;

export type ResizableDockedPaneVerticalProps = Readonly<{
    heightPx: number;
    minHeightPx: number;
    maxHeightPx: number;
    onCommitHeightPx: (heightPx: number, meta?: ResizableDockedPaneVerticalCommitMeta) => void;
    onDragHeightPx?: (heightPx: number | null, meta?: ResizableDockedPaneVerticalCommitMeta | null) => void;
    onResetRequest?: () => void;
    resizeEdge?: 'top' | 'bottom';
    children: React.ReactNode;
    testID?: string;
    resizeHandleTestID?: string;
}>;

export const ResizableDockedPaneVertical = React.memo((props: ResizableDockedPaneVerticalProps) => {
    const { theme } = useUnistyles();
    const resizeEdge = props.resizeEdge ?? 'top';
    const {
        effectiveSizePx,
        canResize,
        panHandlers,
        webHandleProps,
        accessibilityHandleProps,
    } = useResizableSize({
        axis: 'y',
        resizeEdge: resizeEdge === 'top' ? 'start' : 'end',
        sizePx: props.heightPx,
        minSizePx: props.minHeightPx,
        maxSizePx: props.maxHeightPx,
        onCommitSizePx: props.onCommitHeightPx,
        onDragSizePx: props.onDragHeightPx,
        onResetRequest: props.onResetRequest,
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
                // The handle's web target reaches past the pane edge; lifted, that outer part stays reachable.
                ...(canResize && Platform.OS === 'web' ? { zIndex: 1 } : null),
            }}
        >
            {canResize ? (
                <ResizablePaneDividerHandle
                    labels={{ label: t('ui.resizableDockedPane.resizeA11y'), hint: t('ui.resizableDockedPane.resizeHint'), value: (px) => t('ui.resizableDockedPane.resizeValue', { px }) }}
                    axis="y"
                    edge={resizeEdge === 'top' ? 'start' : 'end'}
                    testID={props.resizeHandleTestID ?? (props.testID ? `${props.testID}-resize-handle` : undefined)}
                    interactionProps={Platform.OS === 'web' ? webHandleProps : panHandlers}
                    accessibilityHandleProps={accessibilityHandleProps}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        ...(resizeEdge === 'top' ? { top: 0 } : { bottom: 0 }),
                        height: 18,
                        zIndex: 1000,
                    }}
                    indicatorColor={theme.colors.text.secondary}
                    indicatorOpacity={0.5}
                />
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
