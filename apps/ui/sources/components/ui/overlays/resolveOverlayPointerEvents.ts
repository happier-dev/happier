import { Platform, type ViewStyle } from 'react-native';

export type OverlayPointerEvents = 'box-none' | 'none' | 'auto' | 'box-only';

/**
 * React Native owns responder routing through the `pointerEvents` prop, while
 * react-native-web now owns the same behavior through `style.pointerEvents`.
 * Keep that platform seam here so overlay consumers do not choose divergent
 * web/native behavior (or reintroduce the deprecated RNW prop path).
 */
export function resolveOverlayPointerEvents(pointerEvents: OverlayPointerEvents): Readonly<{
    nativePointerEvents: OverlayPointerEvents | undefined;
    webStyle: ViewStyle | undefined;
}> {
    if (Platform.OS === 'web') {
        return {
            nativePointerEvents: undefined,
            webStyle: { pointerEvents },
        };
    }

    return {
        nativePointerEvents: pointerEvents,
        webStyle: undefined,
    };
}
