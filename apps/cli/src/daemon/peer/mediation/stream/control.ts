import { validateMachineLiveStreamControlLeaseV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type { MachineLiveStreamControlLeaseV1, MachineLiveStreamControlSidebandV1, MachineLiveStreamControlSourceV1, MachineLiveStreamCaptureSourceKindV1 } from '@happier-dev/protocol';

export type MachineLiveStreamControlDispatchResult = Readonly<
    | { ok: true }
    | { ok: false; reasonCode: string }
>;

export async function dispatchMachineLiveStreamControl(input: Readonly<{
    source: MachineLiveStreamControlSourceV1;
    sourceKind?: MachineLiveStreamCaptureSourceKindV1;
    control: MachineLiveStreamControlSidebandV1;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    nowMs: number;
    handleControl: (control: MachineLiveStreamControlSidebandV1) => Promise<MachineLiveStreamControlDispatchResult>;
}>): Promise<MachineLiveStreamControlDispatchResult> {
    const leaseValidation = validateMachineLiveStreamControlLeaseV1({
        source: input.source,
        sourceKind: input.sourceKind,
        control: input.control,
        activeLease: input.activeLease,
        nowMs: input.nowMs,
    });
    if (!leaseValidation.ok) return leaseValidation;
    return await input.handleControl(input.control);
}
