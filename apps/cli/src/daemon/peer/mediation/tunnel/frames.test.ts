import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    type PeerTcpTunnelDestinationV1,
    type PeerTcpTunnelSubstreamCapsV2,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type FramesModule = typeof import('./frames');
type CreateStreamSessionForTest = (
    input: Parameters<FramesModule['createPeerTcpTunnelStreamSession']>[0] & Readonly<{
        ackAfterBytes?: number;
        ackAfterMs?: number;
        maxIdleMs?: number;
        maxDurationMs?: number;
        maxTotalBytes?: number;
        nowMs?: () => number;
    }>,
) => ReturnType<FramesModule['createPeerTcpTunnelStreamSession']>;
type TestTunnelConnection = Readonly<{
    write?: (bytes: Uint8Array) => Promise<void> | void;
    onData?: (handler: (bytes: Uint8Array) => Promise<void> | void) => (() => void) | void;
    close: () => Promise<void> | void;
}>;
type CreateSubstreamMuxSessionForTest = (input: Readonly<{
    tunnelId: string;
    destination: PeerTcpTunnelDestinationV1;
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxBinaryHeaderBytes: number;
    maxRawPayloadBytes: number;
    caps: PeerTcpTunnelSubstreamCapsV2;
    connectTcp: (target: PeerTcpTunnelDestinationV1) => Promise<TestTunnelConnection>;
    sendBinaryFrame: (frame: Uint8Array) => Promise<void> | void;
    nowMs?: () => number;
}>) => Readonly<{
    acceptBinaryFrame: (frame: Uint8Array) => Promise<unknown>;
    close: () => Promise<void>;
}>;
type CreateApplicationSubstreamSessionForTest = (input: Readonly<{
    tunnelId: string;
    maxBinaryHeaderBytes: number;
    maxFrameBytes: number;
    maxBytesPerSubstream: number;
    maxAggregateBytes: number;
    maxConcurrentSubstreams: number;
    maxTotalSubstreams: number;
    maxSubstreamIdleMs: number;
    maxSessionIdleMs: number;
    maxDurationMs: number;
    maxPendingDispatches?: number;
    maxPendingDispatchBytes?: number;
    sendBinaryFrame: (frame: Uint8Array) => Promise<void> | void;
    onTerminal: (reasonCode: string) => Promise<void> | void;
    nowMs?: () => number;
}>) => Readonly<{
    acceptBinaryFrame: (
        frame: Uint8Array,
        dispatch: (input: Readonly<{
            substreamId: string;
            sequence: number;
            payload: Uint8Array;
        }>) => Promise<Uint8Array | null>,
    ) => Promise<unknown>;
    sendApplicationFrame: (input: Readonly<{
        substreamId: string;
        payload: Uint8Array;
    }>) => Promise<unknown>;
    denySubstream: (substreamId: string, reasonCode: 'encoded_frame_too_large') => Promise<unknown>;
    close: () => Promise<void>;
}>;

