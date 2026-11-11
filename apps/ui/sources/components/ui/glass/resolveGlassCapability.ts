/**
 * Pure decision for which chrome material to render.
 *
 * `liquidGlass` → real iOS 26 Liquid Glass (`expo-glass-effect`).
 * `blur`        → translucent native fallback (`expo-blur`) for platforms/builds without Liquid Glass.
 * `webBlur`     → web CSS `backdrop-filter` blur over a translucent tint.
 * `tint`        → native translucent coat without blur (in-flow Elements, or Blur Off on a translucent material).
 * `solid`       → opaque surface; also the accessibility-safe fallback.
 *
 * Reduce Transparency disables every translucency effect, so it forces `solid`
 * regardless of Liquid Glass / blur availability. Native blur is preferred over web
 * blur (a build can be native AND report web blur unavailable, never the reverse).
 */
export type GlassCapability = 'liquidGlass' | 'blur' | 'webBlur' | 'tint' | 'solid';

export type ResolveGlassCapabilityInput = GlassMaterialEnvironment & Readonly<{
    liquidGlassAvailable: boolean;
    blurAvailable: boolean;
    /** Web CSS `backdrop-filter` blur (defaults to unavailable). */
    webBlurAvailable?: boolean;
    reduceTransparency: boolean;
    settings?: GlassMaterialSettings;
    surfaceGroup?: GlassSurfaceGroup;
}>;

export function resolveGlassCapability(input: ResolveGlassCapabilityInput): GlassCapability {
    const material = input.settings ? resolveGlassSurfaceMaterial(input.settings, input.surfaceGroup ?? 'floating', input).material : null;
    if (input.reduceTransparency || material?.opacity === 1) {
        return 'solid';
    }
    // In-flow Elements may be numerous. Native uses their coat without mounting an SDK view per card.
    if (input.surfaceGroup === 'card') {
        return input.webBlurAvailable === true ? material?.blur === 'off' ? 'solid' : 'webBlur' : 'tint';
    }
    // Blur Off keeps an authored translucent coat: native draws it as a tint, web paints it unblurred.
    if (material?.blur === 'off') return input.webBlurAvailable === true ? 'solid' : 'tint';
    // Named floating presets use fixed web frost; native Liquid Glass adapts
    // itself. An authored Strong material still selects adjustable native blur.
    const namedFloating = (input.surfaceGroup ?? 'floating') === 'floating'
        && input.settings !== undefined && readGlassPreset(input.settings) !== 'custom';
    const strong = material?.blur === 'strong' && !namedFloating;
    if (input.liquidGlassAvailable && !(strong && input.blurAvailable)) {
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
import { readGlassPreset, resolveGlassSurfaceMaterial, type GlassMaterialSettings, type GlassSurfaceGroup, type GlassMaterialEnvironment } from './glassMaterial';
