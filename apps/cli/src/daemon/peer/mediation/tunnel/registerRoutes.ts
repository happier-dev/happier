import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

import {
    PEER_TCP_TUNNEL_OPEN_PATH,
    PEER_TCP_TUNNEL_STREAM_PATH,
    PeerTcpTunnelOpenV1Schema,
} from '@happier-dev/protocol';

import { openPeerTcpTunnel, type OpenPeerTcpTunnelInput, type OpenPeerTcpTunnelResult } from './open';
import {
    createPeerTcpTunnelStreamSession,
} from './frames';

const registeredTunnelApps = new WeakSet<FastifyInstance>();
const DEFAULT_DIRECT_TUNNEL_LIMITS: Readonly<{
    maxIdleMs: number;
    maxDurationMs: number;
    maxTotalBytes?: number;
}> = {
    maxIdleMs: Number.MAX_SAFE_INTEGER,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
};
const DEFAULT_OPEN_STREAM_TIMEOUT_MS = 30_000;

export type RegisterPeerTcpTunnelLoopbackRoutesOptions = Omit<OpenPeerTcpTunnelInput, 'open' | 'nowMs'> & Readonly<{
    nowMs: () => number;
    openTunnel?: (input: OpenPeerTcpTunnelInput) => Promise<OpenPeerTcpTunnelResult>;
    maxActiveTunnels?: number;
    openStreamTimeoutMs?: number;
}>;

type ActivePeerTcpTunnel = (OpenPeerTcpTunnelResult & { ok: true }) & Readonly<{
    openStreamTimeout?: ReturnType<typeof setTimeout>;
}>;

type PeerTcpTunnelFastifyWebSocket = Readonly<{
    on: (event: 'message' | 'close', handler: (payload?: unknown) => void) => void;
    send: (payload: string) => void;
    close: () => void;
}>;

function readFrameTunnelId(frame: unknown): string | null {
    if (!frame || typeof frame !== 'object') return null;
    const record = frame as Record<string, unknown>;
    if (typeof record.tunnelId === 'string') return record.tunnelId;
    const open = record.open;
    if (open && typeof open === 'object' && typeof (open as Record<string, unknown>).tunnelId === 'string') {
        return (open as Record<string, string>).tunnelId;
    }
    return null;
}

function readOpenTunnelId(open: unknown): string | null {
    const parsed = PeerTcpTunnelOpenV1Schema.safeParse(open);
    return parsed.success ? parsed.data.tunnelId : null;
}

function closeSocket(socket: PeerTcpTunnelFastifyWebSocket): void {
    socket.close();
}

export function registerPeerTcpTunnelLoopbackRoutes(
    app: FastifyInstance,
    options: RegisterPeerTcpTunnelLoopbackRoutesOptions,
): void {
    if (registeredTunnelApps.has(app)) {
        throw new Error('Peer mediation tunnel routes already registered on this loopback Fastify app');
    }
    registeredTunnelApps.add(app);

    const openTunnel = options.openTunnel ?? openPeerTcpTunnel;
    const maxActiveTunnels = Math.max(1, Math.floor(options.maxActiveTunnels ?? 8));
    const activeTunnels = new Map<string, ActivePeerTcpTunnel>();
    const openStreamTimeoutMs =
        typeof options.openStreamTimeoutMs === 'number' && Number.isFinite(options.openStreamTimeoutMs) && options.openStreamTimeoutMs >= 1
            ? Math.floor(options.openStreamTimeoutMs)
            : DEFAULT_OPEN_STREAM_TIMEOUT_MS;
    app.register(fastifyWebsocket);
    app.get(PEER_TCP_TUNNEL_STREAM_PATH, { websocket: true }, (socket: PeerTcpTunnelFastifyWebSocket) => {
        const sessions = new Map<string, ReturnType<typeof createPeerTcpTunnelStreamSession>>();
        const getSession = (tunnelId: string) => {
            const existing = sessions.get(tunnelId);
            if (existing) return existing;
            const tunnel = activeTunnels.get(tunnelId);
            if (!tunnel) return null;
            if (tunnel.openStreamTimeout) {
                clearTimeout(tunnel.openStreamTimeout);
            }
            const limits = tunnel.limits ?? DEFAULT_DIRECT_TUNNEL_LIMITS;
            const session = createPeerTcpTunnelStreamSession({
                tunnelId,
                initialWindowBytes: tunnel.response.initialWindowBytes,
                maxFrameBytes: tunnel.response.maxFrameBytes,
                maxIdleMs: limits.maxIdleMs,
                maxDurationMs: limits.maxDurationMs,
                maxTotalBytes: limits.maxTotalBytes,
                connection: tunnel.connection,
                sendFrame: (frame) => {
                    socket.send(JSON.stringify(frame));
                },
            });
            sessions.set(tunnelId, session);
            return session;
        };

        socket.on('message', (raw) => {
            let frame: unknown;
            try {
                frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
            } catch {
                closeSocket(socket);
                return;
            }
            const tunnelId = readFrameTunnelId(frame);
            if (!tunnelId) {
                closeSocket(socket);
                return;
            }
            void getSession(tunnelId)?.acceptFrame(frame);
        });

        socket.on('close', () => {
            for (const tunnelId of sessions.keys()) {
                const tunnel = activeTunnels.get(tunnelId);
                void tunnel?.connection.close();
                activeTunnels.delete(tunnelId);
            }
            sessions.clear();
        });
    });
    app.addHook('onClose', async () => {
        for (const tunnel of activeTunnels.values()) {
            if (tunnel.openStreamTimeout) {
                clearTimeout(tunnel.openStreamTimeout);
            }
            await tunnel.connection.close();
        }
        activeTunnels.clear();
    });

    app.post(PEER_TCP_TUNNEL_OPEN_PATH, async (request, reply) => {
        const tunnelId = readOpenTunnelId(request.body);
        if (tunnelId && activeTunnels.has(tunnelId)) {
            reply.code(409);
            return {
                ok: false,
                reasonCode: 'tunnel_id_already_open',
            };
        }
        if (tunnelId && activeTunnels.size >= maxActiveTunnels) {
            reply.code(429);
            return {
                ok: false,
                reasonCode: 'direct_tunnel_cap_exceeded',
            };
        }
        const result = await openTunnel({
            ...options,
            nowMs: options.nowMs(),
            open: request.body,
        });
        if (!result.ok) {
            reply.code(400);
            return result;
        }
        const openStreamTimeout = openStreamTimeoutMs == null
            ? undefined
            : setTimeout(() => {
                const activeTunnel = activeTunnels.get(result.response.tunnelId);
                if (!activeTunnel || activeTunnel.connection !== result.connection) return;
                if (activeTunnel.openStreamTimeout) {
                    clearTimeout(activeTunnel.openStreamTimeout);
                }
                void activeTunnel.connection.close();
                activeTunnels.delete(result.response.tunnelId);
            }, openStreamTimeoutMs);
        openStreamTimeout?.unref?.();
        activeTunnels.set(result.response.tunnelId, {
            ...result,
            ...(openStreamTimeout ? { openStreamTimeout } : {}),
        });
        return result.response;
    });
}
