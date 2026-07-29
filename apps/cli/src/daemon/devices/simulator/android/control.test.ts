import { EventEmitter } from 'node:events';

import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

const baseControl = {
    v: 1,
    streamId: 'stream-1',
    sourceId: 'simulator:android:emulator-5554:screen',
    eventId: 'event-1',
} as const;

class FakeControlSocket extends EventEmitter {
    readonly writtenPackets: Uint8Array[] = [];
    readonly setNoDelay = vi.fn();
    writeResult = true;
    writeError: Error | null = null;
    destroyed = false;
    writableEnded = false;
    closed = false;

    write(packet: Uint8Array): boolean {
        if (this.writeError) throw this.writeError;
        this.writtenPackets.push(packet.slice());
        return this.writeResult;
    }

    end(): void {
        this.writableEnded = true;
        this.closed = true;
        this.emit('close');
    }

    destroy(): void {
        this.destroyed = true;
        this.closed = true;
        this.emit('close');
    }
}

function pinchControl(): MachineLiveStreamControlSidebandV1 {
    return {
        ...baseControl,
        kind: 'pinch',
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.2,
        endDistance: 0.5,
        durationMs: 240,
    };
}

describe('Android scrcpy control sender', () => {
    it('serializes advertised scrcpy-only input controls for the Android control socket boundary', async () => {
        const { createAndroidScrcpyControlSender } = await import('./control');
        const writeCommand = vi.fn(async () => ({
            ok: true as const,
            message: {
                v: 1 as const,
                kind: 'control_ack' as const,
                commandId: 'cmd-event-1',
                status: 'accepted' as const,
                diagnostics: [],
            },
        }));
        const sender = createAndroidScrcpyControlSender({
            supportedInputKinds: ['pinch', 'rotate'],
            writeCommand,
        });

        const control: MachineLiveStreamControlSidebandV1 = {
            ...baseControl,
            kind: 'pinch',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 0.2,
            endDistance: 0.5,
            durationMs: 240,
        };

        await expect(sender(control)).resolves.toEqual({ ok: true, diagnostics: [] });
        expect(writeCommand).toHaveBeenCalledWith({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-1',
            target: {
                sourceId: 'simulator:android:emulator-5554:screen',
                serial: 'emulator-5554',
            },
            control,
        });
    });

    it('fails closed for unadvertised controls and invalid Android simulator sources', async () => {
        const { createAndroidScrcpyControlSender } = await import('./control');
        const writeCommand = vi.fn();
        const sender = createAndroidScrcpyControlSender({
            supportedInputKinds: ['pinch'],
            writeCommand,
        });

        await expect(sender({
            ...baseControl,
            kind: 'rotate',
            centerX: 0.5,
            centerY: 0.5,
            radius: 0.4,
            startAngle: 0,
            endAngle: 180,
        })).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });

        await expect(sender({
            ...baseControl,
            sourceId: 'simulator:android::screen',
            kind: 'pinch',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 0.1,
            endDistance: 0.2,
        })).resolves.toMatchObject({
            ok: false,
            status: 'rejected',
            reasonCode: 'invalid_android_simulator_source',
        });

        expect(writeCommand).not.toHaveBeenCalled();
    });

    it('encodes pinch gestures as stock scrcpy touch-control packets', async () => {
        const {
            encodeAndroidScrcpyControlCommandPackets,
        } = await import('./control');
        const serialized = encodeAndroidScrcpyControlCommandPackets({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            command: {
                v: 1,
                kind: 'control',
                commandId: 'cmd-event-1',
                target: {
                    sourceId: 'simulator:android:emulator-5554:screen',
                    serial: 'emulator-5554',
                },
                control: {
                    ...baseControl,
                    kind: 'pinch',
                    centerX: 0.5,
                    centerY: 0.5,
                    startDistance: 0.2,
                    endDistance: 0.4,
                },
            },
        });

        expect(serialized).toMatchObject({ ok: true });
        if (!serialized.ok) return;

        expect(serialized.packets).toHaveLength(6);
        expect(serialized.packets.every((packet) => packet.byteLength === 32)).toBe(true);

        const first = new DataView(serialized.packets[0]!.buffer);
        expect(first.getUint8(0)).toBe(2); // ControlMessage.TYPE_INJECT_TOUCH_EVENT
        expect(first.getUint8(1)).toBe(0); // MotionEvent.ACTION_DOWN
        expect(first.getBigInt64(2, false)).toBe(-2n); // SC_POINTER_ID_GENERIC_FINGER
        expect(first.getInt32(10, false)).toBe(432);
        expect(first.getInt32(14, false)).toBe(960);
        expect(first.getUint16(18, false)).toBe(1080);
        expect(first.getUint16(20, false)).toBe(1920);
        expect(first.getUint16(22, false)).toBe(0xffff);

        const move = new DataView(serialized.packets[2]!.buffer);
        expect(move.getUint8(1)).toBe(2); // MotionEvent.ACTION_MOVE
        expect(move.getBigInt64(2, false)).toBe(-2n);
        expect(move.getInt32(10, false)).toBe(324);
        expect(move.getInt32(14, false)).toBe(960);

        const last = new DataView(serialized.packets[5]!.buffer);
        expect(last.getUint8(1)).toBe(1); // MotionEvent.ACTION_UP
        expect(last.getBigInt64(2, false)).toBe(-2n);
        expect(last.getUint16(22, false)).toBe(0);
    });

    it('fails closed for absolute orientation because stock scrcpy only rotates to the next orientation', async () => {
        const {
            encodeAndroidScrcpyControlCommandPackets,
        } = await import('./control');

        expect(encodeAndroidScrcpyControlCommandPackets({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            command: {
                v: 1,
                kind: 'control',
                commandId: 'cmd-event-1',
                target: {
                    sourceId: 'simulator:android:emulator-5554:screen',
                    serial: 'emulator-5554',
                },
                control: {
                    ...baseControl,
                    kind: 'orientation',
                    orientation: 'landscapeLeft',
                },
            },
        })).toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_scrcpy_orientation_absolute_unsupported',
        });
    });

    it('rejects absolute orientation at the stock scrcpy sender boundary without writing a command', async () => {
        const { createAndroidScrcpyControlSender } = await import('./control');
        const writeCommand = vi.fn();
        const sender = createAndroidScrcpyControlSender({
            supportedInputKinds: ['orientation'],
            writeCommand,
        });

        await expect(sender({
            ...baseControl,
            kind: 'orientation',
            orientation: 'landscapeLeft',
        })).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'android_scrcpy_orientation_absolute_unsupported',
            diagnostics: [expect.objectContaining({
                code: 'android_scrcpy_orientation_absolute_unsupported',
            })],
        });
        expect(writeCommand).not.toHaveBeenCalled();
    });

    it('writes encoded scrcpy control packets in order through the binary writer seam', async () => {
        const {
            createAndroidScrcpyBinaryControlCommandWriter,
        } = await import('./control');
        const packets: Uint8Array[] = [];
        const writeCommand = createAndroidScrcpyBinaryControlCommandWriter({
            screenSize: { widthPx: 1000, heightPx: 2000 },
            writePacket: async (packet) => {
                packets.push(packet);
            },
        });

        await expect(writeCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-1',
            target: {
                sourceId: 'simulator:android:emulator-5554:screen',
                serial: 'emulator-5554',
            },
            control: {
                ...baseControl,
                kind: 'rotate',
                centerX: 0.5,
                centerY: 0.5,
                radius: 0.25,
                startAngle: 0,
                endAngle: 90,
            },
        })).resolves.toMatchObject({ ok: true });

        expect(packets).toHaveLength(6);
        expect(new DataView(packets[0]!.buffer).getBigInt64(2, false)).toBe(-2n);
        expect(new DataView(packets[1]!.buffer).getBigInt64(2, false)).toBe(-3n);
        expect(new DataView(packets[2]!.buffer).getUint8(1)).toBe(2);
        expect(new DataView(packets[3]!.buffer).getBigInt64(2, false)).toBe(-3n);
        expect(new DataView(packets[4]!.buffer).getBigInt64(2, false)).toBe(-3n);
        expect(new DataView(packets[5]!.buffer).getBigInt64(2, false)).toBe(-2n);
    });

    it('fails closed when the live scrcpy control socket cannot become ready', async () => {
        const mod = await import('./controlSocket').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('connectAndroidScrcpyLiveControlSocket');
        if (!('connectAndroidScrcpyLiveControlSocket' in mod)) return;

        await expect(mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({
                ok: false,
                reasonCode: 'scrcpy_control_socket_unavailable',
                diagnostics: [{ code: 'adb_forward_socket_missing' }],
            }),
        })).resolves.toEqual({
            ok: false,
            status: 'unavailable',
            reasonCode: 'scrcpy_control_socket_unavailable',
            diagnostics: [{ code: 'adb_forward_socket_missing' }],
        });
    });

    it('routes pinch gestures through a ready live control socket using the binary writer', async () => {
        const mod = await import('./controlSocket').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('connectAndroidScrcpyLiveControlSocket');
        if (!('connectAndroidScrcpyLiveControlSocket' in mod)) return;

        const socket = new FakeControlSocket();
        const connected = await mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({ ok: true, socket }),
        });
        expect(connected).toMatchObject({ ok: true });
        if (!connected.ok) return;

        await expect(connected.sender(pinchControl())).resolves.toMatchObject({
            ok: true,
        });

        expect(socket.setNoDelay).toHaveBeenCalledWith(true);
        expect(socket.writtenPackets).toHaveLength(6);
        expect(new DataView(socket.writtenPackets[0]!.buffer).getUint8(0)).toBe(2);
        expect(new DataView(socket.writtenPackets[5]!.buffer).getUint8(1)).toBe(1);
    });

    it('closes the live control socket once and fails later writes without touching the socket', async () => {
        const mod = await import('./controlSocket').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('connectAndroidScrcpyLiveControlSocket');
        if (!('connectAndroidScrcpyLiveControlSocket' in mod)) return;

        const socket = new FakeControlSocket();
        const connected = await mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({ ok: true, socket }),
        });
        if (!connected.ok) throw new Error('expected connected socket');

        await connected.close();
        await connected.close();
        const writesAfterClose = socket.writtenPackets.length;

        await expect(connected.sender(pinchControl())).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'scrcpy_control_socket_closed',
        });
        expect(socket.writtenPackets).toHaveLength(writesAfterClose);
        expect(connected.readState()).toEqual({ status: 'closed' });
    });

    it('fails closed on live control socket backpressure timeout and write errors', async () => {
        const mod = await import('./controlSocket').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('connectAndroidScrcpyLiveControlSocket');
        if (!('connectAndroidScrcpyLiveControlSocket' in mod)) return;

        const backpressureSocket = new FakeControlSocket();
        backpressureSocket.writeResult = false;
        const backpressure = await mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({ ok: true, socket: backpressureSocket }),
            writeDrainTimeoutMs: 1,
        });
        if (!backpressure.ok) throw new Error('expected connected backpressure socket');

        await expect(backpressure.sender(pinchControl())).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'scrcpy_control_socket_backpressure_timeout',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_control_socket_backpressure_timeout',
            })],
        });

        const failingSocket = new FakeControlSocket();
        failingSocket.writeError = new Error('socket is closed');
        const failing = await mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({ ok: true, socket: failingSocket }),
        });
        if (!failing.ok) throw new Error('expected connected failing socket');

        await expect(failing.sender(pinchControl())).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'scrcpy_control_socket_write_failed',
            diagnostics: [expect.objectContaining({
                code: 'scrcpy_control_socket_write_failed',
                errorName: 'Error',
            })],
        });
    });
});
