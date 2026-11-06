import * as React from 'react';
import type { View, ViewProps } from 'react-native';
import { Platform, StyleSheet, View as ReactNativeView } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';

import { FloatingChromeClearanceReservedContext, useFloatingChromeClearanceReservation } from '@/components/ui/layout/useFloatingChromeClearance';

import { resolveKeyboardStickyFooterOffset } from './keyboardAvoidanceGeometry';

export type KeyboardStickyFooterProps = ViewProps & Readonly<{
    offset?: number;
    enabled?: boolean;
}>;

export const KeyboardStickyFooter = React.forwardRef<View, KeyboardStickyFooterProps>(
    function KeyboardStickyFooter({ offset, enabled, style, children, ...props }, ref) {
        const { clearance, reserved } = useFloatingChromeClearanceReservation();
        const padding = StyleSheet.flatten(style);
        const bottom = padding?.paddingBottom ?? padding?.paddingVertical ?? padding?.padding ?? 0;
        const footerStyle = clearance > 0
            ? [style, { paddingBottom: (typeof bottom === 'number' ? bottom : 0) + clearance }]
            : style;
        const body = (
            <FloatingChromeClearanceReservedContext.Provider value={reserved}>
                {children}
            </FloatingChromeClearanceReservedContext.Provider>
        );
        if (Platform.OS === 'web') {
            return <KeyboardStickyFooterView ref={ref} {...props} style={footerStyle}>{body}</KeyboardStickyFooterView>;
        }

        return (
            <KeyboardStickyView
                ref={ref}
                offset={resolveKeyboardStickyFooterOffset(offset)}
                enabled={enabled}
                {...props}
                style={footerStyle}
            >
                {body}
            </KeyboardStickyView>
        );
    },
);

const KeyboardStickyFooterView = React.forwardRef<View, ViewProps>(function KeyboardStickyFooterView(props, ref) {
    return <ReactNativeView ref={ref} {...props} />;
});
