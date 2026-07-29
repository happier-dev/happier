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

export type SimulatorPreviewControlBuildResult = SimulatorPreviewTapControlBuildResult;

type SimulatorPreviewGeometryInput = Readonly<{
    orientation: SimulatorOrientationV1;
    viewport: Readonly<{ width: number; height: number }>;
    content: SimulatorPreviewRectV1;
}>;

export type SimulatorPreviewControlAction =
    | (Readonly<{
        kind: 'tap';
        point: Readonly<{ x: number; y: number }>;
    }> & SimulatorPreviewGeometryInput)
    | (Readonly<{
        kind: 'long_press';
        point: Readonly<{ x: number; y: number }>;
        durationMs?: number;
    }> & SimulatorPreviewGeometryInput)
    | (Readonly<{
        kind: 'swipe' | 'drag';
        from: Readonly<{ x: number; y: number }>;
        to: Readonly<{ x: number; y: number }>;
        durationMs?: number;
    }> & SimulatorPreviewGeometryInput)
    | (Readonly<{
        kind: 'pinch';
        center: Readonly<{ x: number; y: number }>;
        startDistance: number;
        endDistance: number;
        angle?: number;
        durationMs?: number;
    }> & SimulatorPreviewGeometryInput)
    | (Readonly<{
        kind: 'rotate';
        center: Readonly<{ x: number; y: number }>;
        radius: number;
        startAngle: number;
        endAngle: number;
        durationMs?: number;
    }> & SimulatorPreviewGeometryInput)
    | Readonly<{ kind: 'keyboard_text'; text: string }>
    | Readonly<{ kind: 'keyboard_key'; key: string }>
    | Readonly<{ kind: 'hardware_button'; button: string }>
    | Readonly<{ kind: 'orientation'; orientation: SimulatorOrientationV1 }>
    | Readonly<{ kind: 'request_keyframe' }>
    | Readonly<{
        kind: 'set_quality';
        maxBitrateBps?: number;
        maxFramesPerSecond?: number;
        maxWidth?: number;
        maxHeight?: number;
    }>;

const INPUT_ACTION_KINDS = new Set<SimulatorPreviewControlAction['kind']>([
    'tap',
    'long_press',
    'swipe',
    'drag',
    'pinch',
    'rotate',
    'keyboard_text',
    'keyboard_key',
    'hardware_button',
    'orientation',
]);

export function simulatorPreviewControlActionRequiresLease(action: SimulatorPreviewControlAction): boolean {
    return INPUT_ACTION_KINDS.has(action.kind);
}

function validateLease(input: Readonly<{
    streamId: string;
    sourceId: string;
    viewerId: string;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    nowMs?: number;
}>): Readonly<
    | { ok: true; lease: MachineLiveStreamControlLeaseV1 }
    | { ok: false; reasonCode: Exclude<SimulatorPreviewTapControlBuildResult, { ok: true }>['reasonCode'] }
> {
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
    return { ok: true, lease };
}

function mapPreviewPoint(input: SimulatorPreviewGeometryInput & Readonly<{
    point: Readonly<{ x: number; y: number }>;
}>): ReturnType<typeof mapSimulatorPreviewPointToDeviceV1> {
    return mapSimulatorPreviewPointToDeviceV1({
        x: input.point.x,
        y: input.point.y,
        orientation: input.orientation,
        viewport: input.viewport,
        content: input.content,
    });
}

function parseControl(control: unknown): SimulatorPreviewControlBuildResult {
    const parsed = MachineLiveStreamControlSidebandV1Schema.safeParse(control);
    if (!parsed.success) return { ok: false, reasonCode: 'invalid_control' };
    return { ok: true, control: parsed.data };
}

