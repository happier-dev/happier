import * as React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import type { HappierStyleProp } from '../../portableTypes.js';
import { useOptionalHappierUiTheme } from '../../../environment/context.js';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../../../environment/interactiveTarget.js';

/** The seam's ink while pointing at the handle, and while dragging it (lab ade-shell SH2/SH3). */
const SEAM_HOVER = { widthPx: 1, opacity: 0.28 } as const;
const SEAM_ACTIVE = { widthPx: 2, opacity: 0.46 } as const;

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
    const webTargetSize = Platform.OS === 'web' ? HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE : null;
    const inwardExpansion = Math.max(0, (nativeTouchTargetSize ?? webTargetSize ?? visualHandleSize) - visualHandleSize);
    // Negative margins keep the caller's position whether it anchors from left/top or right/bottom.
    // A centred divider expands equally. On the web an edge handle grows only outward, over the
    // neighbour beyond the edge it resizes: it never covers more of its own pane than the drawn divider,
    // which pane gutters are laid out around, so the pane's trailing controls stay clickable. Its host
    // leaves that seam unclipped and paints the pane above the neighbour it reaches into.
    const startExpansion = props.edge === undefined ? inwardExpansion / 2 : props.edge === 'start' ? inwardExpansion : 0;
    const endExpansion = inwardExpansion - startExpansion;
    // The seam ink draws on the edge: the drawn box's outer edge, offset from the web target's centre;
    // on native the target is the drawn box itself.
    const seamAlign = props.edge === undefined || webTargetSize !== null ? 'center' : props.edge === 'start' ? 'flex-start' : 'flex-end';
    const seamOffset = props.edge === undefined || webTargetSize === null ? 0
        : (props.edge === 'end' ? startExpansion + visualHandleSize : startExpansion) - (visualHandleSize + inwardExpansion) / 2;
    const indicatorOffset = Platform.OS === 'web' ? (startExpansion - endExpansion) / 2 : 0;
    // Native HitRects cannot extend beyond the pane parent. Expand only inward
    // from the owning edge so the full 44/48pt target remains reachable without
    // shifting the visual divider or overlapping the adjacent pane.
    const nativeHitSlop = nativeTouchTargetSize === null || props.edge === undefined
        ? undefined
        : props.axis === 'x'
            ? props.edge === 'start' ? { right: inwardExpansion } : { left: inwardExpansion }
            : props.edge === 'start' ? { bottom: inwardExpansion } : { top: inwardExpansion };
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
                Platform.OS === 'web' ? (props.axis === 'x'
                    ? { minWidth: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, marginLeft: -startExpansion, marginRight: -endExpansion }
                    : { minHeight: HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, marginTop: -startExpansion, marginBottom: -endExpansion }) : null,
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

