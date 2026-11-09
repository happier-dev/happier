import { Dimensions, Platform } from 'react-native';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';
import { isRunningOnMac } from './platform';
import { isWebMobileHost } from './webMobileHeuristics';

// Re-export calculation functions for use in other components
export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };

/**
 * Window geometry is presentation work; retained background workflows stay connected separately. A hidden
 * retained pane holds no Dimensions listener, and hiding or showing it renders none of its readers: the
 * presentation fact arrives as a subscription, and showing re-reads the window once, rendering only when
 * the geometry changed while it was hidden.
 */
export function usePresentationWindowDimensions() {
    const presentation = useLayoutPresentationSignal();
    const [, invalidate] = useReducer((revision: number) => revision + 1, 0);
    // Dimensions remains the authority, including the first render after a retained pane is revealed.
    const dimensions = Dimensions.get('window');
    const { width, height, scale, fontScale } = dimensions;
    useLayoutEffect(() => {
        const onChange = () => {
            const next = Dimensions.get('window');
            if (next.width !== width || next.height !== height || next.scale !== scale || next.fontScale !== fontScale) {
                invalidate();
            }
        };
        let subscription: ReturnType<typeof Dimensions.addEventListener> | null = null;
        const follow = () => {
            if (!presentation.get()) {
                subscription?.remove();
                subscription = null;
                return;
            }
            if (subscription) return;
            subscription = Dimensions.addEventListener('change', onChange);
            // Close the render-to-subscription (or hidden-to-shown) window using the same platform authority.
            onChange();
        };
        follow();
        const stopFollowing = presentation.subscribe(follow);
        return () => { stopFollowing(); subscription?.remove(); };
    }, [presentation, width, height, scale, fontScale]);
    return dimensions;
}

// Get header height based on platform, device type, and orientation (wrapper for backward compatibility)
export function getHeaderHeight(isLandscape: boolean, deviceType: 'phone' | 'tablet'): number {
    return calculateHeaderHeight({
        platform: Platform.OS,
        isLandscape,
        isPad: Platform.OS === 'ios' ? (Platform as any).isPad === true : undefined,
        deviceType: Platform.OS === 'android' ? deviceType : undefined,
        isMacCatalyst: isRunningOnMac()
    });
}

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    const { width, height } = Dimensions.get('window');
    const isPad = Platform.OS === 'ios' ? (Platform as any).isPad === true : false;

    return determineDeviceType({
        platform: Platform.OS, isPad, widthPoints: width, heightPoints: height,
        isWebMobileHost: isWebMobileHost(), isMacCatalyst: isRunningOnMac(),
    });
}

// Hook to get device type (reactive to dimension changes)
export function useDeviceType(): 'phone' | 'tablet' {
    const { width, height } = usePresentationWindowDimensions();
    const webMobileHost = isWebMobileHost();
    const fallbackDims = Dimensions.get('window');
    const fallbackWidth = (fallbackDims as any)?.width;
    const fallbackHeight = (fallbackDims as any)?.height;

    const lastValidDimsRef = useRef<Readonly<{ width: number; height: number }> | null>(null);

    const resolvedDims = useMemo(() => {
        const normalize = (w: unknown, h: unknown): { width: number; height: number } | null => {
            const widthPoints = Number(w);
            const heightPoints = Number(h);
            if (!Number.isFinite(widthPoints) || !Number.isFinite(heightPoints)) return null;
            const normalizedWidth = Math.abs(widthPoints);
            const normalizedHeight = Math.abs(heightPoints);
            if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
            return { width: normalizedWidth, height: normalizedHeight };
        };

        const fromHook = normalize(width, height);
        if (fromHook) return fromHook;

        const fromDimensionsGet = normalize(fallbackWidth, fallbackHeight);
        if (fromDimensionsGet) return fromDimensionsGet;

        return lastValidDimsRef.current ?? { width: 0, height: 0 };
    }, [fallbackHeight, fallbackWidth, height, width]);

    useEffect(() => {
        if (resolvedDims.width <= 0 || resolvedDims.height <= 0) return;
        lastValidDimsRef.current = resolvedDims;
    }, [resolvedDims.height, resolvedDims.width]);

    return useMemo(() => {
        const isPad = Platform.OS === 'ios' ? (Platform as any).isPad === true : false;
        return determineDeviceType({
            platform: Platform.OS,
            isPad,
            isWebMobileHost: webMobileHost,
            isMacCatalyst: isRunningOnMac(),
            widthPoints: resolvedDims.width,
            heightPoints: resolvedDims.height,
        });
    }, [webMobileHost, resolvedDims.height, resolvedDims.width]);
}

// Hook to detect if device is tablet
export function useIsTablet(): boolean {
    const deviceType = useDeviceType();
    return deviceType === 'tablet';
}

// Hook to detect landscape orientation
export function useIsLandscape(): boolean {
    const { width, height } = usePresentationWindowDimensions();
    return width > height;
}

// Hook to get header height based on platform, device type, and orientation
export function useHeaderHeight(): number {
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    
    return useMemo(() => {
        return calculateHeaderHeight({
            platform: Platform.OS,
            isLandscape,
            isPad: Platform.OS === 'ios' ? (Platform as any).isPad === true : undefined,
            deviceType: Platform.OS === 'android' ? deviceType : undefined,
            isMacCatalyst: isRunningOnMac()
        });
    }, [isLandscape, deviceType]);
}
