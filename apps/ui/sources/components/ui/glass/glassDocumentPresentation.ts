import { GLASS_BLUR_RADIUS_PX, GLASS_SURFACE_GROUPS, resolveGlassSurfaceMaterial, type GlassMaterialEnvironment, type GlassMaterialSettings } from './glassMaterial';
import { resolveGlassSurfacePlaneMaterial } from './glassSurfacePaint';

/** Unistyles publishes authored web colors as root custom properties. */
export { readGlassDocumentColor } from './glassMaterial';

/** The document and static preview scopes share the same effective material projection. */
export function resolveGlassPresentationVariables(settings: GlassMaterialSettings, environment: GlassMaterialEnvironment): Record<string, string> {
    return Object.fromEntries(GLASS_SURFACE_GROUPS.flatMap(group => {
        const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
        const plane = resolveGlassSurfacePlaneMaterial(settings, group, environment);
        return [
            [`--happier-glass-${group}-opacity`, `${material.opacity * 100}%`],
            [`--happier-glass-${group}-nested-opacity`, material.opacity < 1 ? '0%' : '100%'],
            [`--happier-glass-${group}-blur`, `${GLASS_BLUR_RADIUS_PX[material.blur as keyof typeof GLASS_BLUR_RADIUS_PX]}px`],
            ...(group === 'content' ? [
                [`--happier-glass-content-plane-opacity`, `${plane.opacity * 100}%`],
                [`--happier-glass-content-nested-plane-opacity`, plane.opacity < 1 ? '0%' : '100%'],
            ] : []),
        ];
    }));
}

/** Reveal only backing that the main desktop window has successfully applied. */
export function shouldRevealNativeGlassCanvas(environment: GlassMaterialEnvironment): boolean {
    return environment.desktopWindow === true && environment.nativeWindowMaterialLive === true
        && !environment.reduceTransparency;
}

/** The DOM boundary publishes live material values without rerendering the shell. */
export function applyGlassDocumentPresentation(document: Document, settings: GlassMaterialSettings, environment: GlassMaterialEnvironment): () => void {
    const root = document.documentElement;
    const previous = new Map<string, string>();
    for (const [key, value] of Object.entries(resolveGlassPresentationVariables(settings, environment))) {
        previous.set(key, root.style.getPropertyValue(key));
        root.style.setProperty(key, value);
    }
    const backdropBefore = root.dataset.happyBackdropBlur;
    root.dataset.happyBackdropBlur = resolveGlassSurfaceMaterial(settings, 'floating', environment).material.blur === 'off' ? 'off' : 'on';
    const nativeBefore = root.dataset.happyNativeGlass;
    root.dataset.happyNativeGlass = environment.nativeWindowMaterialLive ? 'on' : 'off';
    return () => {
        for (const [key, value] of previous) {
            if (value) root.style.setProperty(key, value); else root.style.removeProperty(key);
        }
        if (backdropBefore === undefined) delete root.dataset.happyBackdropBlur; else root.dataset.happyBackdropBlur = backdropBefore;
        if (nativeBefore === undefined) delete root.dataset.happyNativeGlass; else root.dataset.happyNativeGlass = nativeBefore;
    };
}
