export type NativeThemePreferenceTransitionControllerDependencies = {
    animateOverlay: () => Promise<void> | void;
    captureSurface: () => Promise<string | null> | string | null;
    hideOverlay: () => void;
    showOverlay: (uri: string) => void;
    waitForFrame: () => Promise<void> | void;
    recordBreadcrumb?: (breadcrumb: NativeThemePreferenceTransitionBreadcrumb) => void;
};

export type NativeThemePreferenceTransitionBreadcrumb = Readonly<{
    phase: 'mutation-before-overlay' | 'overlay-shown';
}>;

export function createNativeThemePreferenceTransitionController(
    dependencies: NativeThemePreferenceTransitionControllerDependencies,
) {
    return {
        async run(mutation: () => void): Promise<void> {
            const uri = await dependencies.captureSurface();
            if (!uri) {
                mutation();
                return;
            }
            dependencies.recordBreadcrumb?.({ phase: 'mutation-before-overlay' });
            mutation();
            dependencies.recordBreadcrumb?.({ phase: 'overlay-shown' });
            dependencies.showOverlay(uri);
            try {
                await dependencies.waitForFrame();
                await dependencies.animateOverlay();
            } finally {
                dependencies.hideOverlay();
            }
        },
    };
}
