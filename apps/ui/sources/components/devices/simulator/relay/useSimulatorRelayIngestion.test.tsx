import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Platform } from 'react-native';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import {
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

import {
    useSimulatorRelayIngestion,
    type SimulatorRelayTransport,
    type UseSimulatorRelayIngestionInput,
} from './useSimulatorRelayIngestion';

const STREAM_ID = 'stream_1';
const SOURCE = 'machine_source';
const TARGET = 'machine_target';
const SIMULATOR_ID = 'sim_1';
const platformOsDescriptor = Object.getOwnPropertyDescriptor(Platform, 'OS');

const caps: MachineLiveStreamCapsV1 = {
    maxBitrateBps: 64_000,
    maxFramesPerSecond: 12,
    maxFrameBytes: 32_000,
    maxDurationMs: 60_000,
    maxTotalBytes: 128_000,
};

function startRequest(): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: STREAM_ID,
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: SOURCE,
        targetMachineId: TARGET,
        maxBitrateBps: caps.maxBitrateBps,
        maxFramesPerSecond: caps.maxFramesPerSecond,
        maxFrameBytes: caps.maxFrameBytes,
        maxDurationMs: caps.maxDurationMs,
        maxTotalBytes: caps.maxTotalBytes,
        authorization: {
            payload: {
                v: 1,
                grantId: 'relay_grant_1',
                accountId: 'account_1',
                sourceMachineId: SOURCE,
                targetMachineId: TARGET,
                flowKind: 'live_stream',
                routeKind: 'server_relay',
                streamId: STREAM_ID,
                streamFamily: 'screen',
                maxBitrateBps: caps.maxBitrateBps,
                maxFramesPerSecond: caps.maxFramesPerSecond,
                maxFrameBytes: caps.maxFrameBytes,
                maxDurationMs: caps.maxDurationMs,
                maxTotalBytes: caps.maxTotalBytes,
                iat: Date.now(),
                exp: Date.now() + 60_000,
                aud: 'happier-live-stream-relay-authorization',
            },
            signature: { keyId: 'relay_key_1', alg: 'Ed25519', valueBase64Url: 'AbCdEf012_-' },
        },
    };
}

function frameEnvelope(
    frame: MachineLiveStreamFrameV1,
    options?: Readonly<{ sourceMachineId?: string; targetMachineId?: string }>,
): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: options?.sourceMachineId ?? SOURCE,
        targetMachineId: options?.targetMachineId ?? TARGET,
        message: { kind: 'frame', frame },
    };
}

function imageFrame(
    sequence: number,
    options?: Readonly<{ streamId?: string; payloadBase64?: string }>,
): MachineLiveStreamFrameV1 {
    return {
        v: 1,
        streamId: options?.streamId ?? STREAM_ID,
        sequence,
        timestampMs: 1_000 + sequence,
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: options?.payloadBase64 ?? 'AQID',
        payloadSizeBytes: 3,
    };
}

