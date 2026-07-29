import type {
    MachineLiveStreamInputControlKindV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionV1,
} from '@happier-dev/protocol';

import {
    acceptedSimulatorInputResult,
    readSimulatorControlSendAction,
    rejectedSimulatorInputResult,
    unavailableSimulatorInputResult,
} from '../input';
import {
    serializeIosSimulatorHelperCommand,
    type IosSimulatorHelperControlCommand,
} from './helperProtocol';

export type IosSimulatorInputCommandSender = (
    command: IosSimulatorHelperControlCommand,
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
            requiredOwner: 'signed_ios_simulator_private_framework_helper',
            privateFrameworks: ['CoreSimulator', 'SimulatorKit'],
        }]);
    }

    const command = serializeIosSimulatorHelperCommand({
        control: action.control,
        ...(input.supportedInputKinds ? { supportedInputKinds: input.supportedInputKinds } : {}),
    });
    if (!command.ok) {
        return command.status === 'rejected'
            ? rejectedSimulatorInputResult(input.event, command.reasonCode, command.diagnostics ?? [])
            : unavailableSimulatorInputResult(input.event, command.reasonCode, command.diagnostics ?? []);
    }

    const result = await input.sendCommand(command.command);
    if (result.ok) return acceptedSimulatorInputResult(input.event, result.diagnostics ?? []);

    return result.status === 'rejected'
        ? rejectedSimulatorInputResult(input.event, result.reasonCode, result.diagnostics ?? [])
        : unavailableSimulatorInputResult(input.event, result.reasonCode, result.diagnostics ?? []);
}
