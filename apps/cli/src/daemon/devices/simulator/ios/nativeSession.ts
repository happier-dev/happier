import { setTimeout as delay } from 'node:timers/promises';

import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import type { SimulatorCaptureFrameProducer, SimulatorCaptureFrameProducerStartInput } from '../capture/adapter';
import { DEFAULT_SIMULATOR_LONG_PRESS_DURATION_MS, DEFAULT_SIMULATOR_SWIPE_DURATION_MS } from '../input';
import type { IosSimulatorNativeAddon, IosSimulatorNativeCapture, IosSimulatorNativeHid } from './native';

type ActiveCapture = {
    sourceId: string;
    deviceId: string;
    capture: IosSimulatorNativeCapture;
    hid?: IosSimulatorNativeHid;
};

// USB HID keyboard usages accepted by the native producer's keyboard channel.
const KEY_USAGES: Readonly<Record<string, number>> = {
    enter: 40, return: 40, escape: 41, backspace: 42, tab: 43, space: 44,
    delete: 76, end: 77, home: 74, arrowright: 79, arrowleft: 80, arrowdown: 81, arrowup: 82,
};

const PUNCTUATION_USAGES: Readonly<Record<string, number>> = {
    ' ': 44, '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49,
    ';': 51, "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
    '\n': 40, '\r': 40, '\t': 43,
};
const SHIFTED_CHARACTERS = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED_CHARACTERS = '`1234567890-=[]\\;\',./';

function characterUsage(character: string): { usage: number; shift: boolean } | null {
    if (character.length !== 1 || character.charCodeAt(0) > 127) return null;
    const shiftedIndex = SHIFTED_CHARACTERS.indexOf(character);
    const unshifted = shiftedIndex >= 0 ? UNSHIFTED_CHARACTERS[shiftedIndex]! : character.toLowerCase();
    const code = unshifted.charCodeAt(0);
    const usage = code >= 97 && code <= 122 ? code - 97 + 4
        : code >= 49 && code <= 57 ? code - 49 + 30
            : unshifted === '0' ? 39 : PUNCTUATION_USAGES[unshifted];
    return usage === undefined ? null : { usage, shift: shiftedIndex >= 0 || character !== unshifted };
}

export type IosSimulatorNativeSession = Readonly<{
    createProducer: (deviceId: string) => SimulatorCaptureFrameProducer;
    sendCommand: IosSimulatorNativeInputSender;
    stop: () => Promise<void>;
}>;

export type IosSimulatorNativeInputSender = (control: MachineLiveStreamControlSidebandV1) => Promise<Readonly<
    | { ok: true }
    | { ok: false; status?: 'rejected' | 'unavailable'; reasonCode: string; diagnostics?: readonly Record<string, unknown>[] }
>>;

