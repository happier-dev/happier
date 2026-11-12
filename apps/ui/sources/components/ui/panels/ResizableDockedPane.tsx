import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
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
    onResizeHandleActiveChange?: (active: boolean) => void;
    children: React.ReactNode;
    testID?: string;
}>;

const RESIZE_HANDLE_WIDTH = 4;
const RESIZE_HANDLE_HEIGHT = 32;
const RESIZE_HANDLE_HIT_WIDTH = RESIZE_HANDLE_WIDTH * 4;
const RESIZE_HANDLE_HIT_HEIGHT = RESIZE_HANDLE_HEIGHT * 4;

export const ResizableDockedPane = React.memo((props: ResizableDockedPaneProps) => {
    const { theme } = useUnistyles();
    const [resizeHandleHovered, setResizeHandleHovered] = React.useState(false);
    const [resizeHandleHeld, setResizeHandleHeld] = React.useState(false);
    const resizeHandleActive = resizeHandleHovered || resizeHandleHeld;
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
                    {...(Platform.OS === 'web' ? webHandleProps as any : panHandlers as any)}
                    onHoverIn={() => {
                        setResizeHandleHovered(true);
                        props.onResizeHandleActiveChange?.(true);
                    }}
                    onHoverOut={() => {
                        setResizeHandleHovered(false);
                        props.onResizeHandleActiveChange?.(resizeHandleHeld);
                    }}
                    onPressIn={(event) => {
                        setResizeHandleHeld(true);
                        props.onResizeHandleActiveChange?.(true);
                        if (Platform.OS === 'web') {
                            (webHandleProps.onPressIn as ((event: unknown) => void) | undefined)?.(event);
                        }
                    }}
                    onPressOut={() => {
                        setResizeHandleHeld(false);
                        props.onResizeHandleActiveChange?.(resizeHandleHovered);
                    }}
                    style={{
                        position: 'absolute',
                        ...(resizeEdge === 'left'
                            ? { left: -(RESIZE_HANDLE_HIT_WIDTH - RESIZE_HANDLE_WIDTH) / 2 }
                            : { right: -(RESIZE_HANDLE_HIT_WIDTH - RESIZE_HANDLE_WIDTH) / 2 }),
                        top: '50%',
                        transform: [{ translateY: -RESIZE_HANDLE_HIT_HEIGHT / 2 }],
                        width: RESIZE_HANDLE_HIT_WIDTH,
                        height: RESIZE_HANDLE_HIT_HEIGHT,
                        cursor: 'col-resize' as any,
                        zIndex: 1000,
                        userSelect: 'none' as any,
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                    }}
                >
                    <View
                        pointerEvents="none"
                        style={{
                            width: resizeHandleActive ? RESIZE_HANDLE_WIDTH * 2 : RESIZE_HANDLE_WIDTH,
                            height: resizeHandleActive ? RESIZE_HANDLE_HEIGHT * 2 : RESIZE_HANDLE_HEIGHT,
                            borderRadius: RESIZE_HANDLE_WIDTH,
                            backgroundColor: theme.colors.text.secondary,
                            opacity: resizeHandleActive ? 1 : 0.55,
                        }}
                    />
                </Pressable>
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
