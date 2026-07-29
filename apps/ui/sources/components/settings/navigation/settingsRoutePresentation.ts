export type SettingsRoutePresentation = 'containedModal' | 'modal' | undefined;

/**
 * Resolves how the settings route group is presented based on form factor.
 *
 * Settings is reached two different ways depending on size:
 * - On phones the settings tab lives in the bottom tab bar, and the nav sidebar is
 *   hidden (window min-edge < 600px → `deviceType === 'phone'`). The route stays a
 *   plain full-screen screen so it behaves like the other main tabs.
 * - On tablet/desktop there is no bottom tab bar; settings is presented as a centered
 *   modal hosting the nav rail on the left and the section content on the right,
 *   mirroring the `/new` route (see `resolveNewSessionRoutePresentation`).
 *
 * The `deviceType` input is the same signal the bottom tab bar uses
 * (`useDeviceType`), so the modal-vs-screen decision and the tab bar visibility can
 * never disagree.
 */
export function resolveSettingsRoutePresentation(params: Readonly<{
    deviceType: 'phone' | 'tablet';
    platformOs: string;
}>): SettingsRoutePresentation {
    if (params.deviceType === 'phone') return undefined;
    return params.platformOs === 'ios' ? 'containedModal' : 'modal';
}

export type SettingsRouteAnimation = 'none' | undefined;

/**
 * Resolves the stack animation for the settings route, paired with
 * {@link resolveSettingsRoutePresentation}.
 *
 * - Phone: settings is a bottom-tab destination, so it switches instantly with no slide
 *   (matching the other main tabs). Returning `'none'` suppresses the transition.
 * - Tablet/desktop: settings is a modal, so it should animate in. Returning `undefined`
 *   inherits the platform's default modal animation rather than appearing abruptly.
 *
 * Keep this gated on the same `deviceType` as the presentation so the animation is only
 * active in modal mode and never on the full-screen phone tab.
 */
export function resolveSettingsRouteAnimation(params: Readonly<{
    deviceType: 'phone' | 'tablet';
}>): SettingsRouteAnimation {
    return params.deviceType === 'phone' ? 'none' : undefined;
}
