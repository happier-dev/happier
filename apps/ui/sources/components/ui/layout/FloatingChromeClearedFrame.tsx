import * as React from 'react';
import { View, type ViewProps } from 'react-native';

import { FloatingChromeClearanceReservedContext, useFloatingChromeClearanceReservation } from './useFloatingChromeClearance';

/**
 * A page body that stops above the shell's floating bottom chrome (a phone's tab bar, a docked New Session) when
 * the content inside owns its own scrolling. It reserves that chrome for its whole subtree, so a pinned footer or
 * page bar inside it (a pushed detail's actions) clears it once, not twice.
 */
export function FloatingChromeClearedFrame(props: ViewProps) {
    const { clearance, reserved } = useFloatingChromeClearanceReservation();
    const { style, children, ...rest } = props;
    return (
        <View {...rest} style={clearance > 0 ? [style, { paddingBottom: clearance }] : style}>
            <FloatingChromeClearanceReservedContext.Provider value={reserved}>
                {children}
            </FloatingChromeClearanceReservedContext.Provider>
        </View>
    );
}
