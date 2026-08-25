/** Application substream session contracts. Split from the former 1,475-line `frames.test.ts`
 * alongside the module split of `frames.ts` (lane D3, 2026-08-23). Test bodies are unchanged. */

import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
} from '@happier-dev/protocol';

import { describe, expect, it, vi } from 'vitest';

type FramesModule = typeof import('./index');

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
    const modulePath = './index.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel application substream session', () => {
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
});
