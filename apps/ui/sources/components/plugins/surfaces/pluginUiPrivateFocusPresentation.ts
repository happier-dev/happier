import type { FindSurfaceRegistrationHost } from '@happier-dev/plugin-ui/advanced';

/** The mount's current layout fact owns focus, including old handles retained by plugin code. */
export function createPluginUiPrivateFocusPresentation(options: Readonly<{
    isFocusEligible?: () => boolean;
    focusTarget(target: unknown): boolean;
    find?: FindSurfaceRegistrationHost;
}>): Readonly<{ focusTarget(target: unknown): boolean; find?: FindSurfaceRegistrationHost }> | undefined {
    if (!options.isFocusEligible) return undefined;
    const find = options.find;
    return {
        focusTarget: target => options.isFocusEligible?.() === true && options.focusTarget(target),
        ...(find ? { find: {
            register(surface) {
                return find.register({
                    surfaceId: surface.surfaceId,
                    get controller() { return surface.controller; },
                    get engineOwnsFind() { return surface.engineOwnsFind; },
                    isAvailable: () => options.isFocusEligible?.() === true && surface.isAvailable?.() !== false,
                    containsFocus: () => options.isFocusEligible?.() === true && surface.containsFocus(),
                    open: () => surface.open(), isOpen: () => surface.isOpen(), isInputFocused: () => surface.isInputFocused(),
                });
            },
            refresh: () => find.refresh(),
        } satisfies FindSurfaceRegistrationHost } : {}),
    };
}
