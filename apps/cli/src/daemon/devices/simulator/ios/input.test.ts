import type { SimulatorPreviewActionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type ControlAction = Extract<SimulatorPreviewActionV1, { type: 'simulator.control.send' }>;
type Control = ControlAction['control'];

const baseControl = {
    v: 1,
    streamId: 'stream-1',
    sourceId: 'ios-simulator:A1B2-C3D4:screen',
    eventId: 'event-1',
} as const;

const controlAction = (control: Control): SimulatorPreviewActionV1 => ({
    type: 'simulator.control.send',
    control,
});

describe('iOS simulator input dispatch', () => {
    it('fails closed when no signed helper command sender is supplied', async () => {
        const { dispatchIosSimulatorInput } = await import('./input');

        await expect(dispatchIosSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'tap',
                x: 0.4,
                y: 0.6,
            }),
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_simulator_input_sender_unavailable',
            diagnostics: [expect.objectContaining({
                requiredOwner: 'signed_ios_simulator_private_framework_helper',
            })],
        });
    });

    it('serializes typed controls to the injected helper command sender', async () => {
        const { dispatchIosSimulatorInput } = await import('./input');
        const sendCommand = vi.fn(async () => ({ ok: true as const }));

        await expect(dispatchIosSimulatorInput({
            event: controlAction({ ...baseControl, kind: 'keyboard_text', text: 'hello' }),
            sendCommand,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(sendCommand).toHaveBeenCalledWith({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-1',
            target: {
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                simulatorId: 'A1B2-C3D4',
            },
            control: {
                v: 1,
                kind: 'keyboard_text',
                streamId: 'stream-1',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                eventId: 'event-1',
                text: 'hello',
            },
        });
    });

    it('rejects controls not advertised by the helper before invoking the sender', async () => {
        const { dispatchIosSimulatorInput } = await import('./input');
        const sendCommand = vi.fn(async () => ({ ok: true as const }));

        await expect(dispatchIosSimulatorInput({
            event: controlAction({
                ...baseControl,
                kind: 'keyboard_key',
                key: 'enter',
            }),
            supportedInputKinds: ['tap'],
            sendCommand,
        })).resolves.toMatchObject({
            status: 'unavailable',
            reasonCode: 'ios_simulator_control_unsupported',
        });

        expect(sendCommand).not.toHaveBeenCalled();
    });
});
