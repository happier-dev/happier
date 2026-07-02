import {
    MachineLiveStreamControlSidebandV1Schema,
    mapSimulatorPreviewPointToDeviceV1,
    type MachineLiveStreamControlLeaseV1,
    type MachineLiveStreamControlSidebandV1,
    type SimulatorOrientationV1,
    type SimulatorPreviewRectV1,
} from '@happier-dev/protocol';

export type SimulatorPreviewTapControlBuildResult = Readonly<
    | { ok: true; control: MachineLiveStreamControlSidebandV1 }
    | {
        ok: false;
        reasonCode:
            | 'input_lease_required'
            | 'input_lease_mismatch'
            | 'input_lease_holder_mismatch'
            | 'input_lease_expired'
            | 'invalid_geometry'
            | 'outside_device_frame'
            | 'invalid_point'
            | 'invalid_control';
    }
>;

export function buildSimulatorPreviewTapControl(input: Readonly<{
    streamId: string;
    sourceId: string;
    viewerId: string;
    eventId: string;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    point: Readonly<{ x: number; y: number }>;
    orientation: SimulatorOrientationV1;
    viewport: Readonly<{ width: number; height: number }>;
    content: SimulatorPreviewRectV1;
    nowMs?: number;
}>): SimulatorPreviewTapControlBuildResult {
    const lease = input.activeLease;
    if (!lease) return { ok: false, reasonCode: 'input_lease_required' };
    if (typeof input.nowMs === 'number' && lease.expiresAtMs <= input.nowMs) {
        return { ok: false, reasonCode: 'input_lease_expired' };
    }
    if (lease.streamId !== input.streamId || lease.sourceId !== input.sourceId) {
        return { ok: false, reasonCode: 'input_lease_mismatch' };
    }
    if (lease.holderId !== input.viewerId) {
        return { ok: false, reasonCode: 'input_lease_holder_mismatch' };
    }

    const mapped = mapSimulatorPreviewPointToDeviceV1({
        x: input.point.x,
        y: input.point.y,
        orientation: input.orientation,
        viewport: input.viewport,
        content: input.content,
    });
    if (!mapped.ok) return mapped;

    const control = MachineLiveStreamControlSidebandV1Schema.safeParse({
        v: 1,
        streamId: input.streamId,
        sourceId: input.sourceId,
        eventId: input.eventId,
        leaseId: lease.leaseId,
        kind: 'tap',
        x: mapped.x,
        y: mapped.y,
    });
    if (!control.success) return { ok: false, reasonCode: 'invalid_control' };
    return { ok: true, control: control.data };
}
