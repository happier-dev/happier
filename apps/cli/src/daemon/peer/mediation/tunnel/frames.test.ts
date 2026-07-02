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

async function loadFramesModule(): Promise<FramesModule | null> {
    const modulePath = './frames.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel frame accounting', () => {
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
