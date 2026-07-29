import type {
    MachineLiveStreamControlSidebandV1,
    MachineLiveStreamInputControlKindV1,
} from '@happier-dev/protocol';
import { MachineLiveStreamControlSidebandV1Schema } from '@happier-dev/protocol';

import { parseAndroidSerialFromSimulatorSourceId } from './source';

type AndroidScrcpyControlAckStatus = 'accepted' | 'rejected' | 'unavailable';

export const ANDROID_SCRCPY_CONTROL_INPUT_KINDS = [
    'pinch',
    'rotate',
] as const satisfies readonly MachineLiveStreamInputControlKindV1[];
export const ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON = 'android_scrcpy_orientation_absolute_unsupported';

const SCRCPY_CONTROL_INPUT_KINDS = new Set<MachineLiveStreamControlSidebandV1['kind']>(
    ANDROID_SCRCPY_CONTROL_INPUT_KINDS,
);

export type AndroidScrcpyControlCommand = Readonly<{
    v: 1;
    kind: 'control';
    commandId: string;
    target: Readonly<{
        sourceId: string;
        serial: string;
    }>;
    control: MachineLiveStreamControlSidebandV1;
}>;

export type AndroidScrcpyControlAckMessage = Readonly<{
    v: 1;
    kind: 'control_ack';
    commandId: string;
    status: AndroidScrcpyControlAckStatus;
    reasonCode?: string;
    diagnostics: readonly Record<string, unknown>[];
}>;

