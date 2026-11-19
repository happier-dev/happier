// Vitest/node stub for `react-native-device-info`.

export function getDeviceType() {
    return 'Handset';
}

export async function getPowerState() {
    return { lowPowerMode: false };
}

export default { getDeviceType, getPowerState };

