/** Stream session contracts. Split from the former 1,475-line `frames.test.ts`
 * alongside the module split of `frames.ts` (lane D3, 2026-08-23). Test bodies are unchanged. */

import { describe, expect, it, vi } from 'vitest';

type FramesModule = typeof import('./index');

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

async function loadFramesModule(): Promise<FramesModule | null> {
    const modulePath = './index.js';
    return import(modulePath).catch(() => null) as Promise<FramesModule | null>;
}

describe('peer TCP tunnel stream session', () => {
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

});