function createFakeTransport(): {
    transport: SimulatorRelayTransport;
    sent: MachineLiveStreamRelayEnvelopeV1[];
    deliver: (envelope: unknown) => void;
    listenerCount: () => number;
} {
    const sent: MachineLiveStreamRelayEnvelopeV1[] = [];
    const listeners = new Set<(envelope: unknown) => void>();
    return {
        sent,
        deliver: (envelope) => {
            for (const listener of [...listeners]) listener(envelope);
        },
        listenerCount: () => listeners.size,
        transport: {
            send: (_event, envelope) => {
                sent.push(envelope);
            },
            onEnvelope: (listener) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
    };
}

function baseInput(transport: SimulatorRelayTransport): UseSimulatorRelayIngestionInput {
    return {
        enabled: true,
        transport,
        serverId: 'server-a',
        sourceMachineId: SOURCE,
        targetMachineId: TARGET,
        simulatorId: SIMULATOR_ID,
        streamId: STREAM_ID,
        streamFamily: 'screen',
        caps,
        sourceCodecs: ['image.mjpeg'],
        startProduction: async (input) => input.routeKind === 'loopback_direct'
            ? { ok: false, reasonCode: 'topology_unavailable' }
            : {
                ok: true,
                routeKind: 'server_relay',
                startRequest: startRequest(),
                relayAuthorization: startRequest().authorization!,
            },
        startDaemonRelay: async (input) => ({ ok: true, streamId: input.startRequest.streamId }),
    };
}

describe('useSimulatorRelayIngestion', () => {
    afterEach(() => {
        vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
        if (platformOsDescriptor) Object.defineProperty(Platform, 'OS', platformOsDescriptor);
    });

    it('ingests a local transport frame without minting credentials and stops it on teardown', async () => {
        const fake = createFakeTransport();
        const input: UseSimulatorRelayIngestionInput = {
            ...baseInput(fake.transport),
            openRelay: async ({ streamId }) => {
                fake.deliver(frameEnvelope(imageFrame(1)));
                return { ok: true, streamId };
            },
            startProduction: async () => { throw new Error('Local transport must not mint a relay grant'); },
        };
        const hook = await renderHook(() => useSimulatorRelayIngestion(input));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
        await hook.unmount();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.sent.some(envelope => envelope.message.kind === 'control' && envelope.message.control.kind === 'stop')).toBe(true);
    });

    it.each(['hide/show', 'retry'] as const)('orders a reused stream behind a delayed start and its final Stop: %s', async (transition) => {
        const fake = createFakeTransport();
        const live = new Set<string>();
        let finishFirst!: () => void;
        let starts = 0;
        const transport: SimulatorRelayTransport = {
            ...fake.transport,
            send: (event, envelope) => {
                fake.transport.send(event, envelope);
                if (envelope.message.kind === 'control' && envelope.message.control.kind === 'stop') {
                    live.delete(envelope.message.control.streamId);
                }
            },
        };
        const input: UseSimulatorRelayIngestionInput = {
            ...baseInput(transport),
            startDaemonRelay: async ({ startRequest }) => {
                starts += 1;
                live.add(startRequest.streamId);
                if (starts === 1) await new Promise<void>(resolve => { finishFirst = resolve; });
                return { ok: true, streamId: startRequest.streamId };
            },
        };
        const hook = await renderHook((props: UseSimulatorRelayIngestionInput) => useSimulatorRelayIngestion(props), { initialProps: input });
        expect(live.has(STREAM_ID)).toBe(true);
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        const held = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl;
        if (transition === 'hide/show') {
            await hook.rerender({ ...input, enabled: false });
            await hook.rerender(input);
        } else {
            await act(async () => hook.getCurrent().retry());
        }
        await act(async () => { finishFirst(); });
        // The daemon's Stop addresses the current entry by id, so a late Stop must
        // finish before a replacement with that id can become active.
        expect(live.has(STREAM_ID)).toBe(true);
        expect(starts).toBe(2);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toMatchObject({ phase: 'reconnecting', lastFrameUrl: held });
        await act(async () => fake.deliver(frameEnvelope(imageFrame(2, { payloadBase64: 'BAUG' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('playing');
        await hook.unmount();
        expect(live.size).toBe(0);
        expect(fake.listenerCount()).toBe(0);
    });

    it('retries the same source on its existing transport, retaining the frame until fresh pixels arrive', async () => {
        const fake = createFakeTransport();
        const openedSources: (string | undefined)[] = [];
        const input: UseSimulatorRelayIngestionInput = {
            ...baseInput(fake.transport),
            sourceId: 'computer-window-a',
            startProduction: async request => {
                openedSources.push(request.sourceId);
                const authorized = { ...startRequest(), sourceId: request.sourceId,
                    authorization: { ...startRequest().authorization!, payload: { ...startRequest().authorization!.payload, sourceId: request.sourceId } } };
                return { ok: true, routeKind: 'server_relay', startRequest: authorized, relayAuthorization: authorized.authorization! };
            },
        };
        const hook = await renderHook(() => useSimulatorRelayIngestion(input));
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        const held = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        await act(async () => fake.deliver({ v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET,
            message: { kind: 'control', control: { v: 1, streamId: STREAM_ID, kind: 'grant_refresh_denied', reasonCode: 'relay_disconnected' } } }));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('error');
        expect(hook.getCurrent().retry).toEqual(expect.any(Function));
        await act(async () => hook.getCurrent().retry());
        expect(openedSources).toEqual(['computer-window-a', 'computer-window-a']);
        expect(fake.listenerCount()).toBe(1);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toMatchObject({
            phase: 'reconnecting', lastFrameUrl: held?.lastFrameUrl, decodedFrames: held?.decodedFrames,
        });
        await act(async () => fake.deliver(frameEnvelope(imageFrame(2, { payloadBase64: 'BAUG' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toMatchObject({
            phase: 'playing', lastFrameUrl: 'data:image/jpeg;base64,BAUG',
        });
        await hook.unmount();
        expect(fake.listenerCount()).toBe(0);
    });

    it('opens and renews the exact signed capture source', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const fake = createFakeTransport();
        let captures = 0;
        const input = {
            ...baseInput(fake.transport),
            sourceId: 'browser-view-a',
            streamFamily: 'browser.streamed',
            startProduction: async (request: Parameters<NonNullable<UseSimulatorRelayIngestionInput['startProduction']>>[0]) => {
                if (request.sourceId !== 'browser-view-a') return { ok: false as const, reasonCode: 'capture_source_unavailable' };
                const initial = startRequest();
                const authorized = {
                    ...initial, streamFamily: request.streamFamily, sourceId: request.sourceId,
                    authorization: { ...initial.authorization!, payload: {
                        ...initial.authorization!.payload, streamFamily: request.streamFamily, sourceId: request.sourceId,
                    } },
                };
                return { ok: true as const, routeKind: 'server_relay' as const, startRequest: authorized, relayAuthorization: authorized.authorization };
            },
            startDaemonRelay: async () => { captures += 1; return { ok: true as const, streamId: STREAM_ID }; },
        };
        const hook = await renderHook(() => useSimulatorRelayIngestion(input));
        expect(captures).toBe(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(fake.sent).toContainEqual(expect.objectContaining({ message: {
            kind: 'renew', startRequest: expect.objectContaining({ sourceId: 'browser-view-a', streamFamily: 'browser.streamed' }),
        } }));
        expect(captures).toBe(1);
        await hook.unmount();
    });

    it('does not advertise H264 when the browser lacks the encoded chunk constructor', async () => {
        // Native/browser globals are the platform SDK boundary, not negotiation policy.
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.stubGlobal('VideoDecoder', class {});
        vi.stubGlobal('EncodedVideoChunk', undefined);
        const fake = createFakeTransport();
        const startDaemonRelay = vi.fn(baseInput(fake.transport).startDaemonRelay!);
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), sourceCodecs: ['h264.avcc'], startDaemonRelay,
        }));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('error');
        expect(startDaemonRelay).not.toHaveBeenCalled();
    });

    it('renews the signed stream grant without starting another capture and stops renewing after close', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const fake = createFakeTransport();
        let mints = 0;
        let captures = 0;
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), viewerSocketId: 'viewer-socket-1',
            startProduction: async () => {
                mints += 1;
                const request = startRequest();
                return { ok: true, routeKind: 'server_relay', startRequest: request, relayAuthorization: request.authorization! };
            },
            startDaemonRelay: async () => { captures += 1; return { ok: true, streamId: STREAM_ID }; },
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(mints).toBe(2);
        expect(captures).toBe(1);
        expect(fake.sent).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ kind: 'renew' }) }));
        await act(async () => fake.deliver({ v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET,
            message: { kind: 'control', control: { v: 1, streamId: STREAM_ID, kind: 'grant_expiring', expiresAtMs: 91_000 } } }));
        expect(mints).toBe(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
        expect(mints).toBe(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(mints).toBe(3);
        expect(captures).toBe(1);
        await hook.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(mints).toBe(3);
    });

    it('stops the exact stream when daemon start succeeds after unmount', async () => {
        const fake = createFakeTransport();
        let finishStart: ((result: { ok: true; streamId: string }) => void) | undefined;
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            viewerSocketId: 'viewer-socket-1',
            startDaemonRelay: () => new Promise((resolve) => { finishStart = resolve; }),
        }));
        await hook.unmount();
        expect(fake.sent.filter((value) => value.message.kind === 'control')).toHaveLength(1);
        await act(async () => { finishStart?.({ ok: true, streamId: STREAM_ID }); });
        expect(fake.sent.filter((value) => value.message.kind === 'control')).toHaveLength(2);
        expect(fake.sent.at(-1)).toMatchObject({
            sourceMachineId: SOURCE, targetMachineId: TARGET, viewerSocketId: 'viewer-socket-1',
            message: { kind: 'control', control: { kind: 'stop', streamId: STREAM_ID } },
        });
    });

    it('does not start capture when the viewer has no common codec', async () => {
        const fake = createFakeTransport();
        const startDaemonRelay = vi.fn(baseInput(fake.transport).startDaemonRelay!);
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), sourceCodecs: ['h264.avcc'],
            viewerCapabilities: { platform: 'native', renderers: ['mjpeg'], supportedCodecs: ['image.mjpeg'], degradedReasonCodes: [] },
            startDaemonRelay,
        }));
        expect(startDaemonRelay).not.toHaveBeenCalled();
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('error');
    });

    it('opens the relay client without emitting the retired viewer-socket start envelope', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion(baseInput(fake.transport)));

        expect(fake.sent).toEqual([]);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toBeDefined();
    });

    it.each(['before', 'after'] as const)('settles a server admission refusal %s the daemon start RPC completes', async (timing) => {
        const fake = createFakeTransport();
        let completeStart!: () => void;
        const startCompletion = new Promise<void>(resolve => { completeStart = resolve; });
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            startDaemonRelay: async () => {
                if (timing === 'before') await startCompletion;
                return { ok: true, streamId: STREAM_ID };
            },
        }));
        await act(async () => fake.deliver({ v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET,
            message: { kind: 'start_response', startResponse: { v: 1, streamId: STREAM_ID,
                accepted: false, routeKind: 'server_relay', disabledReason: 'live_stream_authorization_expired' } },
        }));
        await act(async () => { completeStart(); });
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toMatchObject({
            phase: 'error', decodedFrames: 0, diagnostic: { reasonCode: 'live_stream_authorization_expired' },
        });
        await hook.unmount();
    });

    it('advances H264 only after decoder output and never revives a terminal source', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), sourceCodecs: ['h264.avcc'],
            viewerCapabilities: { platform: 'web', renderers: ['webcodecs'], supportedCodecs: ['h264.avcc'], degradedReasonCodes: [] },
        }));
        await act(async () => fake.deliver(frameEnvelope({ ...imageFrame(1), codecId: 'h264.avcc',
            payloadBase64: 'AAAABWEAAAAB', payloadSizeBytes: 9 })));
        const pending = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        expect(pending?.phase).toBe('opening');
        expect(pending?.decodedFrames).toBe(0);
        expect(pending?.onFrameDecoded).toEqual(expect.any(Function));
        await act(async () => pending?.onFrameDecoded?.());
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('playing');
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.decodedFrames).toBe(1);
        await act(async () => fake.deliver({ v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET,
            message: { kind: 'control', control: { v: 1, streamId: STREAM_ID, kind: 'stop', reasonCode: 'capture_stopped' } } }));
        await act(async () => pending?.onFrameDecoded?.());
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.phase).toBe('stopped');
    });

    it('forwards the per-tab viewerSocketId to the relay client open (W1-C-2)', async () => {
        const fake = createFakeTransport();
        let openedViewerSocketId: string | null | undefined = 'unset';
        await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            viewerSocketId: 'viewer-socket-1',
            startProduction: async (input) => {
                openedViewerSocketId = input.viewerSocketId ?? null;
                return {
                    ok: true,
                    routeKind: 'server_relay',
                    startRequest: startRequest(),
                    relayAuthorization: startRequest().authorization!,
                };
            },
        }));

        expect(openedViewerSocketId).toBe('viewer-socket-1');
    });

    it('feeds incoming frames into the player state keyed by simulator id', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion(baseInput(fake.transport)));

        await act(async () => {
            fake.deliver(frameEnvelope(imageFrame(1)));
        });

        const stream = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        expect(stream?.phase).toBe('playing');
        expect(stream?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
        expect(stream?.decodedFrames).toBe(1);
    });

    it('delivers source status metadata without decoding it or replacing the held image', async () => {
        const fake = createFakeTransport();
        const statuses: MachineLiveStreamFrameV1[] = [];
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), viewerSocketId: 'viewer', onMetadataFrame: frame => statuses.push(frame),
        }));
        await act(async () => { fake.deliver(frameEnvelope(imageFrame(1))); });
        const held = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        const metadata: MachineLiveStreamFrameV1 = { ...imageFrame(2), payloadKind: 'metadata', payloadBase64: 'e30=', payloadSizeBytes: 2 };
        await act(async () => {
            fake.deliver(frameEnvelope({ ...metadata, streamId: 'another-stream' }));
            fake.deliver(frameEnvelope(metadata));
        });
        expect(statuses).toEqual([metadata]);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toBe(held);
        expect(held?.decodedFrames).toBe(1);
        expect(fake.sent.at(-1)).toMatchObject({ message: { kind: 'control', control: { kind: 'ack', nextSequence: 3 } } });
        await hook.unmount();
    });

    it('delivers only this stream’s valid source receipts without ending or replacing its picture', async () => {
        const fake = createFakeTransport();
        const reasons: string[] = [];
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport), onReceipt: receipt => reasons.push(receipt.reasonCode ?? ''),
        }));
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        const held = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        const receipt = { v: 1, id: PEER_MEDIATION_RECEIPTS.streamPaused, streamId: STREAM_ID,
            routeKind: 'server_relay', flowKind: 'live_stream', terminal: false, reasonCode: 'stale_capture' };
        await act(async () => {
            for (const value of [{ ...receipt, streamId: 'foreign' }, { ...receipt, payloadBase64: 'secret' }, receipt]) {
                fake.deliver({ v: 1, sourceMachineId: SOURCE, targetMachineId: TARGET, message: { kind: 'receipt', receipt: value } });
            }
        });
        expect(reasons).toEqual(['stale_capture']);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toBe(held);
        await hook.unmount();
    });

    it('acks delivered viewer-targeted frames so the server relay window replenishes (SIM-P0-2)', async () => {
        const fake = createFakeTransport();
        await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            viewerSocketId: 'viewer-socket-1',
        }));

        await act(async () => {
            fake.deliver({
                ...frameEnvelope(imageFrame(7)),
                viewerSocketId: 'viewer-socket-1',
            });
        });

        expect(fake.sent).toEqual([expect.objectContaining({
            sourceMachineId: SOURCE,
            targetMachineId: TARGET,
            viewerSocketId: 'viewer-socket-1',
            message: {
                kind: 'control',
                control: expect.objectContaining({
                    kind: 'ack',
                    streamId: STREAM_ID,
                    nextSequence: 8,
                }),
            },
        })]);
    });

    it('ignores malformed envelopes without crashing or producing a frame', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion(baseInput(fake.transport)));

        await act(async () => {
            fake.deliver({ not: 'a valid envelope' });
            fake.deliver(null);
        });

        const stream = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        expect(stream?.decodedFrames).toBe(0);
        expect(stream?.lastFrameUrl).toBeUndefined();
    });

    it('unsubscribes from the transport on unmount', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion(baseInput(fake.transport)));
        expect(fake.listenerCount()).toBe(1);

        await hook.unmount();
        expect(fake.listenerCount()).toBe(0);
        expect(fake.sent).toEqual([expect.objectContaining({
            message: {
                kind: 'control',
                control: expect.objectContaining({
                    kind: 'stop',
                    streamId: STREAM_ID,
                    reasonCode: 'viewer_closed',
                }),
            },
        })]);
    });

    it('clears the last frame when a new logical transport replaces the subscriber', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(
            (props: UseSimulatorRelayIngestionInput) => useSimulatorRelayIngestion(props),
            { initialProps: baseInput(fake.transport) },
        );

        await act(async () => {
            fake.deliver(frameEnvelope(imageFrame(1)));
        });
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl)
            .toBe('data:image/jpeg;base64,AQID');

        const nextFake = createFakeTransport();
        const reconnected = await hook.rerender({ ...baseInput(nextFake.transport) });

        const stream = reconnected.playerStatesBySimulatorId[SIMULATOR_ID];
        expect(stream?.phase).toBe('opening');
        expect(stream?.lastFrameUrl).toBeUndefined();
        expect(fake.sent).toEqual([expect.objectContaining({
            message: {
                kind: 'control',
                control: expect.objectContaining({ kind: 'stop', streamId: STREAM_ID }),
            },
        })]);
        expect(nextFake.sent).toEqual([]);
    });

    it('resets the held frame when the stream identity tuple changes', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(
            (props: UseSimulatorRelayIngestionInput) => useSimulatorRelayIngestion(props),
            { initialProps: baseInput(fake.transport) },
        );

        await act(async () => {
            fake.deliver(frameEnvelope(imageFrame(1, { payloadBase64: 'AAAA' })));
        });
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl)
            .toBe('data:image/jpeg;base64,AAAA');

        const switched = await hook.rerender({
            ...baseInput(fake.transport),
            simulatorId: 'sim_2',
            sourceMachineId: 'machine_source_2',
            targetMachineId: 'machine_target_2',
            streamId: 'stream_2',
            streamFamily: 'screen_2',
            startProduction: async (input) => input.routeKind === 'loopback_direct'
                ? { ok: false, reasonCode: 'topology_unavailable' }
                : {
                    ok: true,
                    routeKind: 'server_relay',
                    startRequest: {
                        ...startRequest(),
                        streamId: 'stream_2',
                        streamFamily: 'screen_2',
                        sourceMachineId: 'machine_source_2',
                        targetMachineId: 'machine_target_2',
                    },
                    relayAuthorization: startRequest().authorization!,
                },
        });

        const stream = switched.playerStatesBySimulatorId.sim_2;
        expect(stream?.phase).toBe('opening');
        expect(stream?.streamId).toBe('stream_2');
        expect(stream?.lastFrameUrl).toBeUndefined();
        expect(switched.playerStatesBySimulatorId[SIMULATOR_ID]).toBeUndefined();
    });

    it('keeps the source picture through a socket replacement, but clears it for another logical transport', async () => {
        const fake = createFakeTransport();
        const input = { ...baseInput(fake.transport), viewerSocketId: 'viewer-old' };
        let replacingTransport: SimulatorRelayTransport | null = null;
        const replacementFrames: Array<string | undefined> = [];
        const hook = await renderHook(
            (props: UseSimulatorRelayIngestionInput) => {
                const result = useSimulatorRelayIngestion(props);
                if (props.transport === replacingTransport) replacementFrames.push(result.playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl);
                return result;
            },
            { initialProps: input },
        );
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        const heldFrame = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl;
        expect(heldFrame).toBeTruthy();
        await hook.rerender({ ...input, enabled: false, streamId: '', viewerSocketId: '' });
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe(heldFrame);
        await hook.rerender({ ...input, streamId: 'stream-reconnected', viewerSocketId: 'viewer-new' });
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toMatchObject({
            phase: 'reconnecting', streamId: 'stream-reconnected', lastFrameUrl: heldFrame,
        });
        await act(async () => fake.deliver(frameEnvelope(imageFrame(2, { payloadBase64: 'AAAA' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe(heldFrame);
        await act(async () => fake.deliver(frameEnvelope(imageFrame(3, { streamId: 'stream-reconnected', payloadBase64: 'BAUG' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe('data:image/jpeg;base64,BAUG');
        // Account replacement gets another logical transport even when the Machine
        // and source labels happen to match; it must not inherit this picture.
        const replacement = createFakeTransport();
        replacingTransport = replacement.transport;
        await hook.rerender({ ...input, transport: replacement.transport,
            streamId: 'stream-reconnected', viewerSocketId: 'viewer-new' });
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBeUndefined();
        expect(replacementFrames.length).toBeGreaterThan(0);
        expect(replacementFrames.every(frame => frame === undefined)).toBe(true);
    });

    it('returns no player state when disabled', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            enabled: false,
        }));

        expect(hook.getCurrent().playerStatesBySimulatorId).toEqual({});
        expect(fake.sent).toHaveLength(0);
    });

    it.each([
        { serverId: 'different-home' },
        { simulatorId: 'different-viewer-source' },
        { sourceMachineId: 'different-source-machine' },
        { targetMachineId: 'different-target-machine' },
        { streamFamily: 'different-family' },
        { sourceId: 'different-source' },
        { sourceOccurrenceId: 'different-capture' },
    ])('does not retain a hidden frame across a changed source scope: %j', async (scope) => {
        const fake = createFakeTransport();
        const input = { ...baseInput(fake.transport), viewerSocketId: 'viewer-old' };
        const hook = await renderHook(
            (props: UseSimulatorRelayIngestionInput) => useSimulatorRelayIngestion(props),
            { initialProps: input },
        );
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBeTruthy();
        const hidden = await hook.rerender({ ...input, ...scope, enabled: false, streamId: '', viewerSocketId: '' });
        expect(fake.listenerCount()).toBe(0);
        expect(hidden.playerStatesBySimulatorId).toEqual({});
    });

    it('holds the last frame while hidden, resumes fresh frames, and never projects a different hidden stream', async () => {
        const fake = createFakeTransport();
        const input = baseInput(fake.transport);
        const hook = await renderHook(
            (props: UseSimulatorRelayIngestionInput) => useSimulatorRelayIngestion(props),
            { initialProps: input },
        );
        await act(async () => fake.deliver(frameEnvelope(imageFrame(1))));
        const held = hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID];
        expect(held?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');

        const hidden = await hook.rerender({ ...input, enabled: false });
        expect(fake.listenerCount()).toBe(0);
        expect(hidden.playerStatesBySimulatorId[SIMULATOR_ID]).toBe(held);
        await act(async () => fake.deliver(frameEnvelope(imageFrame(2, { payloadBase64: 'AAAA' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe(held?.lastFrameUrl);

        await hook.rerender(input);
        expect(fake.listenerCount()).toBe(1);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe(held?.lastFrameUrl);
        await act(async () => fake.deliver(frameEnvelope(imageFrame(3, { payloadBase64: 'AAAA' }))));
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]?.lastFrameUrl).toBe('data:image/jpeg;base64,AAAA');

        const switched = await hook.rerender({ ...input, enabled: false, simulatorId: 'sim_2', streamId: 'stream_2' });
        expect(fake.listenerCount()).toBe(0);
        expect(switched.playerStatesBySimulatorId).toEqual({});
    });
});
