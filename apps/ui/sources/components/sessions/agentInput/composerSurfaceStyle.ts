export type ComposerSurfaceStyle = 'standard' | 'glass';

/**
 * Whether the composer should render with the opt-in "glass" surface — the
 * Liquid Glass tab bar's solid look (a `surface.base` fill + the tab bar's
 * stronger cast shadow) — rather than the default glass surface (a near-white
 * fill + a softer shadow).
 *
 * Both surfaces share the glass rim + inset depth and are fully solid, so this
 * applies on every platform (no native-blur dependency).
 */
export function isGlassComposerSurface(params: {
    setting: ComposerSurfaceStyle | undefined;
}): boolean {
    return params.setting === 'glass';
}
