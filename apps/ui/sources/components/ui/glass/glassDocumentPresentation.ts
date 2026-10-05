import { GLASS_BLUR_INTENSITY, GLASS_SURFACE_GROUPS, resolveGlassSurfaceMaterial, type GlassMaterialEnvironment, type GlassMaterialSettings } from './glassMaterial';

/** The document and static preview scopes share the same effective material projection. */
export function resolveGlassPresentationVariables(settings: GlassMaterialSettings, environment: GlassMaterialEnvironment): Record<string, string> {
    return Object.fromEntries(GLASS_SURFACE_GROUPS.flatMap(group => {
        const { material } = resolveGlassSurfaceMaterial(settings, group, environment);
        return [
            [`--happier-glass-${group}-opacity`, `${material.opacity * 100}%`],
            [`--happier-glass-${group}-nested-opacity`, material.opacity < 1 ? '0%' : '100%'],
            [`--happier-glass-${group}-blur`, `${Math.round(GLASS_BLUR_INTENSITY[material.blur] / 5)}px`],
        ];
    }));
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
    const clearedCanvas: Array<Readonly<{ node: HTMLElement; background: string; priority: string }>> = [];
    if (environment.desktopWindow && environment.nativeWindowMaterialLive && !environment.reduceTransparency && environment.windowActive !== false) {
        for (const node of [root, document.body, document.getElementById('root')]) {
            if (!node) continue;
            clearedCanvas.push({ node, background: node.style.getPropertyValue('background-color'), priority: node.style.getPropertyPriority('background-color') });
            node.style.setProperty('background-color', 'transparent');
        }
    }
    return () => {
        for (const { node, background, priority } of clearedCanvas) {
            if (background) node.style.setProperty('background-color', background, priority); else node.style.removeProperty('background-color');
        }
        for (const [key, value] of previous) {
            if (value) root.style.setProperty(key, value); else root.style.removeProperty(key);
        }
        if (backdropBefore === undefined) delete root.dataset.happyBackdropBlur; else root.dataset.happyBackdropBlur = backdropBefore;
        if (nativeBefore === undefined) delete root.dataset.happyNativeGlass; else root.dataset.happyNativeGlass = nativeBefore;
    };
}
