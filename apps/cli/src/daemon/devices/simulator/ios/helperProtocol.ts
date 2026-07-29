import type {
    MachineLiveStreamCodecIdV1,
    MachineLiveStreamControlSidebandV1,
    MachineLiveStreamInputControlKindV1,
    MachineLiveStreamPayloadKindV1,
} from '@happier-dev/protocol';
import {
    getMachineLiveStreamPayloadDecodedByteLength,
    MachineLiveStreamControlSidebandV1Schema,
} from '@happier-dev/protocol';

type HelperSeverity = 'info' | 'warning' | 'error';
type HelperControlAckStatus = 'accepted' | 'rejected' | 'unavailable';
type HelperStatus = 'ready' | 'available' | 'unavailable';

const SUPPORTED_CODECS = new Set<MachineLiveStreamCodecIdV1>(['image.frame.v1', 'image.mjpeg', 'h264.avcc']);
const SUPPORTED_PAYLOAD_KINDS = new Set<MachineLiveStreamPayloadKindV1>(['image_delta', 'image_keyframe', 'metadata']);
const INPUT_CONTROL_KINDS = new Set<MachineLiveStreamControlSidebandV1['kind']>([
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

export type IosSimulatorHelperControlCommand = Readonly<{
    v: 1;
    kind: 'control';
    commandId: string;
    target: Readonly<{
        sourceId: string;
        simulatorId: string;
    }>;
    control: MachineLiveStreamControlSidebandV1;
}>;

export type IosSimulatorHelperStatusMessage = Readonly<{
    v: 1;
    kind: 'status';
    status: HelperStatus;
    helperVersion?: string;
    supportedCodecs: readonly MachineLiveStreamCodecIdV1[];
    supportedInputKinds: readonly MachineLiveStreamInputControlKindV1[];
    diagnostics: readonly Record<string, unknown>[];
}>;

export type IosSimulatorHelperDiagnosticMessage = Readonly<{
    v: 1;
    kind: 'diagnostic';
    severity: HelperSeverity;
    code: string;
    message?: string;
    details?: Record<string, unknown>;
}>;

export type IosSimulatorHelperFrameMessage = Readonly<{
    v: 1;
    kind: 'frame';
    streamId: string;
    sourceId: string;
    sequence: number;
    timestampMs: number;
    codecId: MachineLiveStreamCodecIdV1;
    payloadKind: MachineLiveStreamPayloadKindV1;
    payloadEncoding: 'binary_base64';
    payloadBase64: string;
    payloadSizeBytes: number;
}>;

export type IosSimulatorHelperControlAckMessage = Readonly<{
    v: 1;
    kind: 'control_ack';
    commandId: string;
    status: HelperControlAckStatus;
    reasonCode?: string;
    diagnostics: readonly Record<string, unknown>[];
}>;

export type IosSimulatorHelperMessage =
    | IosSimulatorHelperStatusMessage
    | IosSimulatorHelperDiagnosticMessage
    | IosSimulatorHelperFrameMessage
    | IosSimulatorHelperControlAckMessage;

export type IosSimulatorHelperParseResult = Readonly<
    | { ok: true; message: IosSimulatorHelperMessage }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>;

export type IosSimulatorHelperCommandSendResult = Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type IosSimulatorHelperCommandWriter = (
    command: IosSimulatorHelperControlCommand,
) => Promise<Readonly<
    | { ok: true; message?: IosSimulatorHelperControlAckMessage; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>> | Readonly<
    | { ok: true; message?: IosSimulatorHelperControlAckMessage; diagnostics?: readonly Record<string, unknown>[] }
    | { ok: false; reasonCode: string; diagnostics?: readonly Record<string, unknown>[]; status?: 'rejected' | 'unavailable' }
>;

export type IosSimulatorHelperCommandSender = (
    control: MachineLiveStreamControlSidebandV1,
) => Promise<IosSimulatorHelperCommandSendResult> | IosSimulatorHelperCommandSendResult;

export type IosSimulatorHelperMessageParser = Readonly<{
    parse: (raw: unknown) => IosSimulatorHelperParseResult;
}>;

export type CreateIosSimulatorHelperMessageParserInput = Readonly<{
    maxPayloadBytes: number;
    knownCommandIds?: ReadonlySet<string>;
}>;

export type SerializeIosSimulatorHelperCommandInput = Readonly<{
    control: MachineLiveStreamControlSidebandV1;
    supportedInputKinds?: readonly MachineLiveStreamInputControlKindV1[];
}>;

export type SerializeIosSimulatorHelperCommandResult = Readonly<
    | { ok: true; command: IosSimulatorHelperControlCommand }
    | { ok: false; status: 'rejected' | 'unavailable'; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>;

function parseRecord(raw: unknown): Readonly<
    | { ok: true; value: Record<string, unknown> }
    | { ok: false; reasonCode: string }
> {
    let value: unknown = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return { ok: false, reasonCode: 'helper_message_malformed_json' };
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reasonCode: 'helper_message_malformed' };
    }
    return { ok: true, value: value as Record<string, unknown> };
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionalStringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | null {
    return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
    return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : null;
}

function diagnosticRecords(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is Record<string, unknown> => (
        !!entry && typeof entry === 'object' && !Array.isArray(entry)
    ));
}

function codecList(value: unknown): readonly MachineLiveStreamCodecIdV1[] {
    if (!Array.isArray(value)) return [];
    return value.filter((codec): codec is MachineLiveStreamCodecIdV1 => (
        typeof codec === 'string' && SUPPORTED_CODECS.has(codec as MachineLiveStreamCodecIdV1)
    ));
}

function inputKindList(value: unknown): readonly MachineLiveStreamInputControlKindV1[] {
    if (!Array.isArray(value)) return [];
    return value.filter((kind): kind is MachineLiveStreamInputControlKindV1 => (
        typeof kind === 'string' && INPUT_CONTROL_KINDS.has(kind as MachineLiveStreamControlSidebandV1['kind'])
    ));
}

function parseStatusMessage(record: Record<string, unknown>): IosSimulatorHelperParseResult {
    if (record.v !== 1) return { ok: false, reasonCode: 'helper_message_malformed' };
    const status = record.status;
    if (status !== 'ready' && status !== 'available' && status !== 'unavailable') {
        return { ok: false, reasonCode: 'helper_status_malformed' };
    }
    const message: IosSimulatorHelperStatusMessage = {
        v: 1,
        kind: 'status',
        status,
        ...(optionalStringValue(record.helperVersion) ? { helperVersion: optionalStringValue(record.helperVersion) } : {}),
        supportedCodecs: codecList(record.supportedCodecs),
        supportedInputKinds: inputKindList(record.supportedInputKinds),
        diagnostics: diagnosticRecords(record.diagnostics),
    };
    return { ok: true, message };
}

function parseDiagnosticMessage(record: Record<string, unknown>): IosSimulatorHelperParseResult {
    if (record.v !== 1) return { ok: false, reasonCode: 'helper_message_malformed' };
    const severity = record.severity;
    const code = stringValue(record.code);
    if ((severity !== 'info' && severity !== 'warning' && severity !== 'error') || !code) {
        return { ok: false, reasonCode: 'helper_diagnostic_malformed' };
    }
    const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : undefined;
    return {
        ok: true,
        message: {
            v: 1,
            kind: 'diagnostic',
            severity,
            code,
            ...(optionalStringValue(record.message) ? { message: optionalStringValue(record.message) } : {}),
            ...(details ? { details } : {}),
        },
    };
}

function parseFrameMessage(input: Readonly<{
    record: Record<string, unknown>;
    maxPayloadBytes: number;
    lastFrame: IosSimulatorHelperFrameMessage | null;
}>): IosSimulatorHelperParseResult {
    const { record } = input;
    const streamId = stringValue(record.streamId);
    const sourceId = stringValue(record.sourceId);
    const sequence = positiveInt(record.sequence);
    const timestampMs = nonNegativeInt(record.timestampMs);
    const codecId = typeof record.codecId === 'string' ? record.codecId as MachineLiveStreamCodecIdV1 : null;
    const payloadKind = typeof record.payloadKind === 'string' ? record.payloadKind as MachineLiveStreamPayloadKindV1 : null;
    const payloadBase64 = typeof record.payloadBase64 === 'string' ? record.payloadBase64 : null;
    const payloadSizeBytes = positiveInt(record.payloadSizeBytes);

    if (record.v !== 1 || !streamId || !sourceId || !sequence || timestampMs === null || !codecId || !payloadKind || !payloadBase64 || !payloadSizeBytes) {
        return { ok: false, reasonCode: 'helper_frame_malformed' };
    }
    if (!SUPPORTED_CODECS.has(codecId)) return { ok: false, reasonCode: 'helper_frame_unsupported_codec' };
    if (!SUPPORTED_PAYLOAD_KINDS.has(payloadKind)) return { ok: false, reasonCode: 'helper_frame_malformed' };
    if (record.payloadEncoding !== 'binary_base64') return { ok: false, reasonCode: 'helper_frame_unsupported_payload_encoding' };
    if (input.lastFrame && sequence <= input.lastFrame.sequence) {
        return { ok: false, reasonCode: 'helper_frame_sequence_not_monotonic' };
    }
    if (input.lastFrame && timestampMs < input.lastFrame.timestampMs) {
        return { ok: false, reasonCode: 'helper_frame_timestamp_not_monotonic' };
    }

    const decodedBytes = getMachineLiveStreamPayloadDecodedByteLength(payloadBase64);
    if (decodedBytes !== payloadSizeBytes) return { ok: false, reasonCode: 'helper_frame_payload_size_mismatch' };
    if (decodedBytes > input.maxPayloadBytes) return { ok: false, reasonCode: 'helper_frame_payload_too_large' };

    return {
        ok: true,
        message: {
            v: 1,
            kind: 'frame',
            streamId,
            sourceId,
            sequence,
            timestampMs,
            codecId,
            payloadKind,
            payloadEncoding: 'binary_base64',
            payloadBase64,
            payloadSizeBytes,
        },
    };
}

function parseControlAckMessage(input: Readonly<{
    record: Record<string, unknown>;
    knownCommandIds?: ReadonlySet<string>;
}>): IosSimulatorHelperParseResult {
    const commandId = stringValue(input.record.commandId);
    const status = input.record.status;
    if (input.record.v !== 1 || !commandId || (status !== 'accepted' && status !== 'rejected' && status !== 'unavailable')) {
        return { ok: false, reasonCode: 'helper_control_ack_malformed' };
    }
    if (input.knownCommandIds && !input.knownCommandIds.has(commandId)) {
        return { ok: false, reasonCode: 'helper_control_ack_unknown_command' };
    }
    return {
        ok: true,
        message: {
            v: 1,
            kind: 'control_ack',
            commandId,
            status,
            ...(optionalStringValue(input.record.reasonCode) ? { reasonCode: optionalStringValue(input.record.reasonCode) } : {}),
            diagnostics: diagnosticRecords(input.record.diagnostics),
        },
    };
}

export function createIosSimulatorHelperMessageParser(
    input: CreateIosSimulatorHelperMessageParserInput,
): IosSimulatorHelperMessageParser {
    let lastFrame: IosSimulatorHelperFrameMessage | null = null;
    return {
        parse: (raw) => {
            const record = parseRecord(raw);
            if (!record.ok) return record;
            const kind = record.value.kind;
            const parsed = kind === 'status'
                ? parseStatusMessage(record.value)
                : kind === 'diagnostic'
                    ? parseDiagnosticMessage(record.value)
                    : kind === 'frame'
                        ? parseFrameMessage({
                            record: record.value,
                            maxPayloadBytes: input.maxPayloadBytes,
                            lastFrame,
                        })
                        : kind === 'control_ack'
                            ? parseControlAckMessage({
                                record: record.value,
                                knownCommandIds: input.knownCommandIds,
                            })
                            : { ok: false as const, reasonCode: 'helper_message_unknown_kind' };
            if (parsed.ok && parsed.message.kind === 'frame') {
                lastFrame = parsed.message;
            }
            return parsed;
        },
    };
}

function parseIosSimulatorIdFromSourceId(sourceId: string): string | null {
    const prefix = 'ios-simulator:';
    const suffix = ':screen';
    if (!sourceId.startsWith(prefix) || !sourceId.endsWith(suffix)) return null;
    const simulatorId = sourceId.slice(prefix.length, -suffix.length).trim();
    return simulatorId.length > 0 ? simulatorId : null;
}

function isSafeKeyboardText(text: string): boolean {
    if (text.length > 1024) return false;
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) return false;
        if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) continue;
        if (codePoint < 0x20 || codePoint === 0x7f) return false;
    }
    return true;
}

