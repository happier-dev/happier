import {
    validateMachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlSidebandV1,
    type MachineLiveStreamControlSourceV1,
} from '@happier-dev/protocol';

export type MachineLiveStreamControlDispatchResult = Readonly<
    | { ok: true }
    | { ok: false; reasonCode: string }
>;

export async function dispatchMachineLiveStreamControl(input: Readonly<{
    source: MachineLiveStreamControlSourceV1;
    control: MachineLiveStreamControlSidebandV1;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    nowMs: number;
    handleControl: (control: MachineLiveStreamControlSidebandV1) => Promise<MachineLiveStreamControlDispatchResult>;
}>): Promise<MachineLiveStreamControlDispatchResult> {
    const leaseValidation = validateMachineLiveStreamControlLeaseV1({
        source: input.source,
        control: input.control,
        activeLease: input.activeLease,
        nowMs: input.nowMs,
    });
    if (!leaseValidation.ok) return leaseValidation;
    return await input.handleControl(input.control);
}
