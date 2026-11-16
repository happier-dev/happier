import type {
    MachineLiveStreamInputControlKindV1,
    MachineLiveStreamControlSidebandV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
} from '@happier-dev/protocol';

import {
    acceptedSimulatorInputResult,
    readSimulatorControlSendAction,
    rejectedSimulatorInputResult,
    unavailableSimulatorInputResult,
} from '../input';

export type IosSimulatorInputCommandSender = (
    command: MachineLiveStreamControlSidebandV1,
) => Promise<Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>> | Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type DispatchIosSimulatorInputInput = Readonly<{
    event: SimulatorPreviewActionV1;
    sendCommand?: IosSimulatorInputCommandSender | null;
    supportedInputKinds?: readonly MachineLiveStreamInputControlKindV1[];
}>;

export async function dispatchIosSimulatorInput(
    input: DispatchIosSimulatorInputInput,
): Promise<SimulatorPreviewActionResultV1> {
    const action = readSimulatorControlSendAction(input.event);
    if (!action) {
        return unavailableSimulatorInputResult(input.event, 'ios_simulator_control_unsupported', [{
            code: 'ios_simulator_action_not_input',
        }]);
    }

    if (!input.sendCommand) {
        return unavailableSimulatorInputResult(input.event, 'ios_simulator_input_sender_unavailable', [{
            code: 'ios_simulator_input_sender_unavailable',
            requiredOwner: 'bundled_ios_simulator_native_producer',
            privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        }]);
    }

    if (input.supportedInputKinds && !input.supportedInputKinds.some((kind) => kind === action.control.kind)) {
        return unavailableSimulatorInputResult(input.event, 'ios_simulator_control_unsupported');
    }

    const result = await input.sendCommand(action.control);
    if (result.ok) return acceptedSimulatorInputResult(input.event, result.diagnostics ?? []);

    return result.status === 'rejected'
        ? rejectedSimulatorInputResult(input.event, result.reasonCode, result.diagnostics ?? [])
        : unavailableSimulatorInputResult(input.event, result.reasonCode, result.diagnostics ?? []);
}
