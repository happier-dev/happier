import * as React from 'react';
import { PanResponder, Platform, Pressable, View } from 'react-native';
import { t } from '@/text';
import { resolvePointerClientX } from './resolvePointerClientX';

export type ResizableDockedPaneProps = Readonly<{
    widthPx: number;
    minWidthPx: number;
    maxWidthPx: number;
    onCommitWidthPx: (widthPx: number) => void;
    onDragWidthPx?: (widthPx: number | null) => void;
    resizeEdge?: 'left' | 'right';
    children: React.ReactNode;
    testID?: string;
}>;

export const ResizableDockedPane = React.memo((props: ResizableDockedPaneProps) => {
    const { widthPx, minWidthPx, maxWidthPx, onCommitWidthPx } = props;
    const onDragWidthPx = props.onDragWidthPx;
    const resizeEdge = props.resizeEdge ?? 'left';
    const clamp = React.useCallback((value: number) => Math.min(maxWidthPx, Math.max(minWidthPx, value)), [maxWidthPx, minWidthPx]);
    const canResize = maxWidthPx - minWidthPx > 1;

    const dragStartWidthRef = React.useRef<number | null>(null);
    const dragStartClientXRef = React.useRef<number | null>(null);
    const dragLatestWidthRef = React.useRef<number | null>(null);
    const [dragWidthPx, setDragWidthPx] = React.useState<number | null>(null);

    const effectiveWidthPx = dragWidthPx ?? clamp(widthPx);

    const panResponder = React.useMemo(() => {
        return PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                dragStartWidthRef.current = effectiveWidthPx;
                setDragWidthPx(effectiveWidthPx);
                onDragWidthPx?.(effectiveWidthPx);
            },
            onPanResponderMove: (_event, gesture) => {
                const start = dragStartWidthRef.current ?? effectiveWidthPx;
                const delta = resizeEdge === 'left' ? -gesture.dx : gesture.dx;
                const next = clamp(start + delta);
                setDragWidthPx(next);
                onDragWidthPx?.(next);
            },
            onPanResponderRelease: () => {
                const next = clamp(dragWidthPx ?? effectiveWidthPx);
                dragStartWidthRef.current = null;
                setDragWidthPx(null);
                onCommitWidthPx(next);
                onDragWidthPx?.(null);
            },
            onPanResponderTerminate: () => {
                dragStartWidthRef.current = null;
                dragStartClientXRef.current = null;
                dragLatestWidthRef.current = null;
                setDragWidthPx(null);
                onDragWidthPx?.(null);
            },
        });
    }, [clamp, dragWidthPx, effectiveWidthPx, onCommitWidthPx, onDragWidthPx, resizeEdge]);

    const handleWebPointerDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        let clientX = resolvePointerClientX(event);
        if (clientX == null) {
            const locationX = typeof event?.nativeEvent?.locationX === 'number' && Number.isFinite(event.nativeEvent.locationX)
                ? event.nativeEvent.locationX
                : null;
            const targetLeft = (() => {
                const currentTarget = event?.currentTarget;
                if (typeof currentTarget?.getBoundingClientRect === 'function') {
                    return currentTarget.getBoundingClientRect()?.left ?? null;
                }
                const target = event?.target;
                if (typeof target?.getBoundingClientRect === 'function') {
                    return target.getBoundingClientRect()?.left ?? null;
                }
                return null;
            })();
            if (locationX != null && typeof targetLeft === 'number' && Number.isFinite(targetLeft)) {
                clientX = targetLeft + locationX;
            }
        }

        event?.preventDefault?.();
        event?.stopPropagation?.();

        dragStartWidthRef.current = effectiveWidthPx;
        dragStartClientXRef.current = clientX;
        dragLatestWidthRef.current = effectiveWidthPx;
        setDragWidthPx(effectiveWidthPx);
        onDragWidthPx?.(effectiveWidthPx);

        const win: any = (globalThis as any).window;
        if (!win?.addEventListener) return;

        const edgeSign = resizeEdge === 'left' ? -1 : 1;

        const onMove = (moveEvent: any) => {
            const nextClientX = resolvePointerClientX(moveEvent);
            if (nextClientX == null) return;
            const startWidth = dragStartWidthRef.current ?? effectiveWidthPx;
            let startX = dragStartClientXRef.current;
            if (startX == null) {
                // Some RN web press events do not provide initial coordinates. Establish the drag origin
                // on the first move so subsequent moves can compute a delta.
                dragStartClientXRef.current = nextClientX;
                startX = nextClientX;
            }
            const dx = nextClientX - startX;
            const next = clamp(startWidth + (edgeSign * dx));
            dragLatestWidthRef.current = next;
            setDragWidthPx(next);
            onDragWidthPx?.(next);
            moveEvent?.preventDefault?.();
        };

        const cleanup = () => {
            win.removeEventListener?.('pointermove', onMove);
            win.removeEventListener?.('mousemove', onMove);
            win.removeEventListener?.('touchmove', onMove);
            win.removeEventListener?.('pointerup', onUp);
            win.removeEventListener?.('mouseup', onUp);
            win.removeEventListener?.('touchend', onUp);
            win.removeEventListener?.('pointercancel', onUp);
            win.removeEventListener?.('touchcancel', onUp);
        };

        const onUp = (_upEvent: any) => {
            cleanup();
            const next = clamp(dragLatestWidthRef.current ?? effectiveWidthPx);
            dragStartWidthRef.current = null;
            dragStartClientXRef.current = null;
            dragLatestWidthRef.current = null;
            setDragWidthPx(null);
            onCommitWidthPx(next);
            onDragWidthPx?.(null);
        };

        win.addEventListener('pointermove', onMove);
        win.addEventListener('mousemove', onMove);
        win.addEventListener('touchmove', onMove);
        win.addEventListener('pointerup', onUp);
        win.addEventListener('mouseup', onUp);
        win.addEventListener('touchend', onUp);
        win.addEventListener('pointercancel', onUp);
        win.addEventListener('touchcancel', onUp);

        const target = event?.currentTarget ?? event?.target;
        const pointerId = event?.nativeEvent?.pointerId ?? event?.pointerId;
        if (typeof target?.setPointerCapture === 'function' && typeof pointerId === 'number') {
            try {
                target.setPointerCapture(pointerId);
            } catch {
                // Best-effort pointer capture; ignore failures.
            }
        }
    }, [clamp, effectiveWidthPx, onCommitWidthPx, onDragWidthPx, resizeEdge]);

    const handleKeyDown = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        const key = String(event?.key ?? '');
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const step = event?.shiftKey ? 32 : 8;
        const arrowSign = key === 'ArrowRight' ? 1 : -1;
        const edgeSign = resizeEdge === 'left' ? -1 : 1;
        const next = clamp(effectiveWidthPx + (arrowSign * edgeSign * step));
        onCommitWidthPx(next);
    }, [clamp, effectiveWidthPx, onCommitWidthPx, resizeEdge]);

    return (
        <View
            testID={props.testID}
            style={{
                width: effectiveWidthPx,
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
                            onKeyDown: handleKeyDown,
                            onPressIn: handleWebPointerDown,
                            onPointerDown: handleWebPointerDown,
                            onMouseDown: handleWebPointerDown,
                            onTouchStart: handleWebPointerDown,
                        } as any)
                        : panResponder.panHandlers)}
                    style={{
                        position: 'absolute',
                        ...(resizeEdge === 'left' ? { left: 0 } : { right: 0 }),
                        top: 0,
                        bottom: 0,
                        width: 10,
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
                            width: 2,
                            backgroundColor: 'rgba(0,0,0,0.08)',
                        }}
                    />
                </Pressable>
            ) : null}
            <View style={{ flex: 1, width: '100%', minHeight: 0 }}>{props.children}</View>
        </View>
    );
});