export type AndroidScrcpyControlCommandSendResult = Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type AndroidScrcpyControlCommandWriter = (
    command: AndroidScrcpyControlCommand,
) => Promise<Readonly<
    | { ok: true; message?: AndroidScrcpyControlAckMessage; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>> | Readonly<
    | { ok: true; message?: AndroidScrcpyControlAckMessage; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type AndroidScrcpyControlScreenSize = Readonly<{
    widthPx: number;
    heightPx: number;
}>;

export type AndroidScrcpyControlPacketWriteResult = Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type AndroidScrcpyControlPacketWriter = (
    packet: Uint8Array,
    metadata: Readonly<{ commandId: string; index: number; total: number }>,
) => Promise<AndroidScrcpyControlPacketWriteResult | void> | AndroidScrcpyControlPacketWriteResult | void;

export type AndroidScrcpyControlSender = (
    control: MachineLiveStreamControlSidebandV1,
) => Promise<AndroidScrcpyControlCommandSendResult> | AndroidScrcpyControlCommandSendResult;

export type SerializeAndroidScrcpyControlCommandInput = Readonly<{
    control: MachineLiveStreamControlSidebandV1;
    supportedInputKinds?: readonly MachineLiveStreamInputControlKindV1[];
}>;

export type SerializeAndroidScrcpyControlCommandResult = Readonly<
    | { ok: true; command: AndroidScrcpyControlCommand }
    | { ok: false; status: 'rejected' | 'unavailable'; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>;

export type EncodeAndroidScrcpyControlCommandPacketsInput = Readonly<{
    command: AndroidScrcpyControlCommand;
    screenSize: AndroidScrcpyControlScreenSize;
}>;

export type EncodeAndroidScrcpyControlCommandPacketsResult = Readonly<
    | { ok: true; packets: readonly Uint8Array[] }
    | { ok: false; status: 'rejected' | 'unavailable'; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>;

const SCRCPY_CONTROL_MESSAGE_TYPE_INJECT_TOUCH_EVENT = 2;
const SCRCPY_MOTION_EVENT_ACTION_DOWN = 0;
const SCRCPY_MOTION_EVENT_ACTION_UP = 1;
const SCRCPY_MOTION_EVENT_ACTION_MOVE = 2;
const SCRCPY_POINTER_ID_GENERIC_FINGER = -2n;
const SCRCPY_POINTER_ID_VIRTUAL_FINGER = -3n;

type NormalizedPoint = Readonly<{
    x: number;
    y: number;
}>;

function commandIdForControl(control: MachineLiveStreamControlSidebandV1): string {
    return `cmd-${control.eventId}`;
}

export function androidScrcpyAbsoluteOrientationUnsupportedDiagnostics(): readonly Record<string, unknown>[] {
    return [{
        code: ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON,
        detail: 'stock_scrcpy_rotate_device_is_relative_not_absolute',
    }];
}

function absoluteOrientationUnsupportedResult(): Readonly<{
    ok: false;
    status: 'unavailable';
    reasonCode: typeof ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON;
    diagnostics: readonly Record<string, unknown>[];
}> {
    return {
        ok: false,
        status: 'unavailable',
        reasonCode: ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON,
        diagnostics: androidScrcpyAbsoluteOrientationUnsupportedDiagnostics(),
    };
}

export function isAndroidScrcpyControlOnlyKind(kind: MachineLiveStreamControlSidebandV1['kind']): boolean {
    return SCRCPY_CONTROL_INPUT_KINDS.has(kind);
}

export function serializeAndroidScrcpyControlCommand(
    input: SerializeAndroidScrcpyControlCommandInput,
): SerializeAndroidScrcpyControlCommandResult {
    const parsedControl = MachineLiveStreamControlSidebandV1Schema.safeParse(input.control);
    if (!parsedControl.success) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
            diagnostics: [{ code: 'android_simulator_control_not_scrcpy_control', kind: input.control.kind }],
        };
    }

    if (parsedControl.data.kind === 'orientation') {
        return absoluteOrientationUnsupportedResult();
    }

    if (!SCRCPY_CONTROL_INPUT_KINDS.has(parsedControl.data.kind)) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
            diagnostics: [{ code: 'android_simulator_control_not_scrcpy_control', kind: parsedControl.data.kind }],
        };
    }

    const supportedInputKinds = input.supportedInputKinds ? new Set(input.supportedInputKinds) : null;
    if (supportedInputKinds && !supportedInputKinds.has(input.control.kind as MachineLiveStreamInputControlKindV1)) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
            diagnostics: [{ code: 'android_simulator_control_not_advertised', kind: input.control.kind }],
        };
    }

    const serial = parseAndroidSerialFromSimulatorSourceId(input.control.sourceId);
    if (!serial) {
        return {
            ok: false,
            status: 'rejected',
            reasonCode: 'invalid_android_simulator_source',
            diagnostics: [{ code: 'invalid_android_simulator_source' }],
        };
    }

    return {
        ok: true,
        command: {
            v: 1,
            kind: 'control',
            commandId: commandIdForControl(input.control),
            target: {
                sourceId: input.control.sourceId,
                serial,
            },
            control: parsedControl.data,
        },
    };
}

function validScreenSize(value: AndroidScrcpyControlScreenSize): boolean {
    return Number.isInteger(value.widthPx)
        && Number.isInteger(value.heightPx)
        && value.widthPx > 0
        && value.heightPx > 0
        && value.widthPx <= 0xffff
        && value.heightPx <= 0xffff;
}

function roundedScreenCoordinate(value: number, maxPixels: number): number {
    const maxIndex = Math.max(0, maxPixels - 1);
    return Math.round(value * maxIndex);
}

function pointInDeviceFrame(point: NormalizedPoint): boolean {
    return Number.isFinite(point.x)
        && Number.isFinite(point.y)
        && point.x >= 0
        && point.x <= 1
        && point.y >= 0
        && point.y <= 1;
}

function fixedPointU16(value: number): number {
    if (value >= 1) return 0xffff;
    if (value <= 0) return 0;
    return Math.max(0, Math.min(0xfffe, Math.floor(value * 0x10000)));
}

