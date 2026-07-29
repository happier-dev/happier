import type {
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
import {
    ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON,
    androidScrcpyAbsoluteOrientationUnsupportedDiagnostics,
    isAndroidScrcpyControlOnlyKind,
    type AndroidScrcpyControlSender,
} from './control';
import {
    defaultAndroidToolRunner,
    type AndroidToolRunResult,
    type AndroidToolRunner,
} from './process';
import { parseAndroidSerialFromSimulatorSourceId } from './source';
import {
    resolveAndroidAdbTooling,
    type AndroidAdbToolingResolution,
} from './tooling';

const DEFAULT_ANDROID_INPUT_TIMEOUT_MS = 5_000;
const DEFAULT_ANDROID_SWIPE_DURATION_MS = 250;
const DEFAULT_ANDROID_LONG_PRESS_DURATION_MS = 500;

export type AndroidSimulatorInputDisplaySize = Readonly<{
    widthPx: number;
    heightPx: number;
}>;

export type AndroidSimulatorInputDisplaySizeResolver = (
    input: Readonly<{ serial: string }>,
) => AndroidSimulatorInputDisplaySize | Promise<AndroidSimulatorInputDisplaySize>;

export type AndroidSimulatorInputDisplaySizeResolution = Readonly<
    | { ok: true; displaySize: AndroidSimulatorInputDisplaySize }
    | { ok: false; reasonCode: string; diagnostics: readonly Record<string, unknown>[] }
>;

export type DispatchAndroidSimulatorInputInput = Readonly<{
    event: SimulatorPreviewActionV1;
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution>;
    runAdb?: AndroidToolRunner;
    sendScrcpyControl?: AndroidScrcpyControlSender;
    displaySize?: AndroidSimulatorInputDisplaySize | AndroidSimulatorInputDisplaySizeResolver;
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

type AndroidAdbCommand = Readonly<{
    serial: string;
    args: readonly string[];
}>;

const KEYBOARD_KEYEVENTS = new Map<string, string>([
    ['enter', '66'],
    ['return', '66'],
    ['escape', '111'],
    ['esc', '111'],
    ['backspace', '67'],
    ['delete', '112'],
    ['tab', '61'],
    ['space', '62'],
    ['arrowup', '19'],
    ['arrowdown', '20'],
    ['arrowleft', '21'],
    ['arrowright', '22'],
]);

const HARDWARE_BUTTON_KEYEVENTS = new Map<string, string>([
    ['home', '3'],
    ['back', '4'],
    ['power', '26'],
    ['volumeup', '24'],
    ['volumedown', '25'],
    ['volumemute', '164'],
    ['appswitch', '187'],
    ['recent', '187'],
    ['recents', '187'],
]);

function normalizeKeyName(value: string): string {
    return value.trim().toLowerCase().replace(/[-_\s]/g, '');
}

function validDisplaySize(value: AndroidSimulatorInputDisplaySize): boolean {
    return Number.isInteger(value.widthPx)
        && Number.isInteger(value.heightPx)
        && value.widthPx > 0
        && value.heightPx > 0;
}

function coordinateToPixel(value: number, maxPixels: number): string {
    const maxIndex = Math.max(0, maxPixels - 1);
    const px = Math.round(Math.min(1, Math.max(0, value)) * maxIndex);
    return String(px);
}

function xy(
    x: number,
    y: number,
    displaySize: AndroidSimulatorInputDisplaySize,
): readonly [string, string] {
    return [
        coordinateToPixel(x, displaySize.widthPx),
        coordinateToPixel(y, displaySize.heightPx),
    ];
}

function escapeAndroidInputText(text: string): string | null {
    let escaped = '';
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined) return null;
        if (char === ' ') {
            escaped += '%s';
            continue;
        }
        if (codePoint < 0x21 || codePoint > 0x7e || char === '%' || char === '\\') return null;
        if (!/^[A-Za-z0-9._,@:+/=-]$/.test(char)) return null;
        escaped += char;
    }
    return escaped;
}