export function buildSimulatorPreviewControl(input: Readonly<{
    streamId: string;
    sourceId: string;
    viewerId: string;
    eventId: string;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    action: SimulatorPreviewControlAction;
    nowMs?: number;
}>): SimulatorPreviewControlBuildResult {
    const leaseResult = simulatorPreviewControlActionRequiresLease(input.action)
        ? validateLease(input)
        : null;
    if (leaseResult && !leaseResult.ok) return leaseResult;
    const leaseId = leaseResult?.ok ? leaseResult.lease.leaseId : undefined;

    const base = {
        v: 1,
        streamId: input.streamId,
        sourceId: input.sourceId,
        eventId: input.eventId,
        ...(leaseId ? { leaseId } : {}),
    };

    switch (input.action.kind) {
        case 'tap': {
            const mapped = mapPreviewPoint({ ...input.action, point: input.action.point });
            if (!mapped.ok) return mapped;
            return parseControl({ ...base, kind: 'tap', x: mapped.x, y: mapped.y });
        }
        case 'long_press': {
            const mapped = mapPreviewPoint({ ...input.action, point: input.action.point });
            if (!mapped.ok) return mapped;
            return parseControl({
                ...base,
                kind: 'long_press',
                x: mapped.x,
                y: mapped.y,
                ...(typeof input.action.durationMs === 'number' ? { durationMs: input.action.durationMs } : {}),
            });
        }
        case 'swipe':
        case 'drag': {
            const from = mapPreviewPoint({ ...input.action, point: input.action.from });
            if (!from.ok) return from;
            const to = mapPreviewPoint({ ...input.action, point: input.action.to });
            if (!to.ok) return to;
            return parseControl({
                ...base,
                kind: input.action.kind,
                fromX: from.x,
                fromY: from.y,
                toX: to.x,
                toY: to.y,
                ...(typeof input.action.durationMs === 'number' ? { durationMs: input.action.durationMs } : {}),
            });
        }
        case 'pinch': {
            const center = mapPreviewPoint({ ...input.action, point: input.action.center });
            if (!center.ok) return center;
            return parseControl({
                ...base,
                kind: 'pinch',
                centerX: center.x,
                centerY: center.y,
                startDistance: input.action.startDistance,
                endDistance: input.action.endDistance,
                ...(typeof input.action.angle === 'number' ? { angle: input.action.angle } : {}),
                ...(typeof input.action.durationMs === 'number' ? { durationMs: input.action.durationMs } : {}),
            });
        }
        case 'rotate': {
            const center = mapPreviewPoint({ ...input.action, point: input.action.center });
            if (!center.ok) return center;
            return parseControl({
                ...base,
                kind: 'rotate',
                centerX: center.x,
                centerY: center.y,
                radius: input.action.radius,
                startAngle: input.action.startAngle,
                endAngle: input.action.endAngle,
                ...(typeof input.action.durationMs === 'number' ? { durationMs: input.action.durationMs } : {}),
            });
        }
        case 'keyboard_text':
            return parseControl({ ...base, kind: 'keyboard_text', text: input.action.text });
        case 'keyboard_key':
            return parseControl({ ...base, kind: 'keyboard_key', key: input.action.key });
        case 'hardware_button':
            return parseControl({ ...base, kind: 'hardware_button', button: input.action.button });
        case 'orientation':
            return parseControl({ ...base, kind: 'orientation', orientation: input.action.orientation });
        case 'request_keyframe':
            return parseControl({ ...base, kind: 'request_keyframe' });
        case 'set_quality':
            return parseControl({
                ...base,
                kind: 'set_quality',
                ...(typeof input.action.maxBitrateBps === 'number' ? { maxBitrateBps: input.action.maxBitrateBps } : {}),
                ...(typeof input.action.maxFramesPerSecond === 'number' ? { maxFramesPerSecond: input.action.maxFramesPerSecond } : {}),
                ...(typeof input.action.maxWidth === 'number' ? { maxWidth: input.action.maxWidth } : {}),
                ...(typeof input.action.maxHeight === 'number' ? { maxHeight: input.action.maxHeight } : {}),
            });
    }
}

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
    return buildSimulatorPreviewControl({
        streamId: input.streamId,
        sourceId: input.sourceId,
        viewerId: input.viewerId,
        eventId: input.eventId,
        activeLease: input.activeLease,
        nowMs: input.nowMs,
        action: {
            kind: 'tap',
            point: input.point,
            orientation: input.orientation,
            viewport: input.viewport,
            content: input.content,
        },
    });
}
