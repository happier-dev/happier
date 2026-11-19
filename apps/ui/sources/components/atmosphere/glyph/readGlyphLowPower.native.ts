let reading: Promise<boolean> | undefined;

/** All native glyph surfaces share one platform power-state read. */
export function readGlyphLowPower(): Promise<boolean> {
    return reading ??= import('react-native-device-info')
        .then(device => device.getPowerState())
        .then(state => state.lowPowerMode === true, () => false);
}