function parsePhysicalDisplaySize(stdout: string): AndroidSimulatorInputDisplaySize | null {
    const matches = [...stdout.matchAll(/\b(Physical|Override)\s+size:\s*(\d+)x(\d+)\b/gi)];
    const match = matches.find((candidate) => candidate[1]?.toLowerCase() === 'override') ?? matches[0];
    if (!match?.[2] || !match[3]) return null;
    const widthPx = Number.parseInt(match[2], 10);
    const heightPx = Number.parseInt(match[3], 10);
    const size = { widthPx, heightPx };
    return validDisplaySize(size) ? size : null;
}

function adbFailureDiagnostic(
    code: string,
    result: AndroidToolRunResult,
): Record<string, unknown> {
    return {
        code,
        exitCode: result.exitCode,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.aborted ? { aborted: true } : {}),
        ...(result.errorName ? { errorName: result.errorName } : {}),
    };
}

async function runAdbCommand(input: Readonly<{
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runAdb: AndroidToolRunner;
    command: AndroidAdbCommand;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<AndroidToolRunResult> {
    return await input.runAdb({
        command: input.adb.command,
        args: ['-s', input.command.serial, ...input.command.args],
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
}

async function resolveDisplaySize(input: Readonly<{
    event: SimulatorPreviewActionV1;
    adb: Extract<AndroidAdbToolingResolution, { ok: true }>;
    runAdb: AndroidToolRunner;
    serial: string;
    displaySize?: AndroidSimulatorInputDisplaySize | AndroidSimulatorInputDisplaySizeResolver;
    timeoutMs: number;
    signal?: AbortSignal;
}>): Promise<Readonly<
    | { ok: true; displaySize: AndroidSimulatorInputDisplaySize }
    | { ok: false; result: SimulatorPreviewActionResultV1 }
>> {
    const resolved = await resolveAndroidSimulatorInputDisplaySize({
        serial: input.serial,
        displaySize: input.displaySize,
        resolveAdbTooling: async () => input.adb,
        runAdb: input.runAdb,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (resolved.ok) return resolved;
    return {
        ok: false,
        result: unavailableSimulatorInputResult(
            input.event,
            resolved.reasonCode,
            resolved.diagnostics,
        ),
    };
}

export async function resolveAndroidSimulatorInputDisplaySize(input: Readonly<{
    serial: string;
    resolveAdbTooling?: () => Promise<AndroidAdbToolingResolution>;
    runAdb?: AndroidToolRunner;
    displaySize?: AndroidSimulatorInputDisplaySize | AndroidSimulatorInputDisplaySizeResolver;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<AndroidSimulatorInputDisplaySizeResolution> {
    if (typeof input.displaySize === 'function') {
        const displaySize = await input.displaySize({ serial: input.serial });
        if (validDisplaySize(displaySize)) return { ok: true, displaySize };
        return {
            ok: false,
            reasonCode: 'android_simulator_display_size_unavailable',
            diagnostics: [{ code: 'invalid_android_display_size' }],
        };
    }
    if (input.displaySize) {
        if (validDisplaySize(input.displaySize)) return { ok: true, displaySize: input.displaySize };
        return {
            ok: false,
            reasonCode: 'android_simulator_display_size_unavailable',
            diagnostics: [{ code: 'invalid_android_display_size' }],
        };
    }

    const resolveAdb = input.resolveAdbTooling ?? (() => resolveAndroidAdbTooling({
        ...(input.signal ? { signal: input.signal } : {}),
    }));
    const adb = await resolveAdb();
    if (!adb.ok) {
        return {
            ok: false,
            reasonCode: adb.reasonCode,
            diagnostics: adb.diagnostics,
        };
    }

    const runAdb = input.runAdb ?? defaultAndroidToolRunner;
    const timeoutMs = input.timeoutMs ?? DEFAULT_ANDROID_INPUT_TIMEOUT_MS;
    const result = await runAdbCommand({
        adb,
        runAdb,
        command: { serial: input.serial, args: ['shell', 'wm', 'size'] },
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
        return {
            ok: false,
            reasonCode: 'android_simulator_display_size_unavailable',
            diagnostics: [adbFailureDiagnostic('android_simulator_display_size_query_failed', result)],
        };
    }

    const displaySize = parsePhysicalDisplaySize(result.stdout);
    if (!displaySize) {
        return {
            ok: false,
            reasonCode: 'android_simulator_display_size_unavailable',
            diagnostics: [{ code: 'android_simulator_display_size_parse_failed' }],
        };
    }
    return { ok: true, displaySize };
}

function requiresDisplaySize(control: MachineLiveStreamControlSidebandV1): boolean {
    return control.kind === 'tap'
        || control.kind === 'long_press'
        || control.kind === 'swipe'
        || control.kind === 'drag';
}

function buildAdbInputCommand(input: Readonly<{
    serial: string;
    control: MachineLiveStreamControlSidebandV1;
    displaySize?: AndroidSimulatorInputDisplaySize;
}>): Readonly<
    | { ok: true; command: AndroidAdbCommand }
    | { ok: false; status: 'rejected' | 'unavailable'; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
> {
    const { control, displaySize } = input;
    switch (control.kind) {
        case 'tap': {
            if (!displaySize) return { ok: false, status: 'unavailable', reasonCode: 'android_simulator_display_size_unavailable' };
            const [x, y] = xy(control.x, control.y, displaySize);
            return { ok: true, command: { serial: input.serial, args: ['shell', 'input', 'tap', x, y] } };
        }
        case 'long_press': {
            if (!displaySize) return { ok: false, status: 'unavailable', reasonCode: 'android_simulator_display_size_unavailable' };
            const [x, y] = xy(control.x, control.y, displaySize);
            const durationMs = String(control.durationMs ?? DEFAULT_ANDROID_LONG_PRESS_DURATION_MS);
            return { ok: true, command: { serial: input.serial, args: ['shell', 'input', 'swipe', x, y, x, y, durationMs] } };
        }
        case 'swipe':
        case 'drag': {
            if (!displaySize) return { ok: false, status: 'unavailable', reasonCode: 'android_simulator_display_size_unavailable' };
            const [fromX, fromY] = xy(control.fromX, control.fromY, displaySize);
            const [toX, toY] = xy(control.toX, control.toY, displaySize);
            const durationMs = String(control.durationMs ?? DEFAULT_ANDROID_SWIPE_DURATION_MS);
            return {
                ok: true,
                command: {
                    serial: input.serial,
                    args: ['shell', 'input', 'swipe', fromX, fromY, toX, toY, durationMs],
                },
            };
        }
        case 'keyboard_text': {
            const escaped = escapeAndroidInputText(control.text);
            if (escaped === null) {
                return {
                    ok: false,
                    status: 'rejected',
                    reasonCode: 'android_simulator_keyboard_text_rejected',
                    diagnostics: [{ code: 'android_simulator_keyboard_text_rejected' }],
                };
            }
            return {
                ok: true,
                command: { serial: input.serial, args: ['shell', 'input', 'text', escaped] },
            };
        }
        case 'keyboard_key': {
            const keyCode = KEYBOARD_KEYEVENTS.get(normalizeKeyName(control.key));
            if (!keyCode) return { ok: false, status: 'rejected', reasonCode: 'android_simulator_key_unsupported' };
            return {
                ok: true,
                command: { serial: input.serial, args: ['shell', 'input', 'keyevent', keyCode] },
            };
        }
        case 'hardware_button': {
            const keyCode = HARDWARE_BUTTON_KEYEVENTS.get(normalizeKeyName(control.button));
            if (!keyCode) return { ok: false, status: 'rejected', reasonCode: 'android_simulator_key_unsupported' };
            return {
                ok: true,
                command: { serial: input.serial, args: ['shell', 'input', 'keyevent', keyCode] },
            };
        }
        case 'orientation':
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON,
                diagnostics: androidScrcpyAbsoluteOrientationUnsupportedDiagnostics(),
            };
        case 'pinch':
        case 'rotate':
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: 'android_simulator_control_unsupported',
                diagnostics: [{ code: 'android_simulator_control_requires_native_helper', kind: control.kind }],
            };
        default:
            return {
                ok: false,
                status: 'unavailable',
                reasonCode: 'android_simulator_control_unsupported',
                diagnostics: [{ code: 'android_simulator_control_not_input', kind: control.kind }],
            };
    }
}

function dispatchFailureResult(input: Readonly<{
    event: SimulatorPreviewActionV1;
    status: 'rejected' | 'unavailable';
    reasonCode: string;
    diagnostics?: readonly Record<string, unknown>[];
}>): SimulatorPreviewActionResultV1 {
    return input.status === 'rejected'
        ? rejectedSimulatorInputResult(input.event, input.reasonCode, input.diagnostics ?? [])
        : unavailableSimulatorInputResult(input.event, input.reasonCode, input.diagnostics ?? []);
}

async function dispatchScrcpyControlOnlyInput(input: Readonly<{
    event: SimulatorPreviewActionV1;
    control: MachineLiveStreamControlSidebandV1;
    sendScrcpyControl?: AndroidScrcpyControlSender;
}>): Promise<SimulatorPreviewActionResultV1> {
    if (!input.sendScrcpyControl) {
        return unavailableSimulatorInputResult(input.event, 'android_simulator_control_unsupported', [{
            code: 'android_simulator_control_requires_scrcpy_control_socket',
            kind: input.control.kind,
        }]);
    }

    const result = await input.sendScrcpyControl(input.control);
    if (result.ok) {
        return acceptedSimulatorInputResult(input.event, result.diagnostics ?? []);
    }
    return dispatchFailureResult({
        event: input.event,
        status: result.status ?? 'unavailable',
        reasonCode: result.reasonCode,
        diagnostics: result.diagnostics ?? [],
    });
}

export async function dispatchAndroidSimulatorInput(
    input: DispatchAndroidSimulatorInputInput,
): Promise<SimulatorPreviewActionResultV1> {
    const action = readSimulatorControlSendAction(input.event);
    if (!action) {
        return unavailableSimulatorInputResult(
            input.event,
            'android_simulator_control_unsupported',
            [{ code: 'android_simulator_action_not_input' }],
        );
    }

    const serial = parseAndroidSerialFromSimulatorSourceId(action.control.sourceId);
    if (!serial) {
        return rejectedSimulatorInputResult(input.event, 'invalid_android_simulator_source', [{
            code: 'invalid_android_simulator_source',
        }]);
    }

    if (isAndroidScrcpyControlOnlyKind(action.control.kind)) {
        return await dispatchScrcpyControlOnlyInput({
            event: input.event,
            control: action.control,
            ...(input.sendScrcpyControl ? { sendScrcpyControl: input.sendScrcpyControl } : {}),
        });
    }

    if (action.control.kind === 'orientation') {
        return unavailableSimulatorInputResult(
            input.event,
            ANDROID_SCRCPY_ABSOLUTE_ORIENTATION_UNSUPPORTED_REASON,
            androidScrcpyAbsoluteOrientationUnsupportedDiagnostics(),
        );
    }

    const resolveAdb = input.resolveAdbTooling ?? (() => resolveAndroidAdbTooling({
        ...(input.signal ? { signal: input.signal } : {}),
    }));
    const adb = await resolveAdb();
    if (!adb.ok) {
        return unavailableSimulatorInputResult(input.event, adb.reasonCode, adb.diagnostics);
    }

    const runAdb = input.runAdb ?? defaultAndroidToolRunner;
    const timeoutMs = input.timeoutMs ?? DEFAULT_ANDROID_INPUT_TIMEOUT_MS;
    const displaySize = requiresDisplaySize(action.control)
        ? await resolveDisplaySize({
            event: input.event,
            adb,
            runAdb,
            serial,
            ...(input.displaySize ? { displaySize: input.displaySize } : {}),
            timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        })
        : null;
    if (displaySize?.ok === false) {
        return displaySize.result;
    }

    const command = buildAdbInputCommand({
        serial,
        control: action.control,
        ...(displaySize?.ok ? { displaySize: displaySize.displaySize } : {}),
    });
    if (!command.ok) {
        return dispatchFailureResult({
            event: input.event,
            status: command.status,
            reasonCode: command.reasonCode,
            diagnostics: command.diagnostics ?? [],
        });
    }

    const result = await runAdbCommand({
        adb,
        runAdb,
        command: command.command,
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.exitCode !== 0) {
        return unavailableSimulatorInputResult(input.event, 'android_simulator_adb_failed', [
            adbFailureDiagnostic('android_simulator_adb_failed', result),
        ]);
    }

    return acceptedSimulatorInputResult(input.event);
}
