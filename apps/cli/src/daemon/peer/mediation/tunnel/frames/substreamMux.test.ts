/** Substream mux contracts. Split from the former 1,475-line `frames.test.ts`
 * alongside the module split of `frames.ts` (lane D3, 2026-08-23). Test bodies are unchanged. */

import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    type PeerTcpTunnelDestinationV1,
    type PeerTcpTunnelSubstreamCapsV2,
} from '@happier-dev/protocol';

import { describe, expect, it, vi } from 'vitest';

type FramesModule = typeof import('./index');

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
    const modulePath = './index.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel substream mux', () => {
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
});
