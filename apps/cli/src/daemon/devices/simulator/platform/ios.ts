export type IosSimulatorPlatformAdapter = Readonly<{
    platform: 'ios';
    usesPrivateFrameworks: true;
    capture: (input: Readonly<{ simulatorId: string }>) => Promise<
        Readonly<
            | { ok: true }
            | {
                ok: false;
                reasonCode: 'ios_private_helper_unavailable';
                requiredOwner: 'signed_ios_simulator_private_framework_helper';
                privateFrameworks: readonly ['CoreSimulator', 'SimulatorKit'];
            }
        >
    >;
}>;

export function createIosSimulatorPlatformAdapter(input: Readonly<{
    helperAvailable: boolean;
}>): IosSimulatorPlatformAdapter {
    return {
        platform: 'ios',
        usesPrivateFrameworks: true,
        capture: async () => input.helperAvailable
            ? { ok: true }
            : {
                ok: false,
                reasonCode: 'ios_private_helper_unavailable',
                requiredOwner: 'signed_ios_simulator_private_framework_helper',
                privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
            },
    };
}