function commandIdForControl(control: MachineLiveStreamControlSidebandV1): string {
    return `cmd-${control.eventId}`;
}

export function serializeIosSimulatorHelperCommand(
    input: SerializeIosSimulatorHelperCommandInput,
): SerializeIosSimulatorHelperCommandResult {
    const parsedControl = MachineLiveStreamControlSidebandV1Schema.safeParse(input.control);
    if (!parsedControl.success || !INPUT_CONTROL_KINDS.has(input.control.kind)) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_simulator_control_unsupported',
            diagnostics: [{ code: 'ios_simulator_control_not_input', kind: input.control.kind }],
        };
    }
    const supportedInputKinds = input.supportedInputKinds ? new Set(input.supportedInputKinds) : null;
    if (supportedInputKinds && !supportedInputKinds.has(input.control.kind as MachineLiveStreamInputControlKindV1)) {
        return {
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_simulator_control_unsupported',
            diagnostics: [{ code: 'ios_simulator_control_not_advertised', kind: input.control.kind }],
        };
    }
    const simulatorId = parseIosSimulatorIdFromSourceId(input.control.sourceId);
    if (!simulatorId) {
        return {
            ok: false,
            status: 'rejected',
            reasonCode: 'invalid_ios_simulator_source',
            diagnostics: [{ code: 'invalid_ios_simulator_source' }],
        };
    }
    if (input.control.kind === 'keyboard_text' && !isSafeKeyboardText(input.control.text)) {
        return {
            ok: false,
            status: 'rejected',
            reasonCode: 'ios_simulator_keyboard_text_rejected',
            diagnostics: [{ code: 'ios_simulator_keyboard_text_rejected' }],
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
                simulatorId,
            },
            control: parsedControl.data,
        },
    };
}

export function createIosSimulatorHelperCommandSender(input: Readonly<{
    supportedInputKinds?: readonly MachineLiveStreamInputControlKindV1[];
    writeCommand: IosSimulatorHelperCommandWriter;
}>): IosSimulatorHelperCommandSender {
    return async (control) => {
        const serialized = serializeIosSimulatorHelperCommand({
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
                reasonCode: 'helper_control_ack_unknown_command',
                diagnostics: [{ code: 'helper_control_ack_unknown_command' }],
            };
        }
        if (ack.status === 'accepted') return { ok: true, diagnostics: ack.diagnostics };
        return {
            ok: false,
            status: ack.status,
            reasonCode: ack.reasonCode ?? 'ios_simulator_control_failed',
            diagnostics: ack.diagnostics,
        };
    };
}
