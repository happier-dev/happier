import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import {
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamFrameV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import {
    useSimulatorRelayIngestion,
    type SimulatorRelayTransport,
    type UseSimulatorRelayIngestionInput,
} from './useSimulatorRelayIngestion';

const STREAM_ID = 'stream_1';
const SOURCE = 'machine_source';
const TARGET = 'machine_target';
const SIMULATOR_ID = 'sim_1';

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
                iat: 1_000,
                exp: 61_000,
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
    it('opens the relay client without emitting the retired viewer-socket start envelope', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion(baseInput(fake.transport)));

        expect(fake.sent).toEqual([]);
        expect(hook.getCurrent().playerStatesBySimulatorId[SIMULATOR_ID]).toBeDefined();
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

    it('preserves the last frame and marks reconnecting when the transport reconnects', async () => {
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
        expect(stream?.phase).toBe('reconnecting');
        expect(stream?.lastFrameUrl).toBe('data:image/jpeg;base64,AQID');
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

    it('returns no player state when disabled', async () => {
        const fake = createFakeTransport();
        const hook = await renderHook(() => useSimulatorRelayIngestion({
            ...baseInput(fake.transport),
            enabled: false,
        }));

        expect(hook.getCurrent().playerStatesBySimulatorId).toEqual({});
        expect(fake.sent).toHaveLength(0);
    });
});
