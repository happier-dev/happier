import { useWindowDimensions } from 'react-native';

export type UnauthShellLayout = 'desktop' | 'compact';

/**
 * The width at and below which the signed-out column recomposes for a phone (the platform back at top-left, the
 * links under the column). Above it the same column stands centred with the wordmark and links in the corners.
 */
export const MOBILE_MAX_WIDTH_PX = 720;

/** Which of the two signed-out compositions a frame of this width takes. */
export function unauthShellLayoutFor(width: number): UnauthShellLayout {
    return width <= MOBILE_MAX_WIDTH_PX ? 'compact' : 'desktop';
}

/** Which of the two signed-out compositions the window takes now; it follows the window as it resizes. */
export function useUnauthShellLayout(frameWidth?: number): UnauthShellLayout {
    const { width } = useWindowDimensions();
    return unauthShellLayoutFor(frameWidth ?? width);
}
