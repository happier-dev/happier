import { describe, expect, it } from 'vitest';

import type { MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1, MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter } from './captureAdapter';

function keyframe(sequence = 1): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: 'AQID',
        payloadSizeBytes: 3,
    };
}

function startRequest(): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 32_000,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
        authorization: {
            payload: {
                v: 1,
                grantId: 'relay_grant_1',
                accountId: 'account_1',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                flowKind: 'live_stream',
                routeKind: 'server_relay',
                streamId: 'stream_1',
                streamFamily: 'screen',
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
                iat: 1_000,
                exp: 61_000,
                aud: 'happier-live-stream-relay-authorization',
            },
            signature: {
                keyId: 'relay_key_1',
                alg: 'Ed25519',
                valueBase64Url: 'AbCdEf012_-',
            },
        },
    };
}

describe('createMachineLiveStreamRelayTerminator', () => {
    it('starts a server-relayed capture source and emits start and frame envelopes', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const adapter: MachineLiveStreamCaptureAdapter = {
            start: async (input) => {
                input.offerFrame(keyframe(1));
                return { ok: true, session: { stop: () => undefined } };
            },
        };
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter,
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 12,
                inputMode: 'exclusive',
                sidebands: [],
                health: { status: 'available' },
            },
        });

        const terminator = relayMod.createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            registry,
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame']);
        expect(emitted[1]).toMatchObject({
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            message: {
                kind: 'frame',
                frame: { sequence: 1 },
            },
        });
    });

    it('fails closed when the requested stream family has no registered capture source', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const terminator = relayMod.createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            registry: registryMod.createMachineLiveStreamCaptureRegistry(),
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: false,
            reasonCode: 'capture_source_unavailable',
        });
    });

    it('does not emit relay start or frames when capture startup fails', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    input.offerFrame(keyframe(1));
                    return { ok: false, reasonCode: 'capture_start_failed' };
                },
            },
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 12,
                inputMode: 'exclusive',
                sidebands: [],
                health: { status: 'available' },
            },
        });

        const terminator = relayMod.createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            registry,
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: false,
            reasonCode: 'capture_start_failed',
        });
        expect(emitted).toEqual([]);
    });

    it('rejects duplicate active stream starts without replacing the existing capture session', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        let stopCount = 0;
        let startCount = 0;
        const adapter: MachineLiveStreamCaptureAdapter = {
            start: async () => {
                startCount += 1;
                return { ok: true, session: { stop: () => { stopCount += 1; } } };
            },
        };
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter,
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 12,
                inputMode: 'exclusive',
                sidebands: [],
                health: { status: 'available' },
            },
        });

        const terminator = relayMod.createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            registry,
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });
        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: false,
            reasonCode: 'duplicate_stream_id',
        });
        expect(startCount).toBe(1);
        expect(stopCount).toBe(0);
    });

    it('dispatches typed input sideband control to the active capture session', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const appliedControls: unknown[] = [];
        const adapter = {
            start: async () => ({
                ok: true as const,
                session: {
                    stop: () => undefined,
                    applySidebandControl: (control: unknown) => {
                        appliedControls.push(control);
                        return { ok: true as const };
                    },
                },
            }),
        };
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter,
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 12,
                inputMode: 'exclusive',
                sidebands: [],
                health: { status: 'available' },
            },
        });

        const terminator = relayMod.createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            registry,
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });

        await terminator.start(startRequest());
        expect(terminator.applyControl({
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            message: {
                kind: 'sideband_control',
                control: {
                    v: 1,
                    streamId: 'stream_1',
                    sourceId: 'source_1',
                    eventId: 'event_1',
                    leaseId: 'lease_1',
                    kind: 'tap',
                    x: 0.5,
                    y: 0.5,
                },
            },
        } as Parameters<typeof terminator.applyControl>[0])).toEqual({ ok: true });
        expect(appliedControls).toEqual([expect.objectContaining({ kind: 'tap', eventId: 'event_1' })]);
    });
});
