export function resolveMultiPaneDeviceType(input: Readonly<{
    platform: string;
    deviceType: 'phone' | 'tablet';
}>): 'phone' | 'tablet' {
    // Multi-pane layout keeps phone-sized web in its established overlay mode.
    // Plugin destination admission has a separate form-factor adapter below.
    if (input.platform === 'web') return 'tablet';
    return input.deviceType;
}

/**
 * Plugin destination admission uses the responsive host observation directly.
 * Layout may choose a web-specific overlay mode without turning a phone-sized
 * web host into a tablet for the protocol registry.
 */
export function resolvePluginUiRuntimeFormFactor(input: Readonly<{
    deviceType: 'phone' | 'tablet';
}>): 'phone' | 'tablet' {
    return input.deviceType;
}
