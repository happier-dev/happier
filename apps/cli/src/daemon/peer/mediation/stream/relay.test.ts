import { describe, expect, it, vi } from 'vitest';

import type {
    MachineLiveStreamFrameV1,
    MachineLiveStreamReceiptV1,
    MachineLiveStreamRelayEnvelopeV1,
    MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

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

function startRequestWithViewerSocket(viewerSocketId: string): MachineLiveStreamStartRequestV1 {
    const base = startRequest();
    return {
        ...base,
        viewerSocketId,
        authorization: base.authorization
            ? {
                ...base.authorization,
                payload: { ...base.authorization.payload, viewerSocketId },
            }
            : base.authorization,
    };
}

describe('createMachineLiveStreamRelayTerminator', () => {
    it('echoes the signed start viewerSocketId onto the start and frame envelopes for per-tab delivery', async () => {
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

        await expect(terminator.start(startRequestWithViewerSocket('viewer-socket-7'))).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });
        // Without the echo, frame/start envelopes carry no viewerSocketId and the server relay's
        // envelope-keyed delivery paths fall back to the shared user room instead of the exact tab.
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame']);
        for (const envelope of emitted) {
            expect(envelope.viewerSocketId).toBe('viewer-socket-7');
        }
    });

    it('omits viewerSocketId on the legacy machine→machine path (no viewer target in the start)', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    input.offerFrame(keyframe(1));
                    return { ok: true, session: { stop: () => undefined } };
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

        await terminator.start(startRequest());
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame']);
        for (const envelope of emitted) {
            expect(envelope.viewerSocketId).toBeUndefined();
        }
    });

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

    it('rejects typed input sideband control without an active lease before capture dispatch', async () => {
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
        } as Parameters<typeof terminator.applyControl>[0])).toEqual({
            ok: false,
            reasonCode: 'input_lease_required',
        });
        expect(appliedControls).toEqual([]);
    });

    it('dispatches typed input sideband control to the active capture session with a matching active lease', async () => {
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
            nowMs: () => 1_100,
            emitEnvelope: () => undefined,
            readActiveControlLease: ({ streamId, sourceId }) => ({
                v: 1,
                leaseId: 'lease_1',
                streamId,
                sourceId,
                holderId: 'viewer_1',
                mode: 'exclusive',
                acquiredAtMs: 1_000,
                expiresAtMs: 2_000,
            }),
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

    it('allows non-input sideband control without an active lease', async () => {
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
                    kind: 'request_keyframe',
                },
            },
        } as Parameters<typeof terminator.applyControl>[0])).toEqual({ ok: true });
        expect(appliedControls).toEqual([expect.objectContaining({ kind: 'request_keyframe', eventId: 'event_1' })]);
    });

    it('closes the active capture session when a viewer stop control reaches the terminator', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const stop = vi.fn(async () => undefined);
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async () => ({ ok: true, session: { stop } }),
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
            emitEnvelope: () => undefined,
        });

        await expect(terminator.start(startRequestWithViewerSocket('viewer-socket-1'))).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });
        expect(terminator.applyControl({
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            viewerSocketId: 'viewer-socket-1',
            message: {
                kind: 'control',
                control: { v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'viewer_closed' },
            },
        })).toEqual({ ok: true });
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(terminator.applyControl({
            v: 1,
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            viewerSocketId: 'viewer-socket-1',
            message: {
                kind: 'control',
                control: { v: 1, streamId: 'stream_1', kind: 'stop', reasonCode: 'viewer_closed' },
            },
        })).toEqual({ ok: false, reasonCode: 'live_stream_start_required' });
    });

    it('bounds frame envelopes produced before capture startup resolves', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const base = startRequest();
        const manyFrameStartRequest: MachineLiveStreamStartRequestV1 = {
            ...base,
            maxBitrateBps: 64_000_000,
            maxFramesPerSecond: 120,
            maxFrameBytes: 32_000,
            maxTotalBytes: 128_000_000,
            authorization: base.authorization
                ? {
                    ...base.authorization,
                    payload: {
                        ...base.authorization.payload,
                        maxBitrateBps: 64_000_000,
                        maxFramesPerSecond: 120,
                        maxFrameBytes: 32_000,
                        maxTotalBytes: 128_000_000,
                    },
                }
                : base.authorization,
        };
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    for (let sequence = 1; sequence <= 64; sequence += 1) {
                        input.offerFrame(keyframe(sequence));
                    }
                    return { ok: true, session: { stop: () => undefined } };
                },
            },
            capabilities: {
                v: 1,
                sourceId: 'source_1',
                sourceKind: 'screen',
                supportedCodecs: ['image.mjpeg'],
                maxFramesPerSecond: 120,
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

        await expect(terminator.start(manyFrameStartRequest)).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });

        const emittedFrames = emitted.filter((envelope) => envelope.message.kind === 'frame');
        expect(emittedFrames.length).toBeLessThanOrEqual(32);
        expect(emitted[0]?.message.kind).toBe('start');
    });

    it('emits redacted observability lifecycle events for accepted live-stream relays', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const observabilityEvents: unknown[] = [];
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
            observability: {
                emit: (event) => observabilityEvents.push(event),
            },
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });
        await terminator.stop('stream_1');

        expect(observabilityEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.ready',
                flow: expect.objectContaining({ flowKind: 'live_stream', flowId: 'stream_1' }),
            }),
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowKind: 'live_stream', flowId: 'stream_1' }),
            }),
        ]));
        const serialized = JSON.stringify(observabilityEvents);
        expect(serialized).not.toContain('AQID');
        expect(serialized).not.toContain('relay_grant_1');
        expect(serialized).toContain('grant_');
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame']);
    });

    it('reports a clean end-of-stream paused receipt as flow.closed, not flow.errored', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        let emitFatalReceipt: (receipt: MachineLiveStreamReceiptV1) => void = () => {
            throw new Error('receipt emitter was not initialized');
        };
        const stop = vi.fn();
        const applySidebandControl = vi.fn(() => ({ ok: true as const }));
        const observabilityEvents: unknown[] = [];
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    emitFatalReceipt = input.emitReceipt;
                    input.offerFrame(keyframe(1));
                    return {
                        ok: true as const,
                        session: { stop, applySidebandControl },
                    };
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
            observability: {
                emit: (event) => observabilityEvents.push(event),
            },
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });

        emitFatalReceipt({
            v: 1,
            id: 'peer.stream.paused',
            streamId: 'stream_1',
            routeKind: 'server_relay',
            flowKind: 'live_stream',
            reasonCode: 'android_scrcpy_raw_stream_ended',
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        });

        await vi.waitFor(() => {
            expect(stop).toHaveBeenCalledTimes(1);
        });
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
                    eventId: 'event_after_failure',
                    leaseId: 'lease_1',
                    kind: 'tap',
                    x: 0.5,
                    y: 0.5,
                },
            },
        } as Parameters<typeof terminator.applyControl>[0])).toEqual({
            ok: false,
            reasonCode: 'live_stream_start_required',
        });
        expect(applySidebandControl).not.toHaveBeenCalled();
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame', 'receipt']);
        expect(observabilityEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'flow.closed',
                flow: expect.objectContaining({ flowId: 'stream_1', flowKind: 'live_stream' }),
                data: expect.objectContaining({ reasonCode: 'android_scrcpy_raw_stream_ended' }),
            }),
        ]));
        const closeKinds = (observabilityEvents as Array<{ kind?: unknown }>)
            .map((event) => event.kind)
            .filter((kind) => kind === 'flow.closed' || kind === 'flow.errored' || kind === 'flow.aborted');
        expect(closeKinds).toEqual(['flow.closed']);
    });

    it('reports a capture cap breach receipt as flow.errored with its distinct reason code', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        let emitTerminalReceipt: (receipt: MachineLiveStreamReceiptV1) => void = () => {
            throw new Error('receipt emitter was not initialized');
        };
        const observabilityEvents: unknown[] = [];
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    emitTerminalReceipt = input.emitReceipt;
                    input.offerFrame(keyframe(1));
                    return { ok: true as const, session: { stop: vi.fn() } };
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
            emitEnvelope: () => undefined,
            observability: {
                emit: (event) => observabilityEvents.push(event),
            },
        });

        await terminator.start(startRequest());
        emitTerminalReceipt({
            v: 1,
            id: 'peer.stream.bandwidth_capped',
            streamId: 'stream_1',
            routeKind: 'server_relay',
            flowKind: 'live_stream',
            reasonCode: 'max_total_bytes_exceeded',
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        });

        await vi.waitFor(() => {
            expect(observabilityEvents).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'flow.errored',
                    flow: expect.objectContaining({ flowId: 'stream_1', flowKind: 'live_stream' }),
                    data: expect.objectContaining({ reasonCode: 'max_total_bytes_exceeded' }),
                }),
            ]));
        });
    });

    it('reports an upstream source-abort receipt as flow.aborted with its distinct reason code', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        let emitTerminalReceipt: (receipt: MachineLiveStreamReceiptV1) => void = () => {
            throw new Error('receipt emitter was not initialized');
        };
        const observabilityEvents: unknown[] = [];
        const registry = registryMod.createMachineLiveStreamCaptureRegistry();
        registry.register({
            sourceId: 'source_1',
            streamFamily: 'screen',
            adapter: {
                start: async (input) => {
                    emitTerminalReceipt = input.emitReceipt;
                    input.offerFrame(keyframe(1));
                    return { ok: true as const, session: { stop: vi.fn() } };
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
            emitEnvelope: () => undefined,
            observability: {
                emit: (event) => observabilityEvents.push(event),
            },
        });

        await terminator.start(startRequest());
        emitTerminalReceipt({
            v: 1,
            id: 'peer.stream.paused',
            streamId: 'stream_1',
            routeKind: 'server_relay',
            flowKind: 'live_stream',
            reasonCode: 'android_scrcpy_raw_stream_unavailable',
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        });

        await vi.waitFor(() => {
            expect(observabilityEvents).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'flow.aborted',
                    flow: expect.objectContaining({ flowId: 'stream_1', flowKind: 'live_stream' }),
                    data: expect.objectContaining({ reasonCode: 'android_scrcpy_raw_stream_unavailable' }),
                }),
            ]));
        });
    });

    it('emits flow.started before flow.ready on an accepted live-stream relay', async () => {
        const registryMod = await import('./captureRegistry').catch((error: unknown) => ({ importError: error }));
        const relayMod = await import('./relay').catch((error: unknown) => ({ importError: error }));

        expect(registryMod).toHaveProperty('createMachineLiveStreamCaptureRegistry');
        expect(relayMod).toHaveProperty('createMachineLiveStreamRelayTerminator');
        if (!('createMachineLiveStreamCaptureRegistry' in registryMod) || !('createMachineLiveStreamRelayTerminator' in relayMod)) return;

        const observabilityEvents: Array<{ kind?: unknown }> = [];
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
            emitEnvelope: () => undefined,
            observability: {
                emit: (event) => observabilityEvents.push(event),
            },
        });

        await expect(terminator.start(startRequest())).resolves.toEqual({
            ok: true,
            streamId: 'stream_1',
        });

        const lifecycle = observabilityEvents
            .map((event) => event.kind)
            .filter((kind) => kind === 'flow.started' || kind === 'flow.ready');
        expect(lifecycle).toEqual(['flow.started', 'flow.ready']);
    });
});