async function loadFramesModule(): Promise<FramesModule | null> {
    const modulePath = './frames.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel frame accounting', () => {
    it('returns carrier input credit immediately after bounded frame admission', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        let releaseDispatch: (() => void) | undefined;
        const dispatch = vi.fn(async () => await new Promise<null>((resolve) => {
            releaseDispatch = () => resolve(null);
        }));
        const session = createSession({
            tunnelId: 'tun_carrier_credit',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 64,
            maxBytesPerSubstream: 1024,
            maxAggregateBytes: 1024,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal: vi.fn(),
        });
        const admission = session.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_carrier_credit',
                substreamId: 'agent-realtime.attempt-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: new Uint8Array([1, 2, 3, 4]),
        }), dispatch);

        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        const credit = decodePeerTcpTunnelBinaryFrameV2({
            frame: sent[0] ?? new Uint8Array(),
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(credit.ok ? credit.header : null).toMatchObject({
            kind: 'ack',
            substreamId: 'agent-realtime.attempt-1',
            direction: 'client_to_daemon',
            ack: 1,
            window: 4,
        });
        releaseDispatch?.();
        await expect(admission).resolves.toEqual({ ok: true });
    });

    it('admits daemon output on an independent carrier sequence window', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const session = createSession({
            tunnelId: 'tun_duplex',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 64,
            maxBytesPerSubstream: 1024,
            maxAggregateBytes: 1024,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal: vi.fn(),
        });
        const inputFrame = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_duplex',
                substreamId: 'agent-realtime.attempt-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 1,
            },
            payload: new Uint8Array([1]),
        });
        await session.acceptBinaryFrame(inputFrame, async () => null);
        await expect(session.sendApplicationFrame({
            substreamId: 'agent-realtime.attempt-1',
            payload: new Uint8Array([2, 3]),
        })).resolves.toEqual({ ok: true });
        await expect(session.sendApplicationFrame({
            substreamId: 'agent-realtime.attempt-1',
            payload: new Uint8Array([4]),
        })).resolves.toEqual({ ok: true });
        const createdForSequences: number[] = [];
        await expect(session.sendApplicationFrame({
            substreamId: 'agent-realtime.attempt-1',
            createPayload: (sequence) => {
                createdForSequences.push(sequence);
                return new Uint8Array([5]);
            },
        })).resolves.toEqual({ ok: true });

        const outputs = sent
            .map((frame) => decodePeerTcpTunnelBinaryFrameV2({
                frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .filter((decoded) => decoded.ok && decoded.header.kind === 'data');
        expect(outputs.map((output) => output.ok ? output.header.sequence : null)).toEqual([0, 1, 2]);
        expect(createdForSequences).toEqual([2]);
        expect(outputs[0]?.ok ? outputs[0].header : null).toMatchObject({
            kind: 'data',
            direction: 'daemon_to_client',
            sequence: 0,
            substreamId: 'agent-realtime.attempt-1',
        });
    });

    it('routes bounded transport denials through the application terminal owner exactly once', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const onTerminal = vi.fn();
        const session = createSession({
            tunnelId: 'tun_app_transport_denial',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 64,
            maxAggregateBytes: 64,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal,
        });

        await expect(session.denySubstream('application.stream-1', 'encoded_frame_too_large')).resolves.toEqual({
            ok: false,
            reasonCode: 'encoded_frame_too_large',
            substreamId: 'application.stream-1',
        });
        await session.denySubstream('application.stream-1', 'encoded_frame_too_large');

        expect(onTerminal).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(1);
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: sent[0] ?? new Uint8Array(),
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        });
        expect(decoded?.ok ? decoded.header : null).toMatchObject({
            kind: 'abort',
            substreamId: 'application.stream-1',
            reasonCode: 'encoded_frame_too_large',
        });
    });

    it('admits application-substream requests and responses through one aggregate byte owner', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const onTerminal = vi.fn();
        const dispatch = vi.fn(async () => Buffer.from('response'));
        const session = createSession({
            tunnelId: 'tun_app',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 10,
            maxAggregateBytes: 10,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal,
        });
        const request = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_app',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 3,
            },
            payload: Buffer.from('pcm'),
        });

        await expect(session.acceptBinaryFrame(request, dispatch)).resolves.toEqual({
            ok: false,
            reasonCode: 'substream_cap_exceeded',
            substreamId: 'application.stream-1',
        });

        expect(dispatch).toHaveBeenCalledOnce();
        const decodedSent = sent.map((frame) => decodePeerTcpTunnelBinaryFrameV2({
            frame,
            maxHeaderBytes: 1024,
            maxPayloadBytes: 1024,
        }));
        expect(decodedSent.some((decoded) => decoded.ok && decoded.header.kind === 'data')).toBe(false);
        expect(decodedSent.filter((decoded) => decoded.ok && decoded.header.kind === 'abort')).toHaveLength(1);
        expect(onTerminal).toHaveBeenCalledOnce();

        await session.acceptBinaryFrame(request, dispatch);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(onTerminal).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(2);
    });

    it('rejects application-substream sequence replay before dispatch and terminates once', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const onTerminal = vi.fn();
        const dispatch = vi.fn(async () => null);
        const session = createSession({
            tunnelId: 'tun_app_sequence',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 64,
            maxAggregateBytes: 64,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal,
        });
        const frame = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_app_sequence',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 1,
            },
            payload: Buffer.from('x'),
        });

        await expect(session.acceptBinaryFrame(frame, dispatch)).resolves.toEqual({ ok: true });
        await expect(session.acceptBinaryFrame(frame, dispatch)).resolves.toEqual({
            ok: false,
            reasonCode: 'sequence_mismatch',
            substreamId: 'application.stream-1',
        });

        expect(dispatch).toHaveBeenCalledOnce();
        expect(onTerminal).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(2);
    });

    it('performs terminal cleanup when an admitted application consumer fails', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const onTerminal = vi.fn();
        const session = createSession({
            tunnelId: 'tun_app_consumer_failure',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 64,
            maxAggregateBytes: 64,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal,
        });
        const frame = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_app_consumer_failure',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 1,
            },
            payload: Buffer.from('x'),
        });

        await expect(session.acceptBinaryFrame(frame, async () => {
            throw new Error('consumer failed');
        })).rejects.toThrow('consumer failed');

        expect(onTerminal).toHaveBeenCalledOnce();
        const decoded = sent
            .map((sentFrame) => decodePeerTcpTunnelBinaryFrameV2({
                frame: sentFrame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .find((candidate) => candidate.ok && candidate.header.kind === 'abort');
        if (!decoded?.ok) throw new Error('expected application abort frame');
        expect(decoded.header).toMatchObject({
            kind: 'abort',
            reasonCode: 'application_dispatch_failed',
        });
    });

    it('serializes admitted application dispatch while allowing ordered frames to queue', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const sent: Uint8Array[] = [];
        const session = createSession({
            tunnelId: 'tun_app_dispatch_order',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 64,
            maxAggregateBytes: 64,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
            onTerminal: vi.fn(),
        });
        const frame = (sequence: number) => encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_app_dispatch_order',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence,
                payloadLength: 1,
            },
            payload: Buffer.from([sequence]),
        });
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const order: string[] = [];
        const dispatch = async ({ sequence }: Readonly<{ sequence: number }>) => {
            order.push(`start:${sequence}`);
            if (sequence === 0) await firstMayFinish;
            order.push(`finish:${sequence}`);
            return Buffer.from([sequence]);
        };

        const first = session.acceptBinaryFrame(frame(0), dispatch);
        const second = session.acceptBinaryFrame(frame(1), dispatch);
        await vi.waitFor(() => expect(order).toEqual(['start:0']));

        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
        expect(order).toEqual(['start:0', 'finish:0', 'start:1', 'finish:1']);
        const sentHeaders = sent.map((sentFrame) => {
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: sentFrame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            });
            return decoded.ok ? decoded.header : null;
        });
        expect(sentHeaders.filter((header) => header?.kind === 'ack')).toHaveLength(2);
        expect(sentHeaders.filter((header) => header?.kind === 'data')).toHaveLength(2);
    });

    it('bounds admitted application dispatches even when queued frames carry no payload bytes', async () => {
        const mod = await loadFramesModule();
        const createSession = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
        }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
        expect(createSession).toBeTypeOf('function');
        if (!createSession) return;

        const session = createSession({
            tunnelId: 'tun_app_dispatch_bound',
            maxBinaryHeaderBytes: 1024,
            maxFrameBytes: 16,
            maxBytesPerSubstream: 64,
            maxAggregateBytes: 64,
            maxConcurrentSubstreams: 1,
            maxTotalSubstreams: 1,
            maxSubstreamIdleMs: 30_000,
            maxSessionIdleMs: 60_000,
            maxDurationMs: 120_000,
            maxPendingDispatches: 2,
            maxPendingDispatchBytes: 16,
            sendBinaryFrame: vi.fn(),
            onTerminal: vi.fn(),
        });
        const frame = (sequence: number) => encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_app_dispatch_bound',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence,
                payloadLength: 0,
            },
        });
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const dispatch = vi.fn(async ({ sequence }: Readonly<{ sequence: number }>) => {
            if (sequence === 0) await firstMayFinish;
            return null;
        });

        const first = session.acceptBinaryFrame(frame(0), dispatch);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        const second = session.acceptBinaryFrame(frame(1), dispatch);
        const third = session.acceptBinaryFrame(frame(2), dispatch);

        releaseFirst();
        await expect(third).resolves.toEqual({
            ok: false,
            reasonCode: 'substream_cap_exceeded',
            substreamId: 'application.stream-1',
        });
        await Promise.allSettled([first, second]);
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it('expires application-substream sessions by resource duration, independent of later frames', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadFramesModule();
            const createSession = (mod as (FramesModule & Partial<{
                createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
            }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
            expect(createSession).toBeTypeOf('function');
            if (!createSession) return;

            const onTerminal = vi.fn();
            createSession({
                tunnelId: 'tun_app_duration',
                maxBinaryHeaderBytes: 1024,
                maxFrameBytes: 16,
                maxBytesPerSubstream: 64,
                maxAggregateBytes: 64,
                maxConcurrentSubstreams: 1,
                maxTotalSubstreams: 1,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 60_000,
                maxDurationMs: 25,
                sendBinaryFrame: vi.fn(),
                onTerminal,
            });

            await vi.advanceTimersByTimeAsync(26);

            expect(onTerminal).toHaveBeenCalledOnce();
            expect(onTerminal).toHaveBeenCalledWith({
                reasonCode: 'max_duration_exceeded',
                substreamIds: [],
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('terminates an idle application substream without waiting for another frame', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadFramesModule();
            const createSession = (mod as (FramesModule & Partial<{
                createPeerTcpTunnelApplicationSubstreamSession: CreateApplicationSubstreamSessionForTest;
            }> | null))?.createPeerTcpTunnelApplicationSubstreamSession;
            expect(createSession).toBeTypeOf('function');
            if (!createSession) return;

            const sent: Uint8Array[] = [];
            const onTerminal = vi.fn();
            const session = createSession({
                tunnelId: 'tun_app_idle',
                maxBinaryHeaderBytes: 1024,
                maxFrameBytes: 16,
                maxBytesPerSubstream: 64,
                maxAggregateBytes: 64,
                maxConcurrentSubstreams: 1,
                maxTotalSubstreams: 1,
                maxSubstreamIdleMs: 25,
                maxSessionIdleMs: 60,
                maxDurationMs: 120_000,
                sendBinaryFrame: (frame) => {
                    sent.push(frame);
                },
                onTerminal,
            });
            await session.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: 'data',
                    tunnelId: 'tun_app_idle',
                    substreamId: 'application.stream-1',
                    direction: 'client_to_daemon',
                    sequence: 0,
                    payloadLength: 1,
                },
                payload: Buffer.from('x'),
            }), async () => null);

            await vi.advanceTimersByTimeAsync(26);

            expect(onTerminal).toHaveBeenCalledOnce();
            expect(onTerminal).toHaveBeenCalledWith({
                reasonCode: 'max_idle_exceeded',
                substreamIds: ['application.stream-1'],
            });
            const decoded = sent
                .map((sentFrame) => decodePeerTcpTunnelBinaryFrameV2({
                    frame: sentFrame,
                    maxHeaderBytes: 1024,
                    maxPayloadBytes: 1024,
                }))
                .find((candidate) => candidate.ok && candidate.header.kind === 'abort');
            expect(decoded?.ok ? decoded.header : null).toMatchObject({
                kind: 'abort',
                reasonCode: 'max_idle_exceeded',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('multiplexes binary_frame_v2 substreams over separate TCP connections in one tunnel session', async () => {
        const mod = await loadFramesModule();
        const createMux = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelSubstreamMuxSession: CreateSubstreamMuxSessionForTest;
        }> | null))?.createPeerTcpTunnelSubstreamMuxSession;
        expect(createMux).toBeTypeOf('function');
        if (!createMux) return;

        const sent: Uint8Array[] = [];
        const writesByConnection: string[][] = [];
        const dataHandlers: Array<(bytes: Uint8Array) => Promise<void> | void> = [];
        const connectTcp = vi.fn(async (target: PeerTcpTunnelDestinationV1) => {
            const index = writesByConnection.length;
            writesByConnection.push([]);
            return {
                write: async (bytes: Uint8Array) => {
                    writesByConnection[index]?.push(Buffer.from(bytes).toString('utf8'));
                },
                onData: (handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandlers[index] = handler;
                },
                close: vi.fn(),
            };
        });
        const mux = createMux({
            tunnelId: 'tun_mux',
            destination: { host: '127.0.0.1', port: 3000 },
            initialWindowBytes: 64,
            maxFrameBytes: 1024,
            maxBinaryHeaderBytes: 1024,
            maxRawPayloadBytes: 1024,
            caps: {
                maxConcurrentSubstreams: 2,
                maxTotalSubstreams: 4,
                maxBytesPerSubstream: 64,
                maxAggregateBytes: 128,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 60_000,
            },
            connectTcp,
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
        });

        for (const substreamId of ['sub_a', 'sub_b']) {
            await mux.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                header: { version: 2, kind: 'open', tunnelId: 'tun_mux', substreamId, payloadLength: 0 },
            }));
        }
        await mux.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_mux',
                substreamId: 'sub_a',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 5,
            },
            payload: Buffer.from('alpha'),
        }));
        await mux.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_mux',
                substreamId: 'sub_b',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: Buffer.from('beta'),
        }));
        await dataHandlers[0]?.(Buffer.from('one'));
        await dataHandlers[1]?.(Buffer.from('two'));

        expect(connectTcp).toHaveBeenCalledTimes(2);
        expect(connectTcp).toHaveBeenNthCalledWith(1, { host: '127.0.0.1', port: 3000 });
        expect(writesByConnection).toEqual([['alpha'], ['beta']]);
        const decodedOutbound = sent
            .map((frame) => decodePeerTcpTunnelBinaryFrameV2({
                frame,
                maxHeaderBytes: 1024,
                maxPayloadBytes: 1024,
            }))
            .filter((decoded) => decoded.ok && decoded.header.kind === 'data');
        expect(decodedOutbound.map((decoded) => decoded.ok ? [
            decoded.header.substreamId,
            Buffer.from(decoded.payload).toString('utf8'),
        ] : null)).toEqual([
            ['sub_a', 'one'],
            ['sub_b', 'two'],
        ]);
    });

    it('enforces substream concurrency caps before opening another TCP connection', async () => {
        const mod = await loadFramesModule();
        const createMux = (mod as (FramesModule & Partial<{
            createPeerTcpTunnelSubstreamMuxSession: CreateSubstreamMuxSessionForTest;
        }> | null))?.createPeerTcpTunnelSubstreamMuxSession;
        expect(createMux).toBeTypeOf('function');
        if (!createMux) return;

        const sent: Uint8Array[] = [];
        const mux = createMux({
            tunnelId: 'tun_mux',
            destination: { host: '127.0.0.1', port: 3000 },
            initialWindowBytes: 64,
            maxFrameBytes: 1024,
            maxBinaryHeaderBytes: 1024,
            maxRawPayloadBytes: 1024,
            caps: {
                maxConcurrentSubstreams: 1,
                maxTotalSubstreams: 4,
                maxBytesPerSubstream: 64,
                maxAggregateBytes: 128,
                maxSubstreamIdleMs: 30_000,
                maxSessionIdleMs: 60_000,
            },
            connectTcp: vi.fn(async () => ({
                close: vi.fn(),
            })),
            sendBinaryFrame: (frame) => {
                sent.push(frame);
            },
        });

        await mux.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
            header: { version: 2, kind: 'open', tunnelId: 'tun_mux', substreamId: 'sub_a', payloadLength: 0 },
        }));
        await expect(mux.acceptBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
            header: { version: 2, kind: 'open', tunnelId: 'tun_mux', substreamId: 'sub_b', payloadLength: 0 },
        }))).resolves.toEqual({
            ok: false,
            reasonCode: 'substream_cap_exceeded',
            substreamId: 'sub_b',
        });

        const aborts = sent
            .map((frame) => decodePeerTcpTunnelBinaryFrameV2({ frame, maxHeaderBytes: 1024, maxPayloadBytes: 1024 }))
            .filter((decoded) => decoded.ok && decoded.header.kind === 'abort');
        expect(aborts.map((decoded) => decoded.ok ? decoded.header.substreamId : null)).toContain('sub_b');
    });

    it('translates binary_frame_v2 data frames to V1 logical frames without losing raw bytes', async () => {
        const mod = await loadFramesModule();
        expect(mod?.decodePeerTcpTunnelBinaryFrameForSession).toBeTypeOf('function');
        if (!mod?.decodePeerTcpTunnelBinaryFrameForSession) return;

        const encoded = mod.encodePeerTcpTunnelBinaryFrameForSession?.({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('hello').toString('base64'),
        });
        expect(encoded).toBeInstanceOf(Uint8Array);

        const decoded = mod.decodePeerTcpTunnelBinaryFrameForSession({
            frame: encoded ?? new Uint8Array(),
            maxBinaryHeaderBytes: 1024,
            maxRawPayloadBytes: 1024,
        });

        expect(decoded).toEqual({
            ok: true,
            frame: {
                v: 1,
                kind: 'data',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadBase64: Buffer.from('hello').toString('base64'),
            },
            rawPayloadBytes: 5,
        });
    });

    it('translates V1 ack and abort frames to binary_frame_v2 control headers', async () => {
        const mod = await loadFramesModule();
        expect(mod?.encodePeerTcpTunnelBinaryFrameForSession).toBeTypeOf('function');
        if (!mod?.encodePeerTcpTunnelBinaryFrameForSession || !mod.decodePeerTcpTunnelBinaryFrameForSession) return;

        const ack = mod.decodePeerTcpTunnelBinaryFrameForSession({
            frame: mod.encodePeerTcpTunnelBinaryFrameForSession({
                v: 1,
                kind: 'ack',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                nextSequence: 5,
                windowBytes: 4096,
            }),
            maxBinaryHeaderBytes: 1024,
            maxRawPayloadBytes: 1024,
        });
        const abort = mod.decodePeerTcpTunnelBinaryFrameForSession({
            frame: mod.encodePeerTcpTunnelBinaryFrameForSession({
                v: 1,
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'relay_cap_exceeded',
            }),
            maxBinaryHeaderBytes: 1024,
            maxRawPayloadBytes: 1024,
        });

        expect(ack).toEqual({
            ok: true,
            frame: {
                v: 1,
                kind: 'ack',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                nextSequence: 5,
                windowBytes: 4096,
            },
            rawPayloadBytes: 0,
        });
        expect(abort).toEqual({
            ok: true,
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: 'tun_1',
                reasonCode: 'relay_cap_exceeded',
            },
            rawPayloadBytes: 0,
        });
    });

    it('enforces sliding receive credit per direction', async () => {
        const mod = await loadFramesModule();
        const accounting = mod?.createPeerTcpTunnelFrameAccounting({
            initialWindowBytes: 4,
        });

        expect(accounting?.acceptData({
            direction: 'client_to_daemon',
            sequence: 0,
            decodedBytes: 3,
        })).toEqual({ ok: true, nextSequence: 3, windowBytes: 1 });

        expect(accounting?.acceptData({
            direction: 'client_to_daemon',
            sequence: 3,
            decodedBytes: 2,
        })).toEqual({ ok: false, reasonCode: 'receive_window_exceeded' });

        expect(accounting?.ackConsumed({
            direction: 'client_to_daemon',
            decodedBytes: 3,
        })).toEqual({ ok: true, nextSequence: 3, windowBytes: 4 });
    });

    it('rejects data after same-direction half-close but allows the opposite direction', async () => {
        const mod = await loadFramesModule();
        const accounting = mod?.createPeerTcpTunnelFrameAccounting({
            initialWindowBytes: 8,
        });

        expect(accounting?.markHalfClosed({ direction: 'client_to_daemon' })).toEqual({ ok: true });
        expect(accounting?.acceptData({
            direction: 'client_to_daemon',
            sequence: 0,
            decodedBytes: 1,
        })).toEqual({ ok: false, reasonCode: 'direction_half_closed' });
        expect(accounting?.acceptData({
            direction: 'daemon_to_client',
            sequence: 0,
            decodedBytes: 1,
        })).toEqual({ ok: true, nextSequence: 1, windowBytes: 7 });
    });

    it('bridges client data frames to the bound TCP connection and emits receive credit acks', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        const writes: string[] = [];
        const sent: unknown[] = [];
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            ackAfterBytes: 1,
            connection: {
                write: async (bytes: Uint8Array) => {
                    writes.push(Buffer.from(bytes).toString('utf8'));
                },
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('ping').toString('base64'),
        })).resolves.toEqual({ ok: true });

        expect(writes).toEqual(['ping']);
        expect(sent).toContainEqual({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 4,
            windowBytes: 8,
        });
    });

    it('rejects client-sent data frames that claim the daemon-to-client direction', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        const writes: string[] = [];
        const sent: unknown[] = [];
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            connection: {
                write: async (bytes: Uint8Array) => {
                    writes.push(Buffer.from(bytes).toString('utf8'));
                },
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            sequence: 0,
            payloadBase64: Buffer.from('spoof').toString('base64'),
        })).resolves.toEqual({ ok: false, reasonCode: 'direction_not_allowed' });

        expect(writes).toEqual([]);
        expect(sent).toContainEqual({
            v: 1,
            kind: 'abort',
            tunnelId: 'tun_1',
            reasonCode: 'direction_not_allowed',
        });
    });

    it('waits for the configured ack cadence before replenishing receive credit', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        const sent: unknown[] = [];
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 16,
            maxFrameBytes: 1024,
            ackAfterBytes: 8,
            ackAfterMs: 100,
            nowMs: () => 1_000,
            connection: {
                write: async () => undefined,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('ping').toString('base64'),
        });
        expect(sent).not.toContainEqual(expect.objectContaining({ kind: 'ack' }));

        await session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 4,
            payloadBase64: Buffer.from('pong').toString('base64'),
        });

        expect(sent).toContainEqual({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 8,
            windowBytes: 16,
        });
    });

    it('flushes pending receive credit after the configured ack time cadence elapses', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadFramesModule();
            const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
            const sent: unknown[] = [];
            const writes: string[] = [];
            const session = createSession?.({
                tunnelId: 'tun_1',
                initialWindowBytes: 16,
                maxFrameBytes: 1024,
                ackAfterBytes: 8,
                ackAfterMs: 100,
                connection: {
                    write: (bytes) => {
                        writes.push(Buffer.from(bytes).toString('utf8'));
                    },
                    close: async () => undefined,
                },
                sendFrame: async (frame: unknown) => {
                    sent.push(frame);
                },
            });

            await expect(session?.acceptFrame({
                v: 1,
                kind: 'data',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadBase64: Buffer.from('ping').toString('base64'),
            })).resolves.toEqual({ ok: true });
            expect(writes).toEqual(['ping']);
            expect(sent).not.toContainEqual(expect.objectContaining({ kind: 'ack' }));

            await vi.advanceTimersByTimeAsync(100);

            expect(sent).toContainEqual({
                v: 1,
                kind: 'ack',
                tunnelId: 'tun_1',
                direction: 'client_to_daemon',
                nextSequence: 4,
                windowBytes: 16,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards bound TCP data frames back to the WebSocket sender', async () => {
        const mod = await loadFramesModule();
        let dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | undefined;
        const sent: unknown[] = [];
        mod?.createPeerTcpTunnelStreamSession({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            connection: {
                onData: (handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandler = handler;
                },
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        expect(dataHandler).toBeTypeOf('function');
        await dataHandler?.(Buffer.from('pong'));

        expect(sent).toContainEqual({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            sequence: 0,
            payloadBase64: Buffer.from('pong').toString('base64'),
        });
    });

    it('pauses daemon TCP reads instead of aborting when peer receive credit is exhausted', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        let dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | undefined;
        const sent: unknown[] = [];
        const pauseRead = vi.fn();
        const resumeRead = vi.fn();
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 4,
            maxFrameBytes: 1024,
            connection: {
                onData: (handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandler = handler;
                },
                pauseRead,
                resumeRead,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await dataHandler?.(Buffer.from('ping'));
        await dataHandler?.(Buffer.from('!'));

        expect(pauseRead).toHaveBeenCalledOnce();
        expect(sent).not.toContainEqual(expect.objectContaining({
            kind: 'abort',
            reasonCode: 'send_window_exceeded',
        }));
        expect(sent).not.toContainEqual(expect.objectContaining({
            kind: 'data',
            payloadBase64: Buffer.from('!').toString('base64'),
        }));

        sent.length = 0;
        await session?.acceptFrame({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            nextSequence: 4,
            windowBytes: 4,
        });

        expect(sent).toContainEqual(expect.objectContaining({
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            sequence: 4,
            payloadBase64: Buffer.from('!').toString('base64'),
        }));
        expect(resumeRead).toHaveBeenCalledOnce();
        expect(sent).not.toContainEqual(expect.objectContaining({
            kind: 'abort',
            reasonCode: 'send_window_exceeded',
        }));
    });

    it('rejects ack frames that advance beyond sent daemon data', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        const sent: unknown[] = [];
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            connection: {
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            nextSequence: 1,
            windowBytes: 8,
        })).resolves.toEqual({ ok: false, reasonCode: 'ack_sequence_invalid' });
        expect(sent).toContainEqual({
            v: 1,
            kind: 'abort',
            tunnelId: 'tun_1',
            reasonCode: 'ack_sequence_invalid',
        });
    });

    it('aborts when tunnel byte caps from the grant scope are exceeded before writing bytes', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        const sent: unknown[] = [];
        const writes: string[] = [];
        const session = createSession?.({
            tunnelId: 'tun_1',
            initialWindowBytes: 16,
            maxFrameBytes: 1024,
            maxTotalBytes: 3,
            connection: {
                write: async (bytes: Uint8Array) => {
                    writes.push(Buffer.from(bytes).toString('utf8'));
                },
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('four').toString('base64'),
        })).resolves.toEqual({ ok: false, reasonCode: 'total_bytes_exceeded' });
        expect(writes).toEqual([]);
        expect(sent).toContainEqual(expect.objectContaining({
            kind: 'abort',
            reasonCode: 'total_bytes_exceeded',
        }));
    });

    it('aborts when tunnel duration or idle caps from the grant scope are exceeded', async () => {
        const mod = await loadFramesModule();
        const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
        let now = 1_000;
        const sent: unknown[] = [];
        const durationSession = createSession?.({
            tunnelId: 'tun_duration',
            initialWindowBytes: 16,
            maxFrameBytes: 1024,
            maxDurationMs: 50,
            nowMs: () => now,
            connection: {
                write: async () => undefined,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        now = 1_100;
        await expect(durationSession?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_duration',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('x').toString('base64'),
        })).resolves.toEqual({ ok: false, reasonCode: 'max_duration_exceeded' });

        now = 2_000;
        sent.length = 0;
        const idleSession = createSession?.({
            tunnelId: 'tun_idle',
            initialWindowBytes: 16,
            maxFrameBytes: 1024,
            maxIdleMs: 25,
            nowMs: () => now,
            connection: {
                write: async () => undefined,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        now = 2_026;
        await expect(idleSession?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_idle',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('x').toString('base64'),
        })).resolves.toEqual({ ok: false, reasonCode: 'max_idle_exceeded' });
    });

    it('aborts idle tunnels without waiting for another frame', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadFramesModule();
            const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
            const close = vi.fn(async () => undefined);
            const sent: unknown[] = [];

            createSession?.({
                tunnelId: 'tun_idle_timer',
                initialWindowBytes: 16,
                maxFrameBytes: 1024,
                maxIdleMs: 25,
                connection: { close },
                sendFrame: async (frame: unknown) => {
                    sent.push(frame);
                },
            });

            await vi.advanceTimersByTimeAsync(26);

            expect(sent).toContainEqual({
                v: 1,
                kind: 'abort',
                tunnelId: 'tun_idle_timer',
                reasonCode: 'max_idle_exceeded',
            });
            expect(close).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts tunnels when their duration cap elapses without traffic', async () => {
        vi.useFakeTimers();
        try {
            const mod = await loadFramesModule();
            const createSession = mod?.createPeerTcpTunnelStreamSession as unknown as CreateStreamSessionForTest | undefined;
            const close = vi.fn(async () => undefined);
            const sent: unknown[] = [];

            createSession?.({
                tunnelId: 'tun_duration_timer',
                initialWindowBytes: 16,
                maxFrameBytes: 1024,
                maxDurationMs: 50,
                connection: { close },
                sendFrame: async (frame: unknown) => {
                    sent.push(frame);
                },
            });

            await vi.advanceTimersByTimeAsync(51);

            expect(sent).toContainEqual({
                v: 1,
                kind: 'abort',
                tunnelId: 'tun_duration_timer',
                reasonCode: 'max_duration_exceeded',
            });
            expect(close).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts when a client sends data after a same-direction half-close', async () => {
        const mod = await loadFramesModule();
        const sent: unknown[] = [];
        const session = mod?.createPeerTcpTunnelStreamSession({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            connection: {
                write: async () => undefined,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'close',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            halfClose: true,
            reasonCode: 'client_half_closed',
        })).resolves.toEqual({ ok: true });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'data',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            sequence: 0,
            payloadBase64: Buffer.from('late').toString('base64'),
        })).resolves.toEqual({ ok: false, reasonCode: 'direction_half_closed' });

        expect(sent).toContainEqual({
            v: 1,
            kind: 'abort',
            tunnelId: 'tun_1',
            reasonCode: 'direction_half_closed',
        });
    });

    it('stops daemon-to-client TCP reads after a daemon-to-client half-close', async () => {
        const mod = await loadFramesModule();
        let dataHandler: ((bytes: Uint8Array) => Promise<void> | void) | undefined;
        const pauseRead = vi.fn();
        const sent: unknown[] = [];
        const session = mod?.createPeerTcpTunnelStreamSession({
            tunnelId: 'tun_1',
            initialWindowBytes: 8,
            maxFrameBytes: 1024,
            connection: {
                onData: (handler: (bytes: Uint8Array) => Promise<void> | void) => {
                    dataHandler = handler;
                },
                pauseRead,
                close: async () => undefined,
            },
            sendFrame: async (frame: unknown) => {
                sent.push(frame);
            },
        });

        await expect(session?.acceptFrame({
            v: 1,
            kind: 'close',
            tunnelId: 'tun_1',
            direction: 'daemon_to_client',
            halfClose: true,
            reasonCode: 'daemon_half_closed',
        })).resolves.toEqual({ ok: true });

        await dataHandler?.(Buffer.from('late'));

        expect(pauseRead).toHaveBeenCalledOnce();
        expect(sent).not.toContainEqual(expect.objectContaining({
            kind: 'data',
            direction: 'daemon_to_client',
            payloadBase64: Buffer.from('late').toString('base64'),
        }));
    });

    it('decodes masked client WebSocket text frames and encodes unmasked server text frames', async () => {
        const mod = await loadFramesModule();
        const mask = Buffer.from([1, 2, 3, 4]);
        const payload = Buffer.from(JSON.stringify({
            v: 1,
            kind: 'ack',
            tunnelId: 'tun_1',
            direction: 'client_to_daemon',
            nextSequence: 4,
            windowBytes: 8,
        }), 'utf8');
        const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % mask.length]!));
        const clientFrame = Buffer.concat([
            Buffer.from([0x81, 0x80 | payload.length]),
            mask,
            maskedPayload,
        ]);

        expect(mod?.decodePeerTcpTunnelWebSocketClientFrames({
            buffer: clientFrame,
            maxFrameBytes: 1024,
        })).toEqual({
            frames: [payload.toString('utf8')],
            remaining: Buffer.alloc(0),
            close: false,
        });

        expect(mod?.encodePeerTcpTunnelWebSocketTextFrame('ok')).toEqual(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    });
});
