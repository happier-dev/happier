import * as React from 'react';
import { t } from '@/text';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useResizableSize, type DockedPaneResizeCommitMeta, HappierResizeHandle as ResizablePaneDividerHandle } from '@happier-dev/plugin-ui/presentation';

export type ResizableDockedPaneCommitMeta = DockedPaneResizeCommitMeta;

export type ResizableDockedPaneProps = Readonly<{
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number, meta?: ResizableDockedPaneCommitMeta) => void;
    onDragWidthPx?: (widthPx: number | null, meta?: ResizableDockedPaneCommitMeta | null) => void;
    collapse?: true;
    onCollapseArmedChange?: (armed: boolean) => void;
    onCollapse?: () => void;
    onResetRequest?: () => void;
    resizeEdge?: 'left' | 'right';
    /**
     * The width the host draws while a drag gives past a bound (its rubber band), when that differs
     * from the size the core keeps. The content and the handle follow the drawn edge.
     */
    drawnWidthPx?: number;
    /**
     * The pane fills the column its host lays out instead of drawing `widthPx`. For a column whose width
     * is whatever its neighbours leave: a number measured after paint lags a window resize, and drawn as
     * the pane's width it would hold the previous window's layout (the Session column at 1060 px in a
     * 390 px window).
     */
    fill?: boolean;
    children: React.ReactNode;
    testID?: string;
}>;

export const ResizableDockedPane = React.memo((props: ResizableDockedPaneProps) => {
    const { theme } = useUnistyles();
    const resizeEdge = props.resizeEdge ?? 'left';
    const {
        effectiveSizePx,
        dragging,
        canResize,
        panHandlers,
        webHandleProps,
        accessibilityHandleProps,
    } = useResizableSize({
        axis: 'x',
        resizeEdge: resizeEdge === 'left' ? 'start' : 'end',
        sizePx: props.widthPx,
        minSizePx: props.minWidthPx,
        maxSizePx: props.maxWidthPx,
        onCommitSizePx: props.onCommitWidthPx,
        onDragSizePx: props.onDragWidthPx,
        collapse: props.collapse,
        onCollapseArmedChange: props.onCollapseArmedChange,
        onCollapse: props.onCollapse,
        onResetRequest: props.onResetRequest,
    });

    // The handle sits on the edge it resizes in document order too, because order is focus order: a
    // modal focuses its first focusable element on open, and a leading pane's handle must not come
    // before that pane's own content (the settings rail's search field).
    const handle = canResize ? (
        <ResizablePaneDividerHandle
            labels={{ label: t('ui.resizableDockedPane.resizeA11y'), hint: t('ui.resizableDockedPane.resizeHint'), value: (px) => t('ui.resizableDockedPane.resizeValue', { px }) }}
            axis="x"
            edge={resizeEdge === 'left' ? 'start' : 'end'}
            interactionProps={Platform.OS === 'web' ? webHandleProps : panHandlers}
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
            active={dragging}
            inkColor={theme.colors.text.primary}
        />
    ) : null;

    return (
        <View
            testID={props.testID}
            style={{
                ...(props.fill ? { flex: 1, minWidth: 0 } : { width: props.drawnWidthPx ?? effectiveSizePx, flexShrink: 0 }),
                position: 'relative',
                alignSelf: 'stretch',
                height: '100%',
                minHeight: 0,
            }}
        >
            {resizeEdge === 'left' ? handle : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
            {resizeEdge === 'right' ? handle : null}
        </View>
    );
});
