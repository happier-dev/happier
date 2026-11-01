/**
 * Pure decision for which chrome material to render.
 *
 * `liquidGlass` → real iOS 26 Liquid Glass (`expo-glass-effect`).
 * `blur`        → translucent native fallback (`expo-blur`) for iOS builds without Liquid Glass.
 * `webBlur`     → web CSS `backdrop-filter` blur over a translucent tint.
 * `tint`        → translucent tint with no blur, for native builds without a usable blur
 *                 (Android: see `isNativeBlurAvailable`).
 * `solid`       → opaque surface; also the accessibility-safe fallback.
 *
 * Reduce Transparency disables every translucency effect, so it forces `solid`
 * regardless of Liquid Glass / blur / tint availability. Native blur is preferred over web
 * blur (a build can be native AND report web blur unavailable, never the reverse), and any
 * blur is preferred over the unblurred tint.
 */
export type GlassCapability = 'liquidGlass' | 'blur' | 'webBlur' | 'tint' | 'solid';

export type ResolveGlassCapabilityInput = Readonly<{
    liquidGlassAvailable: boolean;
    blurAvailable: boolean;
    /** Web CSS `backdrop-filter` blur (defaults to unavailable). */
    webBlurAvailable?: boolean;
    /** Translucent tint without blur (defaults to unavailable). */
    tintAvailable?: boolean;
    reduceTransparency: boolean;
}>;

export function resolveGlassCapability(input: ResolveGlassCapabilityInput): GlassCapability {
    if (input.reduceTransparency) {
        return 'solid';
    }
    if (input.liquidGlassAvailable) {
        return 'liquidGlass';
    }
    if (input.blurAvailable) {
        return 'blur';
    }
    if (input.webBlurAvailable === true) {
        return 'webBlur';
    }
    if (input.tintAvailable === true) {
        return 'tint';
    }
    return 'solid';
}
