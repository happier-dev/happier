import { describe, expect, it, vi } from 'vitest';

import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import { createSimulatorFrameProducerCaptureAdapter } from '../capture/adapter';
import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';
import type { IosSimulatorNativeAddon } from './native';
import { createIosSimulatorNativeSession } from './nativeSession';

const sourceId = 'ios-simulator:device-1:screen';
const caps = { maxFramesPerSecond: 30, maxBitrateBps: 6_000_000, maxFrameBytes: 1_000_000, maxDurationMs: 60_000 };
const controlBase = { v: 1, sourceId, streamId: 'stream-1', eventId: 'input-1' } as const;

function boundary() {
    const events: unknown[] = [];
    let receive: ((data: Buffer, width: number, height: number, flags: number) => void) | undefined;
    const addon: IosSimulatorNativeAddon = {
        SimCapture: class {
            constructor(...args: unknown[]) { events.push(['capture', ...args]); }
            async subscribe(_codec: 0 | 1, listener: NonNullable<typeof receive>) {
                receive = listener;
                return async () => { events.push('unsubscribe'); };
            }
            async start() { events.push('start'); }
            async stop() { events.push('stop'); }
            async screenSize() { return { width: 1179, height: 2556 }; }
            async updateStreamSettings(...args: number[]) { events.push(['quality', ...args]); }
        },
        SimHID: class {
            async touch(...args: unknown[]) { events.push(['touch', ...args]); }
            async button(button: string) { events.push(['button', button]); }
            async key(...args: unknown[]) { events.push(['key', ...args]); }
        },
        async axTypeKeyboardCharacter() { return false; },
    };
    return { addon, events, emit: (data: Buffer, flags: number) => receive?.(data, 498, 1080, flags) };
}

function captureInput(offerFrame: MachineLiveStreamCaptureStartInput['offerFrame']): MachineLiveStreamCaptureStartInput {
    return {
        streamId: 'stream-1', streamFamily: sourceId, sourceMachineId: 'source', targetMachineId: 'home',
        caps, startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame,
        applyControl: () => ({ ok: true }), emitReceipt: () => {},
        startRequest: { v: 1, streamId: 'stream-1', streamFamily: sourceId, sourceMachineId: 'source', targetMachineId: 'home',
            routeKind: 'machine_relay', codecId: 'h264.avcc', viewerCodecs: ['h264.avcc'], ...caps },
    };
}

describe('iOS native session', () => {
    it('preserves native AVCC envelopes and metadata, uses actual screen size for input, and stops on detach', async () => {
        const native = boundary();
        const owner = createIosSimulatorNativeSession({ addon: native.addon });
        const frames: { payloadKind: string; payloadBase64: string }[] = [];
        const adapter = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['h264.avcc'], producer: owner.createProducer('device-1') });
        const result = await adapter.start(captureInput((frame) => { frames.push(frame); return { ok: true }; }));
        expect(result.ok).toBe(true);
        const description = Buffer.from([0, 0, 0, 3, 1, 1, 100]);
        const keyframe = Buffer.from([0, 0, 0, 2, 2, 101]);
        native.emit(description, 1);
        native.emit(keyframe, 2);
        expect(frames).toMatchObject([
            { payloadKind: 'metadata', payloadBase64: description.toString('base64') },
            { payloadKind: 'image_keyframe', payloadBase64: keyframe.toString('base64') },
        ]);
        await expect(owner.sendCommand({ ...controlBase, kind: 'tap', x: 0.4, y: 0.6 })).resolves.toEqual({ ok: true });
        expect(native.events).toContainEqual(['touch', 'begin', 0.4, 0.6, 1179, 2556, 0]);
        if (result.ok) await result.session.stop();
        const afterStop = frames.length;
        native.emit(keyframe, 2);
        expect(frames).toHaveLength(afterStop);
        expect(native.events.slice(-2)).toEqual(['unsubscribe', 'stop']);
        await expect(owner.sendCommand({ ...controlBase, kind: 'tap', x: 0.4, y: 0.6 })).resolves.toMatchObject({ ok: false });
    });

    it.each(['🙂', 'İ'])('does not acknowledge Unicode %s the native keyboard refused', async (text) => {
        const native = boundary();
        const owner = createIosSimulatorNativeSession({ addon: native.addon });
        const adapter = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['h264.avcc'], producer: owner.createProducer('device-1') });
        await adapter.start(captureInput(() => ({ ok: true })));
        await expect(owner.sendCommand({ ...controlBase, kind: 'keyboard_text', text })).resolves.toMatchObject({
            ok: false, reasonCode: 'ios_simulator_keyboard_unavailable',
        });
        await owner.stop();
    });

    it('types text through native HID when the software keyboard is unavailable and releases Shift', async () => {
        const native = boundary();
        const owner = createIosSimulatorNativeSession({ addon: native.addon });
        const adapter = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['h264.avcc'], producer: owner.createProducer('device-1') });
        await adapter.start(captureInput(() => ({ ok: true })));
        await expect(owner.sendCommand({ ...controlBase, kind: 'keyboard_text', text: 'Az1!' })).resolves.toEqual({ ok: true });
        expect(native.events.filter((event) => Array.isArray(event) && event[0] === 'key')).toEqual([
            ['key', 'down', 225], ['key', 'down', 4], ['key', 'up', 4], ['key', 'up', 225],
            ['key', 'down', 29], ['key', 'up', 29],
            ['key', 'down', 30], ['key', 'up', 30],
            ['key', 'down', 225], ['key', 'down', 30], ['key', 'up', 30], ['key', 'up', 225],
        ]);
        await owner.stop();
    });

    it('applies quality within admitted caps and restarts the producer for a fresh keyframe', async () => {
        const native = boundary();
        const owner = createIosSimulatorNativeSession({ addon: native.addon });
        const adapter = createSimulatorFrameProducerCaptureAdapter({ sourceId, sourceCodecs: ['h264.avcc'], producer: owner.createProducer('device-1') });
        const result = await adapter.start(captureInput(() => ({ ok: true })));
        if (!result.ok) throw new Error('capture did not start');
        const control: MachineLiveStreamControlSidebandV1 = { ...controlBase, kind: 'set_quality', maxFramesPerSecond: 60, maxBitrateBps: 9_000_000, maxWidth: 1080 };
        expect(result.session.applySidebandControl?.(control)).toEqual({ ok: true });
        expect(result.session.applySidebandControl?.({ ...controlBase, kind: 'request_keyframe' })).toEqual({ ok: true });
        await vi.waitFor(() => expect(native.events.filter((event) => event === 'start')).toHaveLength(2));
        await owner.stop();
        expect(native.events).toContainEqual(['quality', 30, 0.7, 1080, 30, 6_000_000]);
        expect(native.events.filter((event) => event === 'stop')).toHaveLength(2);
    });
});
