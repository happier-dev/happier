/** Frame accounting contracts. Split from the former 1,475-line `frames.test.ts`
 * alongside the module split of `frames.ts` (lane D3, 2026-08-23). Test bodies are unchanged. */

import { describe, expect, it } from 'vitest';

type FramesModule = typeof import('./index');

async function loadFramesModule(): Promise<FramesModule | null> {
    const modulePath = './index.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel frame accounting', () => {
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
});
