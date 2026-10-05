import { describe, expect, it, vi } from 'vitest';

import {
    MachineLiveStreamReceiptV1Schema,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamReceiptV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter, MachineLiveStreamCaptureStartInput, MachineLiveStreamCaptureStartResult } from './captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from './captureRegistry';
import { createMachineLiveStreamRelayTerminator } from './relay';

// Keep the existing test bodies concise while avoiding repeated dynamic
// imports. Under shared executor load those imports can each consume a test's
// complete timeout before any behavior is exercised.
const registryMod = Object.freeze({ createMachineLiveStreamCaptureRegistry });
const relayMod = Object.freeze({ createMachineLiveStreamRelayTerminator });

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
    it('refuses a replaced source occurrence and stops a live capture when its exact source retires', async () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        let captureInput: MachineLiveStreamCaptureStartInput | null = null;
        let stopped = false;
        const register = () => registry.register({ sourceId: 'source_1', streamFamily: 'screen',
            capabilities: { v: 1, sourceId: 'source_1', sourceKind: 'screen', supportedCodecs: ['image.mjpeg'],
                inputMode: 'none', sidebands: [], health: { status: 'available' } },
            adapter: { async start(input) { captureInput = input; return { ok: true, session: { stop() { stopped = true; } } }; } },
        });
        register();
        const original = registry.resolve({ sourceId: 'source_1' });
        if (!original.ok) throw new Error('missing registered source');
        const request = startRequest();
        request.sourceId = 'source_1';
        request.sourceOccurrenceId = original.source.sourceOccurrenceId;
        request.authorization!.payload.sourceId = 'source_1';
        register();
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({ machineId: 'machine_source', registry,
            nowMs: () => 1_000, emitEnvelope: envelope => emitted.push(envelope) });
        expect(await terminator.start(request)).toEqual({ ok: false, reasonCode: 'capture_source_unavailable' });
        expect(captureInput).toBeNull();
        const current = registry.resolve({ sourceId: 'source_1' });
        if (!current.ok) throw new Error('missing replacement');
        request.sourceOccurrenceId = current.source.sourceOccurrenceId;
        expect(await terminator.start(request)).toEqual({ ok: true, streamId: 'stream_1' });
        registry.unregister('source_1');
        expect(stopped).toBe(true);
        const activeInput = captureInput as MachineLiveStreamCaptureStartInput | null;
        expect(activeInput?.offerFrame(keyframe())).toMatchObject({ ok: false });
        expect(emitted.some(envelope => envelope.message.kind === 'receipt'
            && MachineLiveStreamReceiptV1Schema.parse(envelope.message.receipt).terminal === true)).toBe(true);
        await terminator.dispose();
    });
    it('refuses a signed renewal that changes the exact capture source', async () => {
        const request = startRequest();
        request.sourceId = 'source_1';
        request.authorization!.payload.sourceId = 'source_1';
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async () => ({ ok: true, session: { stop: () => undefined } }) },
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });
        await terminator.start(request);
        expect(terminator.applyControl({
            v: 1, sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
            message: { kind: 'renew', startRequest: {
                ...request, sourceId: 'source_2',
                authorization: { ...request.authorization!, payload: {
                    ...request.authorization!.payload, sourceId: 'source_2', exp: 121_000,
                } },
            } },
        })).toEqual({ ok: false, reasonCode: 'renewal_scope_mismatch' });
        await terminator.dispose();
    });

    it('selects the exact signed capture source when a family has multiple views', async () => {
        const registry = createMachineLiveStreamCaptureRegistry();
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        for (const [sourceId, payloadBase64] of [['source_1', 'AQID'], ['source_2', 'BAUG']] as const) {
            registry.register({
                sourceId, streamFamily: 'screen',
                adapter: { start: async (input) => {
                    input.offerFrame({ ...keyframe(), payloadBase64 });
                    return { ok: true, session: { stop: () => undefined } };
                } },
                capabilities: { v: 1, sourceId, sourceKind: 'screen', supportedCodecs: ['image.mjpeg'],
                    maxFramesPerSecond: 12, inputMode: 'exclusive', sidebands: [], health: { status: 'available' } },
            });
        }
        const request = startRequest();
        request.sourceId = 'source_2';
        request.authorization!.payload.sourceId = 'source_2';
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source', registry, nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        expect(await terminator.start(request)).toEqual({ ok: true, streamId: 'stream_1' });
        expect(emitted).toContainEqual(expect.objectContaining({ message: {
            kind: 'frame', frame: expect.objectContaining({ payloadBase64: 'BAUG' }),
        } }));
        await terminator.dispose();
    });
    it.each(['stop', 'dispose'] as const)('stops a late capture after %s while startup is pending', async (action) => {
        let resolveCapture!: (value: MachineLiveStreamCaptureStartResult) => void;
        const stop = vi.fn();
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: () => new Promise((resolve) => { resolveCapture = resolve; }) },
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        const starting = terminator.start(startRequest());
        if (action === 'stop') await terminator.stop('stream_1');
        else await terminator.dispose();
        resolveCapture({ ok: true, session: { stop } });
        expect(await starting).toEqual({ ok: false, reasonCode: action === 'stop' ? 'stream_stopped' : 'relay_disposed' });
        expect(stop).toHaveBeenCalledOnce();
        expect(emitted.some((envelope) => envelope.message.kind === 'start')).toBe(false);
    });

    it('deduplicates pending starts in the same lifecycle map', async () => {
        let resolveCapture!: (value: MachineLiveStreamCaptureStartResult) => void;
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: () => new Promise((resolve) => { resolveCapture = resolve; }) },
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });
        const starting = terminator.start(startRequest());
        expect(await terminator.start(startRequest())).toEqual({ ok: false, reasonCode: 'duplicate_stream_id' });
        resolveCapture({ ok: true, session: { stop: () => undefined } });
        expect(await starting).toEqual({ ok: true, streamId: 'stream_1' });
        await terminator.dispose();
    });

    it('keeps a replacement stream independent from a stopped pending capture with the same id', async () => {
        let resolveFirst!: (value: MachineLiveStreamCaptureStartResult) => void;
        let firstInput!: MachineLiveStreamCaptureStartInput;
        let starts = 0;
        const firstStop = vi.fn();
        const secondStop = vi.fn();
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                starts += 1;
                if (starts === 1) {
                    firstInput = input;
                    return await new Promise((resolve) => { resolveFirst = resolve; });
                }
                return { ok: true, session: { stop: secondStop } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        const firstStart = terminator.start(startRequest());
        await terminator.stop('stream_1');
        expect(await terminator.start(startRequest())).toEqual({ ok: true, streamId: 'stream_1' });
        expect(firstInput.offerFrame(keyframe())).toEqual({ ok: false, reasonCode: 'stream_closed' });
        resolveFirst({ ok: true, session: { stop: firstStop } });
        expect(await firstStart).toEqual({ ok: false, reasonCode: 'stream_stopped' });
        expect(firstStop).toHaveBeenCalledOnce();
        expect(secondStop).not.toHaveBeenCalled();
        expect(emitted.filter((envelope) => envelope.message.kind === 'start')).toHaveLength(1);
        await terminator.dispose();
        expect(secondStop).toHaveBeenCalledOnce();
    });

    it('enforces grant expiry for idle capture and emits one terminal receipt', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const stop = vi.fn();
            const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
            const terminator = createMachineLiveStreamRelayTerminator({
                machineId: 'machine_source',
                captureAdapter: { start: async () => ({ ok: true, session: { stop } }) },
                nowMs: () => Date.now(),
                emitEnvelope: (envelope) => emitted.push(envelope),
            });
            await terminator.start(startRequest());
            await vi.advanceTimersByTimeAsync(60_000);
            expect(stop).toHaveBeenCalledOnce();
            expect(emitted.filter((envelope) => envelope.message.kind === 'receipt')).toEqual([
                expect.objectContaining({ message: { kind: 'receipt', receipt: expect.objectContaining({ terminal: true, reasonCode: 'grant_expired' }) } }),
            ]);
            await terminator.dispose();
            expect(stop).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });

    it('renews only identical active grant scope and caps, extending expiry without replacing capture or lifetime', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000);
            const stop = vi.fn();
            let starts = 0;
            const request = startRequest();
            request.maxDurationMs = 120_000;
            request.authorization!.payload.maxDurationMs = 120_000;
            const terminator = createMachineLiveStreamRelayTerminator({
                machineId: 'machine_source',
                captureAdapter: { start: async () => { starts += 1; return { ok: true, session: { stop } }; } },
                nowMs: () => Date.now(),
                emitEnvelope: () => undefined,
            });
            await terminator.start(request);
            await vi.advanceTimersByTimeAsync(30_000);
            const renewed = {
                ...request,
                authorization: { ...request.authorization!, payload: { ...request.authorization!.payload, grantId: 'grant_renewed', iat: 31_000, exp: 181_000 } },
            };
            const renewal = (next: MachineLiveStreamStartRequestV1): MachineLiveStreamRelayEnvelopeV1 => ({
                v: 1, sourceMachineId: request.sourceMachineId, targetMachineId: request.targetMachineId,
                message: { kind: 'renew', startRequest: next },
            });
            expect(terminator.applyControl(renewal({ ...renewed, targetMachineId: 'other_machine' }))).toEqual({ ok: false, reasonCode: 'renewal_scope_mismatch' });
            expect(terminator.applyControl(renewal({ ...renewed, maxFrameBytes: 1 }))).toEqual({ ok: false, reasonCode: 'renewal_scope_mismatch' });
            expect(terminator.applyControl(renewal(renewed))).toEqual({ ok: true });
            expect(terminator.applyControl(renewal(renewed))).toEqual({ ok: false, reasonCode: 'renewal_expiry_not_extended' });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(stop).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(stop).toHaveBeenCalledOnce();
            expect(starts).toBe(1);
            await terminator.dispose();
        } finally { vi.useRealTimers(); }
    });

    it('keeps transient paused receipts active and routes transport pause, resume and keyframe controls to capture', async () => {
        let captureInput!: MachineLiveStreamCaptureStartInput;
        const controls: unknown[] = [];
        const stop = vi.fn();
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                captureInput = input;
                input.offerFrame(keyframe(1));
                return { ok: true, session: { stop, applyControl: (control) => { controls.push(control); return { ok: true }; } } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });
        await terminator.start(startRequest());
        captureInput.emitReceipt({ v: 1, id: 'peer.stream.paused', streamId: 'stream_1', routeKind: 'server_relay', flowKind: 'live_stream', reasonCode: 'backpressure_window_exhausted' });
        for (const control of [
            { v: 1 as const, streamId: 'stream_1', kind: 'pause' as const, reasonCode: 'backpressure_window_exhausted' },
            { v: 1 as const, streamId: 'stream_1', kind: 'resume' as const },
            { v: 1 as const, streamId: 'stream_1', kind: 'keyframe_required' as const, reasonCode: 'startup_keyframe_required' },
        ]) {
            expect(terminator.applyControl({ v: 1, sourceMachineId: 'machine_source', targetMachineId: 'machine_target', message: { kind: 'control', control } })).toEqual({ ok: true });
        }
        expect(controls).toHaveLength(3);
        expect(stop).not.toHaveBeenCalled();
        await terminator.dispose();
    });

    it('requests a fresh keyframe when startup only produced dependent deltas', async () => {
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const controls: unknown[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                input.offerFrame({ ...keyframe(1), payloadKind: 'image_delta' });
                return { ok: true, session: { stop: () => undefined, applyControl: (control) => { controls.push(control); return { ok: true }; } } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        await terminator.start(startRequest());
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start']);
        expect(controls).toEqual([expect.objectContaining({ kind: 'keyframe_required' })]);
        await terminator.dispose();
    });

    it('withholds dependent frames after dropping startup deltas until a fresh keyframe arrives', async () => {
        let captureInput!: MachineLiveStreamCaptureStartInput;
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const controls: unknown[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                captureInput = input;
                input.offerFrame(keyframe(1));
                input.offerFrame({ ...keyframe(2), payloadKind: 'image_delta' });
                input.offerFrame({ ...keyframe(3), payloadKind: 'image_delta' });
                return { ok: true, session: { stop: () => undefined, applyControl: (control) => { controls.push(control); return { ok: true }; } } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        await terminator.start(startRequest());
        expect(captureInput.offerFrame({ ...keyframe(4), payloadKind: 'image_delta' })).toEqual({ ok: true });
        expect(captureInput.offerFrame(keyframe(5))).toEqual({ ok: true });
        expect(captureInput.offerFrame({ ...keyframe(6), payloadKind: 'image_delta' })).toEqual({ ok: true });
        expect(emitted.flatMap((envelope) => envelope.message.kind === 'frame' ? [envelope.message.frame.sequence] : [])).toEqual([1, 5, 6]);
        expect(controls).toEqual([expect.objectContaining({ kind: 'keyframe_required' })]);
        await terminator.dispose();
    });

    it('cleans pending startup after a terminal receipt before capture resolves', async () => {
        const stop = vi.fn();
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                input.emitReceipt({ v: 1, id: 'peer.stream.paused', streamId: 'stream_1', routeKind: 'server_relay', flowKind: 'live_stream', reasonCode: 'capture_failed', terminal: true, terminalOutcome: 'error' });
                return { ok: true, session: { stop } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: () => undefined,
        });
        expect(await terminator.start(startRequest())).toEqual({ ok: false, reasonCode: 'capture_failed' });
        expect(stop).toHaveBeenCalledOnce();
        await terminator.dispose();
    });

    it('closes active capture on frame pump cap failure and rejects later source frames', async () => {
        let captureInput!: MachineLiveStreamCaptureStartInput;
        const stop = vi.fn();
        const emitted: MachineLiveStreamRelayEnvelopeV1[] = [];
        const terminator = createMachineLiveStreamRelayTerminator({
            machineId: 'machine_source',
            captureAdapter: { start: async (input) => {
                captureInput = input;
                return { ok: true, session: { stop } };
            } },
            nowMs: () => 1_000,
            emitEnvelope: (envelope) => emitted.push(envelope),
        });
        const request = startRequest();
        request.maxFrameBytes = 2;
        request.authorization!.payload.maxFrameBytes = 2;
        await terminator.start(request);
        expect(captureInput.offerFrame(keyframe())).toEqual({ ok: false, reasonCode: 'max_frame_bytes_exceeded' });
        await Promise.resolve();
        expect(stop).toHaveBeenCalledOnce();
        expect(captureInput.offerFrame(keyframe())).toEqual({ ok: false, reasonCode: 'stream_closed' });
        expect(emitted.filter((envelope) => envelope.message.kind === 'receipt')).toHaveLength(1);
        await terminator.dispose();
    });
    it('echoes the signed start viewerSocketId onto the start and frame envelopes for per-tab delivery', async () => {
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
        expect(emitted).toEqual([expect.objectContaining({ message: {
            kind: 'receipt', receipt: expect.objectContaining({ terminal: true, terminalOutcome: 'error', reasonCode: 'capture_start_failed' }),
        } })]);
    });

    it('rejects duplicate active stream starts without replacing the existing capture session', async () => {
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

    it('retains the latest independently decodable observation before capture startup resolves', async () => {
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
        expect(emittedFrames).toEqual([expect.objectContaining({ message: { kind: 'frame', frame: keyframe(64) } })]);
        expect(emitted[0]?.message.kind).toBe('start');
    });

    it('emits redacted observability lifecycle events for accepted live-stream relays', async () => {
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
        expect(emitted.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame', 'receipt']);
    });

    it('reports a clean end-of-stream paused receipt as flow.closed, not flow.errored', async () => {
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
            terminal: true,
            terminalOutcome: 'stopped',
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        });

        await vi.waitFor(() => {
            expect(stop).toHaveBeenCalledTimes(1);
            expect(observabilityEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'flow.closed' })]));
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
            terminal: true,
            terminalOutcome: 'error',
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
            terminal: true,
            terminalOutcome: 'error',
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