function writeScrcpyTouchPacket(input: Readonly<{
    action: number;
    pointerId: bigint;
    point: NormalizedPoint;
    pressure: number;
    screenSize: AndroidScrcpyControlScreenSize;
}>): Uint8Array {
    const packet = new Uint8Array(32);
    const view = new DataView(packet.buffer);
    view.setUint8(0, SCRCPY_CONTROL_MESSAGE_TYPE_INJECT_TOUCH_EVENT);
    view.setUint8(1, input.action);
    view.setBigInt64(2, input.pointerId, false);
    view.setInt32(10, roundedScreenCoordinate(input.point.x, input.screenSize.widthPx), false);
    view.setInt32(14, roundedScreenCoordinate(input.point.y, input.screenSize.heightPx), false);
    view.setUint16(18, input.screenSize.widthPx, false);
    view.setUint16(20, input.screenSize.heightPx, false);
    view.setUint16(22, fixedPointU16(input.pressure), false);
    view.setInt32(24, 0, false);
    view.setInt32(28, 0, false);
    return packet;
}

function twoFingerPoints(input: Readonly<{
    centerX: number;
    centerY: number;
    distance: number;
    angleDegrees: number;
}>): readonly [NormalizedPoint, NormalizedPoint] {
    const radians = input.angleDegrees * Math.PI / 180;
    const dx = Math.cos(radians) * input.distance / 2;
    const dy = Math.sin(radians) * input.distance / 2;
    return [
        { x: input.centerX - dx, y: input.centerY - dy },
        { x: input.centerX + dx, y: input.centerY + dy },
    ];
}

function encodeTwoFingerGesture(input: Readonly<{
    screenSize: AndroidScrcpyControlScreenSize;
    start: readonly [NormalizedPoint, NormalizedPoint];
    end: readonly [NormalizedPoint, NormalizedPoint];
}>): EncodeAndroidScrcpyControlCommandPacketsResult {
    const allPoints = [...input.start, ...input.end];
    if (!allPoints.every(pointInDeviceFrame)) {
        return {
            ok: false,
            status: 'rejected',
            reasonCode: 'android_scrcpy_control_point_outside_device_frame',
            diagnostics: [{ code: 'android_scrcpy_control_point_outside_device_frame' }],
        };
    }

    return {
        ok: true,
        packets: [
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_DOWN,
                pointerId: SCRCPY_POINTER_ID_GENERIC_FINGER,
                point: input.start[0],
                pressure: 1,
                screenSize: input.screenSize,
            }),
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_DOWN,
                pointerId: SCRCPY_POINTER_ID_VIRTUAL_FINGER,
                point: input.start[1],
                pressure: 1,
                screenSize: input.screenSize,
            }),
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_MOVE,
                pointerId: SCRCPY_POINTER_ID_GENERIC_FINGER,
                point: input.end[0],
                pressure: 1,
                screenSize: input.screenSize,
            }),
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_MOVE,
                pointerId: SCRCPY_POINTER_ID_VIRTUAL_FINGER,
                point: input.end[1],
                pressure: 1,
                screenSize: input.screenSize,
            }),
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_UP,
                pointerId: SCRCPY_POINTER_ID_VIRTUAL_FINGER,
                point: input.end[1],
                pressure: 0,
                screenSize: input.screenSize,
            }),
            writeScrcpyTouchPacket({
                action: SCRCPY_MOTION_EVENT_ACTION_UP,
                pointerId: SCRCPY_POINTER_ID_GENERIC_FINGER,
                point: input.end[0],
                pressure: 0,
                screenSize: input.screenSize,
            }),
        ],
    };
}

