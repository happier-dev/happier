import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyBaseLogger, FastifyInstance, FastifyTypeProvider, RawServerDefault } from 'fastify';

import { admitIrohIngressSocket, isIrohIngressRequest, IROH_REQUEST_IP } from '@/app/net/requestIngress';

function removeUntrustedProxyHeaders(request: IncomingMessage): void {
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip']) {
        delete request.headers[header];
    }
}

/**
 * One unadvertised loopback listener forwards the original HTTP/upgrade events
 * into the same API server. Provenance is fixed at accept, before peer bytes
 * are parsed. No peer header or public-listener connection can acquire it.
 */
export function installHomeIrohIngress<Logger extends FastifyBaseLogger, TypeProvider extends FastifyTypeProvider>(
    app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger, TypeProvider>,
) {
    let ingressPort: number | null = null;
    app.decorate('homeIrohIngressPort', { getter: () => ingressPort });
    const sockets = new Set<Socket>();
    const server = createServer({
        requestTimeout: app.server.requestTimeout,
        headersTimeout: app.server.headersTimeout,
        keepAliveTimeout: app.server.keepAliveTimeout,
    }, (request, reply) => {
        removeUntrustedProxyHeaders(request);
        app.server.emit('request', request, reply);
    });
    server.on('connection', (socket) => {
        admitIrohIngressSocket(socket);
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
        removeUntrustedProxyHeaders(request);
        if (!app.server.emit('upgrade', request, socket, head)) socket.destroy();
    });
    // Install before monitoring, proxy consumers and route/global rate limits.
    app.addHook('onRequest', async (request) => {
        if (!isIrohIngressRequest(request.raw)) return;
        Object.defineProperties(request, {
            ip: { value: IROH_REQUEST_IP },
            ips: { value: [IROH_REQUEST_IP] },
        });
    });
    app.addHook('onClose', async () => {
        if (!server.listening) return;
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        // Includes upgraded WebSockets, which closeAllConnections omits.
        for (const socket of sockets) socket.destroy();
        await closed;
    });
    return {
        listen: async (): Promise<number> => {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => { reject(error); };
                server.once('error', onError);
                server.listen(0, '127.0.0.1', () => {
                    server.removeListener('error', onError);
                    resolve();
                });
            });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Iroh ingress port unavailable');
            ingressPort = address.port;
            return address.port;
        },
    };
}
