import * as React from 'react';
import { Platform, StyleSheet, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

import { normalizeWindowFoldMetrics, type WindowFoldMetrics } from './windowFoldMetrics';

type NativeObserverProps = ViewProps & {
    onMetricsChange: (event: { nativeEvent: unknown }) => void;
};

// Older installed binaries and Expo Go do not have this local module. Their window has no reported fold.
const NativeObserver = Platform.OS === 'ios' && requireOptionalNativeModule('HappierWindowFoldMetrics')
    ? requireNativeViewManager<NativeObserverProps>('HappierWindowFoldMetrics')
    : null;

const WindowFoldMetricsContext = React.createContext<WindowFoldMetrics | null>(null);

/** Mount once inside the window's full-size root view. The observer has no layout or input effect. */
export function WindowFoldMetricsProvider({ children }: React.PropsWithChildren) {
    const [metrics, setMetrics] = React.useState<WindowFoldMetrics | null>(null);
    const onMetricsChange = React.useCallback(({ nativeEvent }: { nativeEvent: unknown }) => {
        setMetrics((previous) => normalizeWindowFoldMetrics(nativeEvent, previous));
    }, []);

    return (
        <WindowFoldMetricsContext.Provider value={metrics}>
            {Platform.OS === 'ios' && NativeObserver ? (
                <NativeObserver
                    style={StyleSheet.absoluteFill}
                    collapsable={false}
                    pointerEvents="none"
                    accessible={false}
                    onMetricsChange={onMetricsChange}
                />
            ) : null}
            {children}
        </WindowFoldMetricsContext.Provider>
    );
}

/**
 * null means unavailable/not measured; an empty divisions array means the window has no active division.
 * Geometry is in window points. Keep using useSafeAreaInsets for the system vertical-bar side/insets.
 * This reports window geometry, not hardware capability or phone/tablet classification.
 */
export function useWindowFoldMetrics(): WindowFoldMetrics | null {
    return React.useContext(WindowFoldMetricsContext);
}