export function encodeAndroidScrcpyControlCommandPackets(
    input: EncodeAndroidScrcpyControlCommandPacketsInput,
): EncodeAndroidScrcpyControlCommandPacketsResult {
    if (!validScreenSize(input.screenSize)) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_scrcpy_screen_size_unavailable',
            diagnostics: [{ code: 'android_scrcpy_screen_size_unavailable' }],
        };
    }

    const { control } = input.command;
    switch (control.kind) {
        case 'pinch': {
            const angleDegrees = control.angle ?? 0;
            return encodeTwoFingerGesture({
                screenSize: input.screenSize,
                start: twoFingerPoints({
                    centerX: control.centerX,
                    centerY: control.centerY,
                    distance: control.startDistance,
                    angleDegrees,
                }),
                end: twoFingerPoints({
                    centerX: control.centerX,
                    centerY: control.centerY,
                    distance: control.endDistance,
                    angleDegrees,
                }),
            });
        }
        case 'rotate': {
            return encodeTwoFingerGesture({
                screenSize: input.screenSize,
                start: twoFingerPoints({
                    centerX: control.centerX,
                    centerY: control.centerY,
                    distance: control.radius * 2,
                    angleDegrees: control.startAngle,
                }),
                end: twoFingerPoints({
                    centerX: control.centerX,
                    centerY: control.centerY,
                    distance: control.radius * 2,
                    angleDegrees: control.endAngle,
                }),
            });
        }
        case 'orientation':
            return absoluteOrientationUnsupportedResult();
        default:
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: 'android_simulator_control_unsupported',
                diagnostics: [{ code: 'android_scrcpy_control_not_binary_supported', kind: control.kind }],
            };
    }
}

export function createAndroidScrcpyBinaryControlCommandWriter(input: Readonly<{
    screenSize: AndroidScrcpyControlScreenSize;
    writePacket: AndroidScrcpyControlPacketWriter;
}>): AndroidScrcpyControlCommandWriter {
    return async (command) => {
        const encoded = encodeAndroidScrcpyControlCommandPackets({
            command,
            screenSize: input.screenSize,
        });
        if (!encoded.ok) return encoded;

        for (let index = 0; index < encoded.packets.length; index += 1) {
            const packet = encoded.packets[index];
            if (!packet) continue;
            try {
                const result = await input.writePacket(packet, {
                    commandId: command.commandId,
                    index,
                    total: encoded.packets.length,
                });
                if (result && !result.ok) return result;
            } catch (error) {
                return {
                    ok: false,
                    status: 'unavailable',
                    reasonCode: 'scrcpy_control_socket_write_failed',
                    diagnostics: [{
                        code: 'scrcpy_control_socket_write_failed',
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                    }],
                };
            }
        }

        return {
            ok: true,
            diagnostics: [{ code: 'scrcpy_control_packets_written', packetCount: encoded.packets.length }],
        };
    };
}

export function createAndroidScrcpyControlSender(input: Readonly<{
    supportedInputKinds?: readonly MachineLiveStreamInputControlKindV1[];
    writeCommand: AndroidScrcpyControlCommandWriter;
}>): AndroidScrcpyControlSender {
    return async (control) => {
        const serialized = serializeAndroidScrcpyControlCommand({
            control,
            ...(input.supportedInputKinds ? { supportedInputKinds: input.supportedInputKinds } : {}),
        });
        if (!serialized.ok) {
            return {
                ok: false,
                status: serialized.status,
                reasonCode: serialized.reasonCode,
                diagnostics: serialized.diagnostics,
            };
        }

        const result = await input.writeCommand(serialized.command);
        if (!result.ok) return result;
        const ack = result.message;
        if (!ack) return { ok: true, diagnostics: result.diagnostics ?? [] };
        if (ack.commandId !== serialized.command.commandId) {
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: 'scrcpy_control_ack_unknown_command',
                diagnostics: [{ code: 'scrcpy_control_ack_unknown_command' }],
            };
        }
        if (ack.status === 'accepted') return { ok: true, diagnostics: ack.diagnostics };
        return {
            ok: false,
            status: ack.status,
            reasonCode: ack.reasonCode ?? 'android_simulator_control_failed',
            diagnostics: ack.diagnostics,
        };
    };
}
