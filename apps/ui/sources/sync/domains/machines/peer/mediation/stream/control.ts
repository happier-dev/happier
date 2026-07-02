import {
    validateMachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlSidebandV1,
    type MachineLiveStreamControlSourceV1,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';

export function canSendMachineLiveStreamControl(input: Readonly<{
    source: MachineLiveStreamControlSourceV1;
    control: MachineLiveStreamControlSidebandV1;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    nowMs: number;
}>): ReturnType<typeof validateMachineLiveStreamControlLeaseV1> {
    return validateMachineLiveStreamControlLeaseV1(input);
}

export function createMachineLiveStreamSidebandControlEnvelope(input: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    control: MachineLiveStreamControlSidebandV1;
}>): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        message: {
            kind: 'sideband_control',
            control: input.control,
        },
    };
}
