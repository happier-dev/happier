/**
 * Pure decision for which chrome material to render.
 *
 * `liquidGlass` → real iOS 26 Liquid Glass (`expo-glass-effect`).
 * `blur`        → translucent native fallback (`expo-blur`) for platforms/builds without Liquid Glass.
 * `webBlur`     → web CSS `backdrop-filter` blur over a translucent tint.
 * `solid`       → opaque surface; also the accessibility-safe fallback.
 *
 * Reduce Transparency disables every translucency effect, so it forces `solid`
 * regardless of Liquid Glass / blur availability. Native blur is preferred over web
 * blur (a build can be native AND report web blur unavailable, never the reverse).
 */
export type GlassCapability = 'liquidGlass' | 'blur' | 'webBlur' | 'solid';

export type ResolveGlassCapabilityInput = Readonly<{
    liquidGlassAvailable: boolean;
    blurAvailable: boolean;
    /** Web CSS `backdrop-filter` blur (defaults to unavailable). */
    webBlurAvailable?: boolean;
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
    return 'solid';
}
