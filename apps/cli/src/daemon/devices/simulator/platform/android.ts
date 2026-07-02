export type AndroidSimulatorPlatformAdapter = Readonly<{
    platform: 'android';
    usesPrivateFrameworks: false;
    capture: (input: Readonly<{ simulatorId: string }>) => Promise<
        Readonly<
            | { ok: true }
            | {
                ok: false;
                reasonCode: 'android_emulator_bridge_unavailable';
                requiredOwner: 'android_emulator_capture_input_bridge';
            }
        >
    >;
}>;

export function createAndroidSimulatorPlatformAdapter(input: Readonly<{
    bridgeAvailable: boolean;
}>): AndroidSimulatorPlatformAdapter {
    return {
        platform: 'android',
        usesPrivateFrameworks: false,
        capture: async () => input.bridgeAvailable
            ? { ok: true }
            : {
                ok: false,
                reasonCode: 'android_emulator_bridge_unavailable',
                requiredOwner: 'android_emulator_capture_input_bridge',
            },
    };
}
