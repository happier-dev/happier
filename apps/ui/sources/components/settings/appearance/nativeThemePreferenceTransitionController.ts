export type NativeThemePreferenceTransitionControllerDependencies = {
    animateOverlay: () => Promise<void> | void;
    captureSurface: () => Promise<string | null> | string | null;
    hideOverlay: () => void;
    showOverlay: (uri: string) => void;
    waitForFrame: () => Promise<void> | void;
};

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
            dependencies.showOverlay(uri);
            mutation();
            await dependencies.waitForFrame();
            await dependencies.animateOverlay();
            dependencies.hideOverlay();
        },
    };
}