export function createIosSimulatorNativeSession(input: Readonly<{ addon: IosSimulatorNativeAddon }>): IosSimulatorNativeSession {
    const captures = new Set<ActiveCapture>();
    const stops = new Set<() => Promise<void>>();
    let stopped = false;

    const createProducer = (deviceId: string): SimulatorCaptureFrameProducer => ({
        start: async (startInput: SimulatorCaptureFrameProducerStartInput) => {
            if (stopped) throw Object.assign(new Error('iOS producer stopped'), { reasonCode: 'capture_stopped' });
            const codec = startInput.negotiatedCodecId;
            if (codec !== 'image.mjpeg' && codec !== 'h264.avcc') {
                throw Object.assign(new Error('Unsupported iOS codec'), { reasonCode: 'unsupported_codec' });
            }
            // Match the bundled upstream producer defaults; omitted grant limits are not numeric N-API arguments.
            let fps = startInput.caps.maxFramesPerSecond ?? 60;
            let bitrate = startInput.caps.maxBitrateBps ?? 6_000_000;
            let maxDimension = 0;
            let active: ActiveCapture | null = null;
            let unsubscribe: (() => void | Promise<void>) | null = null;
            let closed = false;
            let paused = false;
            let pending = Promise.resolve();

            const detach = async () => {
                const retiring = active;
                const unlisten = unsubscribe;
                active = null;
                unsubscribe = null;
                if (retiring) captures.delete(retiring);
                try { await unlisten?.(); } finally { await retiring?.capture.stop(); }
            };
            const attach = async () => {
                if (closed || paused) return;
                const capture = new input.addon.SimCapture(deviceId, fps, 0.7, maxDimension, fps, bitrate, 0);
                active = { sourceId: startInput.sourceId, deviceId, capture };
                captures.add(active);
                unsubscribe = await capture.subscribe(codec === 'image.mjpeg' ? 0 : 1, (data, _width, _height, flags) => {
                    if (closed || paused) return;
                    // AVCC callbacks already contain the shared length/tag envelope. Flags describe
                    // that envelope; wrapping the bytes again would break the shared decoder.
                    startInput.emitFrame({
                        codecId: codec, payload: data,
                        payloadKind: codec === 'h264.avcc' && (flags & 1) !== 0 ? 'metadata'
                            : codec === 'image.mjpeg' || (flags & 2) !== 0 ? 'image_keyframe' : 'image_delta',
                        timestampMs: Date.now(),
                    });
                });
                await capture.start();
            };
            const enqueue = (operation: () => Promise<void>) => {
                pending = pending.then(operation).catch(async () => {
                    startInput.fail('ios_native_producer_unavailable');
                    closed = true;
                    await detach();
                });
                return { ok: true as const };
            };
            const stop = async () => {
                closed = true;
                await pending;
                await detach();
                stops.delete(stop);
            };
            stops.add(stop);
            try { await attach(); } catch (error) { await stop(); throw error; }
            return {
                stop,
                pause: () => {
                    paused = true;
                    return enqueue(detach);
                },
                resume: () => {
                    paused = false;
                    return enqueue(async () => { if (!active) await attach(); });
                },
                requestKeyframe: () => enqueue(async () => { await detach(); await attach(); }),
                setQuality: (control: Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }>) => {
                    fps = Math.min(control.maxFramesPerSecond ?? fps, startInput.caps.maxFramesPerSecond ?? Infinity);
                    bitrate = Math.min(control.maxBitrateBps ?? bitrate, startInput.caps.maxBitrateBps ?? Infinity);
                    const dimensions = [control.maxWidth, control.maxHeight].filter((value): value is number => value !== undefined);
                    if (dimensions.length) maxDimension = Math.min(...dimensions);
                    return enqueue(async () => { await active?.capture.updateStreamSettings(fps, 0.7, maxDimension, fps, bitrate); });
                },
            };
        },
    });

    const sendCommand: IosSimulatorNativeInputSender = async (control) => {
        const active = [...captures].find((candidate) => candidate.sourceId === control.sourceId);
        if (!active || stopped) return { ok: false, reasonCode: 'ios_simulator_capture_not_active' };
        try {
            const hid = active.hid ??= new input.addon.SimHID(active.deviceId);
            const size = await active.capture.screenSize();
            const touch = (phase: 'begin' | 'move' | 'end', x: number, y: number) => hid.touch(phase, x, y, size.width, size.height, 0);
            if (control.kind === 'tap' || control.kind === 'long_press') {
                await touch('begin', control.x, control.y);
                try {
                    if (control.kind === 'long_press') await delay(control.durationMs ?? DEFAULT_SIMULATOR_LONG_PRESS_DURATION_MS);
                } finally { await touch('end', control.x, control.y); }
            } else if (control.kind === 'swipe' || control.kind === 'drag') {
                await touch('begin', control.fromX, control.fromY);
                try {
                    await touch('move', control.toX, control.toY);
                    await delay(control.durationMs ?? DEFAULT_SIMULATOR_SWIPE_DURATION_MS);
                } finally { await touch('end', control.toX, control.toY); }
            } else if (control.kind === 'hardware_button') {
                if (control.button !== 'home' && control.button !== 'lock') {
                    return { ok: false, status: 'rejected', reasonCode: 'ios_simulator_button_unsupported' };
                }
                await hid.button(control.button);
            } else if (control.kind === 'keyboard_text') {
                for (const character of control.text) {
                    const key = characterUsage(character);
                    if (key) {
                        if (key.shift) await hid.key('down', 225);
                        try {
                            await hid.key('down', key.usage);
                            await hid.key('up', key.usage);
                        } finally { if (key.shift) await hid.key('up', 225); }
                    } else if (!await input.addon.axTypeKeyboardCharacter(active.deviceId, character)) {
                        return { ok: false, reasonCode: 'ios_simulator_keyboard_unavailable' };
                    }
                }
            } else if (control.kind === 'keyboard_key') {
                const usage = KEY_USAGES[control.key.toLowerCase()];
                if (usage === undefined || control.modifiers?.length) {
                    return { ok: false, status: 'rejected', reasonCode: 'ios_simulator_key_unsupported' };
                }
                await hid.key('down', usage);
                await hid.key('up', usage);
            } else return { ok: false, status: 'rejected', reasonCode: 'ios_simulator_control_unsupported' };
            return { ok: true };
        } catch (error) {
            return { ok: false, reasonCode: 'ios_simulator_input_failed', diagnostics: [{
                errorName: error instanceof Error ? error.name : 'UnknownError',
                ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? { nativeCode: error.code } : {}),
            }] };
        }
    };
    return {
        createProducer,
        sendCommand,
        stop: async () => { stopped = true; await Promise.all([...stops].map((stop) => stop())); },
    };
}
