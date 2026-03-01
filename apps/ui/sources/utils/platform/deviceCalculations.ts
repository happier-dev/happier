// Pure calculation functions for viewport sizing.
// These functions have no dependencies on React Native or platform-specific APIs.

import { VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX } from './viewportClass';

export function calculateDeviceDimensions(params: {
    widthPoints: number;
    heightPoints: number;
}): {
    minEdgePoints: number;
    maxEdgePoints: number;
    diagonalPoints: number;
} {
    const width = Number.isFinite(params.widthPoints) ? Math.max(0, Math.abs(params.widthPoints)) : 0;
    const height = Number.isFinite(params.heightPoints) ? Math.max(0, Math.abs(params.heightPoints)) : 0;
    const minEdgePoints = Math.min(width, height);
    const maxEdgePoints = Math.max(width, height);
    const diagonalPoints = Math.sqrt(width * width + height * height);
    return { minEdgePoints, maxEdgePoints, diagonalPoints };
}

export function determineDeviceType(params: {
    platform: string;
    widthPoints: number;
    heightPoints: number;
    isPad?: boolean;
    tabletMinEdgePoints?: number; // Default aligns with viewport-class `tabletMin`
}): 'phone' | 'tablet' {
    const { tabletMinEdgePoints = VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin } = params;

    const metrics = calculateDeviceDimensions({ widthPoints: params.widthPoints, heightPoints: params.heightPoints });
    if (!Number.isFinite(metrics.minEdgePoints) || metrics.minEdgePoints <= 0) return 'phone';
    return metrics.minEdgePoints >= tabletMinEdgePoints ? 'tablet' : 'phone';
}

// Calculate header height based on platform, device info, and orientation
export function calculateHeaderHeight(params: {
    platform: string;
    isLandscape: boolean;
    isPad?: boolean; // For iOS, use Platform.isPad
    deviceType?: 'phone' | 'tablet'; // For Android, use our device type detection
    isMacCatalyst?: boolean; // For Mac Catalyst apps
}): number {
    const { platform, isLandscape, isPad, deviceType, isMacCatalyst } = params;
    
    // Mac Catalyst: Use dedicated height for desktop environment
    if (isMacCatalyst) {
        return 56; // Mac Catalyst: 52 points (slightly taller than iOS for desktop feel)
    }
    
    // Web platform: Use Material Design height
    if (platform === 'web') {
        return 56; // Web: 64px for consistency with Material Design
    }
    
    if (platform === 'android') {
        // For Android, use our custom device type detection
        if (deviceType === 'phone') {
            return isLandscape ? 48 : 56; // Material Design: 48dp landscape, 56dp portrait
        }
        return 64; // Tablet: 64dp
    }
    
    // iOS: Use Platform.isPad for accurate native header height
    if (isPad) {
        return 50; // iPad (iOS 12+): 50 points
    }
    return 44; // iPhone: 44 points
}
