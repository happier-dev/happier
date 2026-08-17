import * as React from 'react';
import { Platform, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { t } from '@/text';

export function resolveResizablePaneNativeTouchTargetSize(): number | null {
    if (Platform.OS === 'web') return null;
    return Platform.OS === 'android' ? 48 : 44;
}

export const ResizablePaneDividerHandle = React.memo((props: Readonly<{
    axis: 'x' | 'y';
    /** Omit for a centered divider whose parent already owns the full target. */
    edge?: 'start' | 'end';
    testID?: string;
    style?: StyleProp<ViewStyle>;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorOpacity?: number;
    interactionProps?: Partial<PressableProps>;
    accessibilityHandleProps?: Pick<
        PressableProps,
        'accessibilityActions' | 'accessibilityValue' | 'onAccessibilityAction'
    >;
}>) => {
    const showIndicator = props.showIndicator !== false && typeof props.indicatorColor === 'string';
    const nativeTouchTargetSize = resolveResizablePaneNativeTouchTargetSize();
    const visualHandleSize = props.axis === 'x' ? 10 : 18;
    const inwardExpansion = Math.max(0, (nativeTouchTargetSize ?? visualHandleSize) - visualHandleSize);
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
            testID={props.testID}
            focusable={Platform.OS === 'web'}
            accessibilityRole="adjustable"
            accessibilityLabel={t('ui.resizableDockedPane.resizeA11y')}
            accessibilityHint={t('ui.resizableDockedPane.resizeHint')}
            {...props.interactionProps}
            {...props.accessibilityHandleProps}
            hitSlop={nativeHitSlop}
            style={[
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: props.axis === 'x' ? ('col-resize' as any) : ('row-resize' as any),
                    userSelect: 'none' as any,
                    ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as any) : null),
                },
                props.style,
                centeredNativeTargetStyle,
            ]}
        >
            {showIndicator ? (
                <View
                    style={props.axis === 'x'
                        ? {
                            width: 1,
                            height: '100%',
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }
                        : {
                            width: 56,
                            height: 5,
                            borderRadius: 999,
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }}
                />
            ) : null}
        </Pressable>
    );
});
