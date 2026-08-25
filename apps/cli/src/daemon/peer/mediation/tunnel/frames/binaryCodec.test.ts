/** Binary frame v2 codec contracts. Split from the former 1,475-line `frames.test.ts`
 * alongside the module split of `frames.ts` (lane D3, 2026-08-23). Test bodies are unchanged. */

import { describe, expect, it } from 'vitest';

type FramesModule = typeof import('./index');

async function loadFramesModule(): Promise<FramesModule | null> {
    const modulePath = './index.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel binary frame v2 codec', () => {
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
});
