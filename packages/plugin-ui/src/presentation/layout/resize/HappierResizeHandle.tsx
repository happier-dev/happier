import * as React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import type { HappierStyleProp } from '../../portableTypes.js';
import { useOptionalHappierUiTheme } from '../../../environment/context.js';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../../../environment/interactiveTarget.js';

/** The seam's ink while pointing at the handle, and while dragging it (lab ade-shell SH2/SH3). */
const SEAM_HOVER = { widthPx: 1, opacity: 0.28 } as const;
const SEAM_ACTIVE = { widthPx: 2, opacity: 0.46 } as const;
// The web resize seam shares its inside edge with the pane's scrollbar.
const WEB_EDGE_TARGET_PX = 8;

export function resolveResizablePaneNativeTouchTargetSize(): number | null {
    if (Platform.OS === 'web') return null;
    return Platform.OS === 'android' ? 48 : 44;
}

export const HappierResizeHandle = React.memo((props: Readonly<{
    labels: Readonly<{ label: string; hint?: string; value?: (px: number) => string }>;
    axis: 'x' | 'y';
    /** Omit for a centered divider whose parent already owns the full target. */
    edge?: 'start' | 'end';
    testID?: string;
    style?: HappierStyleProp;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorOpacity?: number;
    /**
     * While the size is being dragged (`useResizableSize().dragging`): the seam draws in ink at full
     * weight. Pointing at the handle draws it lighter. The ink is the theme's text colour unless given.
     */
    active?: boolean;
    inkColor?: string;
    /** Opaque web/native responder props returned by useResizableSize. */
    interactionProps?: Readonly<Record<string, unknown>>;
    accessibilityHandleProps?: Readonly<{
        accessibilityValue?: Readonly<{ min?: number; max?: number; now?: number }>;
        accessibilityActions?: ReadonlyArray<Readonly<{ name: 'increment' | 'decrement' }>>;
        onAccessibilityAction?: (event: unknown) => void;
    }>;
}>) => {
    const handleRef = React.useRef<React.ElementRef<typeof View>>(null);
    const { onDoubleClick, ...interactionProps } = props.interactionProps ?? {};
    const resetRef = React.useRef(onDoubleClick);
    resetRef.current = onDoubleClick;
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        // CSS-only interaction styles belong to the real web host, not native ViewStyle.
        const host = handleRef.current;
        if (typeof HTMLElement !== 'undefined' && host instanceof HTMLElement) {
            host.style.userSelect = 'none';
            host.style.touchAction = 'none';
        }
        const target = handleRef.current as unknown as Partial<Pick<EventTarget, 'addEventListener' | 'removeEventListener'>> | null;
        if (!target?.addEventListener || !target.removeEventListener) return;
        const reset = () => { if (typeof resetRef.current === 'function') resetRef.current(); };
        target.addEventListener('dblclick', reset);
        return () => target.removeEventListener?.('dblclick', reset);
    }, []);
    const showIndicator = props.showIndicator !== false && typeof props.indicatorColor === 'string';
    const theme = useOptionalHappierUiTheme();
    const inkColor = props.inkColor ?? theme?.colors.text ?? null;
    const [hovered, setHovered] = React.useState(false);
    const seam = props.active ? SEAM_ACTIVE : hovered ? SEAM_HOVER : null;
    const nativeTouchTargetSize = resolveResizablePaneNativeTouchTargetSize();
    const visualHandleSize = props.axis === 'x' ? 10 : 18;
    const web = Platform.OS === 'web';
    const edgeTarget = web && props.edge !== undefined;
    const webCenteredExpansion = (HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE - visualHandleSize) / 2;
    const nativeExpansion = Math.max(0, (nativeTouchTargetSize ?? visualHandleSize) - visualHandleSize);
    const edgeDirection = props.edge === 'start' ? 1 : -1;
    // The web hit zone sits entirely outside the pane. Keep the painted seam
    // at the boundary and the optional indicator in its original drawn box.
    const seamOffset = edgeTarget ? edgeDirection * WEB_EDGE_TARGET_PX / 2 : 0;
    const indicatorOffset = edgeTarget ? edgeDirection * (WEB_EDGE_TARGET_PX + visualHandleSize) / 2 : 0;
    const seamAlign = props.edge === undefined || web ? 'center' : props.edge === 'start' ? 'flex-start' : 'flex-end';
    const startMargin = edgeTarget ? (props.edge === 'start' ? -WEB_EDGE_TARGET_PX : visualHandleSize) : -webCenteredExpansion;
    const endMargin = edgeTarget ? (props.edge === 'end' ? -WEB_EDGE_TARGET_PX : visualHandleSize) : -webCenteredExpansion;
    const webTargetStyle = props.axis === 'x'
        ? { ...(edgeTarget ? { width: WEB_EDGE_TARGET_PX } : { minWidth: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE }),
            marginLeft: startMargin, marginRight: endMargin }
        : { ...(edgeTarget ? { height: WEB_EDGE_TARGET_PX } : { minHeight: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE }),
            marginTop: startMargin, marginBottom: endMargin };
    // Native HitRects cannot extend beyond the pane parent. Expand only inward
    // from the owning edge so the full 44/48pt target remains reachable without
    // shifting the visual divider or overlapping the adjacent pane.
    const nativeHitSlop = nativeTouchTargetSize === null || props.edge === undefined
        ? undefined
        : props.axis === 'x'
            ? props.edge === 'start' ? { right: nativeExpansion } : { left: nativeExpansion }
            : props.edge === 'start' ? { bottom: nativeExpansion } : { top: nativeExpansion };
    const centeredNativeTargetStyle: ViewStyle | undefined = nativeTouchTargetSize === null || props.edge !== undefined
        ? undefined
        : props.axis === 'x'
            ? { width: nativeTouchTargetSize }
            : { height: nativeTouchTargetSize };

    return (
        <Pressable
            ref={handleRef}
            testID={props.testID}
            focusable={Platform.OS === 'web'}
            accessibilityRole="adjustable"
            accessibilityLabel={props.labels.label}
            accessibilityHint={props.labels.hint}
            {...interactionProps}
            {...props.accessibilityHandleProps}
            {...resolveDividerValueProps(props.accessibilityHandleProps?.accessibilityValue, props.labels.value)}
            hitSlop={nativeHitSlop}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            style={[
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                // The axis's resize cursor, no text selection and no browser touch panning while dragging. React
                // Native Web supports these CSS properties; React Native's ViewStyle does not declare them.
                Platform.OS === 'web' ? ({
                    cursor: props.axis === 'x' ? 'col-resize' : 'row-resize',
                    userSelect: 'none',
                    touchAction: 'none',
                } as object) : null,
                props.style,
                centeredNativeTargetStyle,
                web ? webTargetStyle : null,
            ]}
        >
            {seam && inkColor && !showIndicator ? (
                // The seam sits on the edge it resizes, over the columns' own hairline.
                <View
                    pointerEvents="none"
                    style={props.axis === 'x'
                        ? { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: seamAlign }
                        : { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: seamAlign }}
                >
                    <View style={props.axis === 'x'
                        ? { width: seam.widthPx, height: '100%', backgroundColor: inkColor, opacity: seam.opacity, transform: [{ translateX: seamOffset }] }
                        : { height: seam.widthPx, width: '100%', backgroundColor: inkColor, opacity: seam.opacity, transform: [{ translateY: seamOffset }] }} />
                </View>
            ) : null}
            {showIndicator ? (
                <View
                    style={props.axis === 'x'
                        ? {
                            width: 1,
                            height: '100%',
                            transform: [{ translateX: indicatorOffset }],
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }
                        : {
                            width: 56,
                            height: 5,
                            transform: [{ translateY: indicatorOffset }],
                            borderRadius: 999,
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }}
                />
            ) : null}
        </Pressable>
    );
});

/**
 * The divider's size as a slider's value, in the ARIA attributes a screen reader announces: React
 * Native Web does not project `accessibilityValue` on a pressable, so the web reads the size from
 * these (min, max, now and the spoken text).
 */
function resolveDividerValueProps(value: Readonly<{ min?: number; max?: number; now?: number }> | undefined, valueLabel?: (px: number) => string) {
    if (Platform.OS !== 'web' || !value || typeof value.now !== 'number') return null;
    const now = Math.round(value.now);
    return {
        role: 'slider',
        'aria-valuenow': now,
        ...(typeof value.min === 'number' ? { 'aria-valuemin': Math.round(value.min) } : {}),
        ...(typeof value.max === 'number' ? { 'aria-valuemax': Math.round(value.max) } : {}),
        'aria-valuetext': valueLabel?.(now) ?? String(now),
    } as Record<string, unknown>;
}

