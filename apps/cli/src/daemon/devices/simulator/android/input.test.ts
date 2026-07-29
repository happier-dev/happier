import { EventEmitter } from 'node:events';

import type { SimulatorPreviewActionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AndroidScrcpyControlSender } from './control';
import type { AndroidToolRunner } from './tooling';

type ControlAction = Extract<SimulatorPreviewActionV1, { type: 'simulator.control.send' }>;
type Control = ControlAction['control'];

const controlAction = (control: Control): SimulatorPreviewActionV1 => ({
    type: 'simulator.control.send',
    control,
});

const baseControl = {
    v: 1,
    streamId: 'stream-1',
    sourceId: 'simulator:android:emulator-5554:screen',
    eventId: 'event-1',
} as const;

class FakeControlSocket extends EventEmitter {
    readonly writtenPackets: Uint8Array[] = [];
    readonly setNoDelay = vi.fn();
    destroyed = false;
    writableEnded = false;
    closed = false;

    write(packet: Uint8Array): boolean {
        this.writtenPackets.push(packet.slice());
        return true;
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

const tapAction = (overrides: Partial<Extract<Control, { kind: 'tap' }>> = {}): SimulatorPreviewActionV1 => (
    controlAction({
        ...baseControl,
        v: 1,
        kind: 'tap',
        x: 0.5,
        y: 0.25,
        ...overrides,
    })
);

describe('Android simulator input dispatch', () => {
    it('queries display size and sends tap controls as adb argv', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async ({ args }) => {
            if (args.join(' ') === '-s emulator-5554 shell wm size') {
                return { exitCode: 0, stdout: 'Physical size: 1080x1920\n', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });

        await expect(dispatchAndroidSimulatorInput({
            event: tapAction(),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(runAdb).toHaveBeenNthCalledWith(1, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'wm', 'size'],
            timeoutMs: expect.any(Number),
        });
        expect(runAdb).toHaveBeenNthCalledWith(2, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'tap', '540', '480'],
            timeoutMs: expect.any(Number),
        });
    });

    it('prefers Android wm override size when translating coordinates', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async ({ args }) => {
            if (args.join(' ') === '-s emulator-5554 shell wm size') {
                return {
                    exitCode: 0,
                    stdout: 'Physical size: 1080x1920\nOverride size: 720x1280\n',
                    stderr: '',
                };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });

        await expect(dispatchAndroidSimulatorInput({
            event: tapAction({ x: 1, y: 1 }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(runAdb).toHaveBeenNthCalledWith(2, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'tap', '719', '1279'],
            timeoutMs: expect.any(Number),
        });
    });

    it('translates swipe, drag, and long press into safe adb swipe argv with supplied display size', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const baseInput = {
            resolveAdbTooling: async () => ({ ok: true as const, command: 'adb', source: 'path' as const }),
            runAdb,
            displaySize: { widthPx: 1000, heightPx: 2000 },
        };

        await dispatchAndroidSimulatorInput({
            ...baseInput,
            event: controlAction({
                ...baseControl,
                kind: 'swipe',
                fromX: 0.1,
                fromY: 0.2,
                toX: 0.9,
                toY: 0.8,
                durationMs: 300,
            }),
        });
        await dispatchAndroidSimulatorInput({
            ...baseInput,
            event: controlAction({
                ...baseControl,
                kind: 'drag',
                fromX: 0.2,
                fromY: 0.3,
                toX: 0.4,
                toY: 0.5,
            }),
        });
        await dispatchAndroidSimulatorInput({
            ...baseInput,
            event: controlAction({
                ...baseControl,
                kind: 'long_press',
                x: 0.5,
                y: 0.5,
                durationMs: 750,
            }),
        });

        expect(runAdb).toHaveBeenNthCalledWith(1, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '100', '400', '899', '1599', '300'],
            timeoutMs: expect.any(Number),
        });
        expect(runAdb).toHaveBeenNthCalledWith(2, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '200', '600', '400', '1000', '250'],
            timeoutMs: expect.any(Number),
        });
        expect(runAdb).toHaveBeenNthCalledWith(3, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '500', '1000', '500', '1000', '750'],
            timeoutMs: expect.any(Number),
        });
    });

    it('escapes Android input text spaces and rejects control or unsupported text', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const common = {
            resolveAdbTooling: async () => ({ ok: true as const, command: 'adb', source: 'path' as const }),
            runAdb,
            displaySize: { widthPx: 100, heightPx: 100 },
        };

        await expect(dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'keyboard_text', text: 'hello world_42' }),
        })).resolves.toMatchObject({ status: 'accepted' });
        expect(runAdb).toHaveBeenCalledWith({
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'text', 'hello%sworld_42'],
            timeoutMs: expect.any(Number),
        });

        await expect(dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'keyboard_text', text: 'hello\nworld' }),
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'android_simulator_keyboard_text_rejected',
        });
        await expect(dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'keyboard_text', text: '100% ready' }),
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'android_simulator_keyboard_text_rejected',
        });
    });

    it('maps conservative keyboard and hardware controls to adb keyevent codes', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const common = {
            resolveAdbTooling: async () => ({ ok: true as const, command: 'adb', source: 'path' as const }),
            runAdb,
            displaySize: { widthPx: 100, heightPx: 100 },
        };

        await dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'keyboard_key', key: 'enter' }),
        });
        await dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'keyboard_key', key: 'delete' }),
        });
        await dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'hardware_button', button: 'home' }),
        });
        await expect(dispatchAndroidSimulatorInput({
            ...common,
            event: controlAction({ ...baseControl, kind: 'hardware_button', button: 'actionButton' }),
        })).resolves.toMatchObject({
            status: 'rejected',
            reasonCode: 'android_simulator_key_unsupported',
        });

        expect(runAdb).toHaveBeenNthCalledWith(1, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '66'],
            timeoutMs: expect.any(Number),
        });
        expect(runAdb).toHaveBeenNthCalledWith(2, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '112'],
            timeoutMs: expect.any(Number),
        });
        expect(runAdb).toHaveBeenNthCalledWith(3, {
            command: 'adb',
            args: ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '3'],
            timeoutMs: expect.any(Number),
        });
    });

    it('maps the full hardware-button set (back, recents, volume) to adb keyevent codes', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const common = {
            resolveAdbTooling: async () => ({ ok: true as const, command: 'adb', source: 'path' as const }),
            runAdb,
            displaySize: { widthPx: 100, heightPx: 100 },
        };

        const buttonToKeyCode: ReadonlyArray<readonly [string, string]> = [
            ['back', '4'],
            ['recents', '187'],
            ['recent', '187'],
            ['appswitch', '187'],
            ['volumeup', '24'],
            ['volume_down', '25'],
            ['volumemute', '164'],
        ];

        for (const [button] of buttonToKeyCode) {
            await dispatchAndroidSimulatorInput({
                ...common,
                event: controlAction({ ...baseControl, kind: 'hardware_button', button }),
            });
        }

        buttonToKeyCode.forEach(([, keyCode], index) => {
            expect(runAdb).toHaveBeenNthCalledWith(index + 1, {
                command: 'adb',
                args: ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', keyCode],
                timeoutMs: expect.any(Number),
            });
        });
    });

    it('returns typed unavailable diagnostics when adb command execution fails', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 1, stdout: '', stderr: 'input failed' }));

        await expect(dispatchAndroidSimulatorInput({
            event: tapAction(),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb,
            displaySize: { widthPx: 100, heightPx: 100 },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_adb_failed',
            diagnostics: [expect.objectContaining({
                code: 'android_simulator_adb_failed',
                exitCode: 1,
            })],
        });
    });

    it('fails closed for controls without a safe adb primitive', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');

        await expect(dispatchAndroidSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'pinch',
                centerX: 0.5,
                centerY: 0.5,
                startDistance: 0.2,
                endDistance: 0.5,
            }),
            resolveAdbTooling: async () => ({ ok: true, command: 'adb', source: 'path' }),
            runAdb: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            displaySize: { widthPx: 100, heightPx: 100 },
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_simulator_control_unsupported',
        });
    });

    it('routes scrcpy-control-only gestures through an explicit control sender without adb fallback', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const resolveAdbTooling = vi.fn(async () => ({ ok: true as const, command: 'adb', source: 'path' as const }));
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
        const sendScrcpyControl = vi.fn<AndroidScrcpyControlSender>(async (control) => ({
            ok: true,
            diagnostics: [{ code: 'sent_via_scrcpy_control', kind: control.kind }],
        }));

        await expect(dispatchAndroidSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'rotate',
                centerX: 0.5,
                centerY: 0.5,
                radius: 0.3,
                startAngle: 0,
                endAngle: 90,
            }),
            resolveAdbTooling,
            runAdb,
            sendScrcpyControl,
        })).resolves.toEqual({
            v: 1,
            eventType: 'simulator.control.send',
            status: 'accepted',
            diagnostics: [{ code: 'sent_via_scrcpy_control', kind: 'rotate' }],
        });

        expect(sendScrcpyControl).toHaveBeenCalledWith({
            ...baseControl,
            kind: 'rotate',
            centerX: 0.5,
            centerY: 0.5,
            radius: 0.3,
            startAngle: 0,
            endAngle: 90,
        });
        expect(resolveAdbTooling).not.toHaveBeenCalled();
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('dispatches scrcpy-control-only gestures through a live socket sender without adb fallback', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const mod = await import('./controlSocket').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('connectAndroidScrcpyLiveControlSocket');
        if (!('connectAndroidScrcpyLiveControlSocket' in mod)) return;

        const socket = new FakeControlSocket();
        const liveControl = await mod.connectAndroidScrcpyLiveControlSocket({
            screenSize: { widthPx: 1080, heightPx: 1920 },
            connect: async () => ({ ok: true, socket }),
        });
        if (!liveControl.ok) throw new Error('expected live scrcpy control socket');

        const resolveAdbTooling = vi.fn(async () => ({ ok: true as const, command: 'adb', source: 'path' as const }));
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

        await expect(dispatchAndroidSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'pinch',
                centerX: 0.5,
                centerY: 0.5,
                startDistance: 0.2,
                endDistance: 0.5,
            }),
            resolveAdbTooling,
            runAdb,
            sendScrcpyControl: liveControl.sender,
        })).resolves.toMatchObject({
            status: 'accepted',
        });

        expect(socket.writtenPackets).toHaveLength(6);
        expect(resolveAdbTooling).not.toHaveBeenCalled();
        expect(runAdb).not.toHaveBeenCalled();
    });

    it('fails absolute orientation with an explicit unsupported diagnostic before resolving adb', async () => {
        const { dispatchAndroidSimulatorInput } = await import('./input');
        const resolveAdbTooling = vi.fn(async () => ({ ok: true as const, command: 'adb', source: 'path' as const }));
        const runAdb = vi.fn<AndroidToolRunner>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

        await expect(dispatchAndroidSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'orientation',
                orientation: 'landscapeLeft',
            }),
            resolveAdbTooling,
            runAdb,
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'android_scrcpy_orientation_absolute_unsupported',
            diagnostics: [expect.objectContaining({
                code: 'android_scrcpy_orientation_absolute_unsupported',
            })],
        });

        expect(resolveAdbTooling).not.toHaveBeenCalled();
        expect(runAdb).not.toHaveBeenCalled();
    });
});
