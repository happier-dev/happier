import {
    SimulatorDeviceOperationKindV1Schema,
    type SimulatorDeviceHardwareButtonV1,
    type SimulatorDeviceOperationKindV1,
} from '@happier-dev/protocol/devices/simulator/operationsV1';

const backing = {
    accessibility_snapshot: { ios: true, android: false },
    accessibility_press: { ios: true, android: false },
    boot: { ios: true, android: true },
    power_off: { ios: true, android: true },
    app_launch: { ios: true, android: true },
    app_terminate: { ios: true, android: true },
    open_url: { ios: true, android: true },
    screenshot: { ios: true, android: true },
    appearance_set: { ios: true, android: true },
    text_size_set: { ios: true, android: true },
    location_set: { ios: true, android: true },
    location_clear: { ios: true, android: false },
    permission_set: { ios: true, android: true },
    push: { ios: true, android: false },
    hardware: { ios: false, android: true },
    rotate: { ios: false, android: true },
} satisfies Record<SimulatorDeviceOperationKindV1, Record<'ios' | 'android', boolean>>;

export function isSimulatorDeviceOperationBacked(platform: 'ios' | 'android', operation: SimulatorDeviceOperationKindV1): boolean {
    return backing[operation][platform];
}

export function getSimulatorDeviceOperationCapabilities(platform: 'ios' | 'android', state: 'running' | 'stopped' | 'unavailable',
    options: Readonly<{ accessibilityAvailable?: boolean }> = {}) {
    const supportedDeviceOperations = SimulatorDeviceOperationKindV1Schema.options.filter((operation) => (
        state === 'stopped' ? operation === 'boot' : state === 'running' && operation !== 'boot' && isSimulatorDeviceOperationBacked(platform, operation)
            && (operation !== 'accessibility_snapshot' && operation !== 'accessibility_press' || options.accessibilityAvailable === true)
    ));
    const supportedHardwareButtons: SimulatorDeviceHardwareButtonV1[] = state === 'running' && platform === 'android'
        ? ['home', 'back', 'recents'] : [];
    return { supportedDeviceOperations, supportedHardwareButtons };
}
