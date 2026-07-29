import { describe, expect, it, vi } from 'vitest';

import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

const baseControl = {
    v: 1,
    streamId: 'stream-1',
    sourceId: 'ios-simulator:A1B2-C3D4:screen',
    eventId: 'event-1',
} as const;

describe('iOS simulator helper protocol', () => {
    it('parses valid status, diagnostic, frame, and known control acknowledgement messages', async () => {
        const {
            createIosSimulatorHelperMessageParser,
        } = await import('./helperProtocol');
        const parser = createIosSimulatorHelperMessageParser({
            maxPayloadBytes: 8,
            knownCommandIds: new Set(['cmd-1']),
        });

        expect(parser.parse({
            v: 1,
            kind: 'status',
            status: 'ready',
            helperVersion: '1.2.3',
            supportedCodecs: ['image.mjpeg'],
            supportedInputKinds: ['tap', 'keyboard_text'],
        })).toEqual({
            ok: true,
            message: {
                v: 1,
                kind: 'status',
                status: 'ready',
                helperVersion: '1.2.3',
                supportedCodecs: ['image.mjpeg'],
                supportedInputKinds: ['tap', 'keyboard_text'],
                diagnostics: [],
            },
        });

        expect(parser.parse(JSON.stringify({
            v: 1,
            kind: 'diagnostic',
            severity: 'warning',
            code: 'helper_warmup_slow',
            message: 'warmup delayed',
        }))).toEqual({
            ok: true,
            message: {
                v: 1,
                kind: 'diagnostic',
                severity: 'warning',
                code: 'helper_warmup_slow',
                message: 'warmup delayed',
            },
        });

        expect(parser.parse({
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 1,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
            payloadSizeBytes: 4,
        })).toEqual({
            ok: true,
            message: expect.objectContaining({
                kind: 'frame',
                sequence: 1,
                timestampMs: 1_000,
                codecId: 'image.mjpeg',
                payloadSizeBytes: 4,
            }),
        });

        expect(parser.parse({
            v: 1,
            kind: 'control_ack',
            commandId: 'cmd-1',
            status: 'accepted',
        })).toEqual({
            ok: true,
            message: {
                v: 1,
                kind: 'control_ack',
                commandId: 'cmd-1',
                status: 'accepted',
                diagnostics: [],
            },
        });
    });

    it.each([
        ['malformed frame', { v: 1, kind: 'frame', sequence: 1 }],
        ['invalid sequence', {
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 0,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: 'AQ==',
            payloadSizeBytes: 1,
        }],
        ['non-monotonic timestamp', {
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 2,
            timestampMs: 900,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: 'AQ==',
            payloadSizeBytes: 1,
        }],
        ['unsupported codec', {
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 3,
            timestampMs: 1_100,
            codecId: 'vp9',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: 'AQ==',
            payloadSizeBytes: 1,
        }],
        ['unsupported payload encoding', {
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 4,
            timestampMs: 1_200,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'utf8',
            payloadBase64: 'AQ==',
            payloadSizeBytes: 1,
        }],
        ['oversize payload', {
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 5,
            timestampMs: 1_300,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
            payloadSizeBytes: 3,
        }],
        ['unknown message kind', { v: 1, kind: 'ready' }],
        ['unknown command ack', {
            v: 1,
            kind: 'control_ack',
            commandId: 'cmd-missing',
            status: 'accepted',
        }],
    ])('rejects %s fail-closed', async (_name, message) => {
        const {
            createIosSimulatorHelperMessageParser,
        } = await import('./helperProtocol');
        const parser = createIosSimulatorHelperMessageParser({
            maxPayloadBytes: 2,
            knownCommandIds: new Set(['cmd-known']),
        });

        expect(parser.parse({
            v: 1,
            kind: 'frame',
            streamId: 'stream-1',
            sourceId: 'ios-simulator:A1B2-C3D4:screen',
            sequence: 1,
            timestampMs: 1_000,
            codecId: 'image.mjpeg',
            payloadKind: 'image_keyframe',
            payloadEncoding: 'binary_base64',
            payloadBase64: 'AQ==',
            payloadSizeBytes: 1,
        })).toMatchObject({ ok: true });
        expect(parser.parse(message)).toMatchObject({ ok: false });
    });

    it('serializes supported helper controls and sends them through one canonical writer', async () => {
        const {
            createIosSimulatorHelperCommandSender,
        } = await import('./helperProtocol');
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
        const sender = createIosSimulatorHelperCommandSender({
            supportedInputKinds: ['tap', 'long_press', 'swipe', 'drag', 'keyboard_text', 'keyboard_key', 'hardware_button', 'orientation'],
            writeCommand,
        });

        await expect(sender({
            ...baseControl,
            kind: 'tap',
            x: 0.4,
            y: 0.6,
        })).resolves.toEqual({ ok: true, diagnostics: [] });

        expect(writeCommand).toHaveBeenCalledWith({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-1',
            target: {
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                simulatorId: 'A1B2-C3D4',
            },
            control: {
                v: 1,
                kind: 'tap',
                streamId: 'stream-1',
                sourceId: 'ios-simulator:A1B2-C3D4:screen',
                eventId: 'event-1',
                x: 0.4,
                y: 0.6,
            },
        });
    });

    it('rejects unsupported or unsafe helper controls before writing to the helper', async () => {
        const {
            createIosSimulatorHelperCommandSender,
        } = await import('./helperProtocol');
        const writeCommand = vi.fn();
        const sender = createIosSimulatorHelperCommandSender({
            supportedInputKinds: ['tap', 'keyboard_text'],
            writeCommand,
        });

        await expect(sender({
            ...baseControl,
            kind: 'pinch',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 0.1,
            endDistance: 0.2,
        })).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_simulator_control_unsupported',
        });

        await expect(sender({
            ...baseControl,
            sourceId: 'ios-simulator::screen',
            kind: 'tap',
            x: 0.1,
            y: 0.2,
        })).resolves.toMatchObject({
            ok: false,
            status: 'rejected',
            reasonCode: 'invalid_ios_simulator_source',
        });

        await expect(sender({
            ...baseControl,
            kind: 'keyboard_text',
            text: 'unsafe\u0000text',
        })).resolves.toMatchObject({
            ok: false,
            status: 'rejected',
            reasonCode: 'ios_simulator_keyboard_text_rejected',
        });

        expect(writeCommand).not.toHaveBeenCalled();
    });
});
