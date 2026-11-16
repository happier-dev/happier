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
    it('fails closed when no native input sender is supplied', async () => {
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
                requiredOwner: 'bundled_ios_simulator_native_producer',
            })],
        });
    });

    it('passes typed controls to the native input owner', async () => {
        const { dispatchIosSimulatorInput } = await import('./input');
        const sendCommand = vi.fn(async () => ({ ok: true as const }));

        await expect(dispatchIosSimulatorInput({
            event: controlAction({ ...baseControl, kind: 'keyboard_text', text: 'hello' }),
            sendCommand,
        })).resolves.toMatchObject({ status: 'accepted' });

        expect(sendCommand).toHaveBeenCalledWith({
            v: 1,
            kind: 'keyboard_text',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            eventId: 'event-1',
            text: 'hello',
        });
    });

    it('rejects controls not advertised by the producer before invoking the sender', async () => {
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
