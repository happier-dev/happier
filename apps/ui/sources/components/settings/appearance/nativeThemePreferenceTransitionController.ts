export type NativeThemePreferenceTransitionControllerDependencies<Surface> = {
    animateOverlay: () => Promise<void> | void;
    captureSurface: () => Promise<Surface | null> | Surface | null;
    hideOverlay: () => void;
    releaseSurface?: (surface: Surface) => void;
    showOverlay: (surface: Surface, direction?: 'sunrise' | 'night') => void;
    waitForFrame: () => Promise<void> | void;
    recordBreadcrumb?: (breadcrumb: NativeThemePreferenceTransitionBreadcrumb) => void;
};

export type NativeThemePreferenceTransitionBreadcrumb = Readonly<{
    phase: 'mutation-before-overlay' | 'overlay-shown';
}>;

export function createNativeThemePreferenceTransitionController<Surface>(
    dependencies: NativeThemePreferenceTransitionControllerDependencies<Surface>,
) {
    return {
        async run(mutation: () => void, direction?: 'sunrise' | 'night'): Promise<void> {
            const surface = await dependencies.captureSurface();
            if (surface === null) {
                mutation();
                return;
            }
            try {
                dependencies.recordBreadcrumb?.({ phase: 'mutation-before-overlay' });
                mutation();
                dependencies.recordBreadcrumb?.({ phase: 'overlay-shown' });
                dependencies.showOverlay(surface, direction);
                await dependencies.waitForFrame();
                await dependencies.animateOverlay();
            } finally {
                dependencies.hideOverlay();
                dependencies.releaseSurface?.(surface);
            }
        },
    };
}
