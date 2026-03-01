export function resolveMultiPaneDeviceType(input: Readonly<{
    platform: string;
    deviceType: 'phone' | 'tablet';
}>): 'phone' | 'tablet' {
    // On web, window sizing shouldn't force us into "phone" mode, because we
    // still want multi-pane overlays (right/details) on narrow desktop/tablet
    // viewports. This keeps the feature accessible while still allowing the
    // layout engine to choose overlay vs docked.
    if (input.platform === 'web') return 'tablet';
    return input.deviceType;
}
