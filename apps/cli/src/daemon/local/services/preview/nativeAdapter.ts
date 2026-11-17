import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { proxyLocalServicePreviewHttpRequest, type LocalServicePreviewTunnelStream } from '@happier-dev/peer-mediation/localServices/preview/httpAdapter';
import { proxyLocalServicePreviewWebSocketUpgrade } from '@happier-dev/peer-mediation/localServices/preview/websocketAdapter';
import { createLocalServicePreviewUpgradeClient, writeLocalServicePreviewUpgradeError } from '@happier-dev/peer-mediation/localServices/preview/upgradeClient';
import { writeLocalServicePreviewDownstream } from '@happier-dev/peer-mediation/localServices/preview/downstream';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

function requestLocation(target: string | undefined): URL | null {
    try { return new URL(target ?? '/', 'http://127.0.0.1'); }
    catch { return null; }
}

/** One signed registration and its control-plane lifetime own all application sockets. */
export async function startLocalServicePreviewNativeAdapter(input: Readonly<{
    preview: LocalServicePreviewResourceV1;
    signal: AbortSignal;
    resolvePreview(): Promise<LocalServicePreviewResourceV1>;
}>): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
    input.signal.throwIfAborted();
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
        sockets.add(socket);
        socket.on('error', error => logger.warnLocalFile('[local-service] Preview socket failed',
            projectActionFailureCauseV1(error, 'local_service.preview.socket', { allowUnknownErrorCode: false })));
        socket.once('close', () => sockets.delete(socket));
    };
    let nextStreamId = 0;
    const openTunnel = async (): Promise<LocalServicePreviewTunnelStream> => {
        input.signal.throwIfAborted();
        await input.resolvePreview();
        const socket = connect({ host: input.preview.target.host, port: input.preview.target.port, allowHalfOpen: true });
        track(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            const onClose = () => reject(new Error('preview_connection_closed'));
            socket.once('close', onClose);
            socket.once('connect', () => { socket.off('error', reject); socket.off('close', onClose); resolve(); });
        });
        try {
            input.signal.throwIfAborted();
            await input.resolvePreview();
        } catch (error) { socket.destroy(); throw error; }
        const close = () => socket.destroy();
        return {
            tunnelId: input.preview.previewId, substreamId: String(++nextStreamId),
            write: (chunk) => new Promise<void>((resolve, reject) => socket.write(chunk, (error) => error ? reject(error) : resolve())),
            endWrite: () => new Promise<void>((resolve, reject) => socket.end((error?: Error | null) => error ? reject(error) : resolve())),
            async *read() { for await (const chunk of socket) yield chunk; },
            close: () => { close(); }, abort: () => { close(); },
        };
    };
    const server = createServer((request, response) => {
        const location = requestLocation(request.url);
        if (!location) { response.writeHead(400); response.end(); return; }
        const abort = new AbortController();
        const onClose = () => { if (!response.writableEnded) abort.abort(); };
        response.once('close', onClose);
        void proxyLocalServicePreviewHttpRequest({
            preview: input.preview,
            request: { method: request.method ?? 'GET', path: location.pathname, search: location.search,
                headers: request.headers, body: request, signal: abort.signal, externalProtocol: 'http' },
            response: {
                writeHead: (status, message, headers) => {
                    const outgoingHeaders: Record<string, string | string[]> = {};
                    for (const [name, value] of Object.entries(headers)) {
                        outgoingHeaders[name] = typeof value === 'string' ? value : [...value];
                    }
                    response.writeHead(status, message, outgoingHeaders);
                },
                write: (chunk) => writeLocalServicePreviewDownstream(response, chunk),
                end: () => { response.end(); },
                destroy: (error) => response.destroy(error instanceof Error ? error : undefined),
            },
            openTunnel,
        }).catch(() => {
            if (!response.headersSent) response.writeHead(502);
            response.destroy();
        }).finally(() => response.off('close', onClose));
    });
    server.on('connection', track);
    server.on('upgrade', (request, socket, head) => {
        const location = requestLocation(request.url);
        if (!location) { void writeLocalServicePreviewUpgradeError(socket, 400, 'Bad Request'); return; }
        void proxyLocalServicePreviewWebSocketUpgrade({
            preview: input.preview,
            request: { path: location.pathname, search: location.search, headers: request.headers,
                rawHeaders: request.rawHeaders, head, client: createLocalServicePreviewUpgradeClient(socket), externalProtocol: 'http' },
            openTunnel,
        }).catch(() => socket.destroy());
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= new Promise<void>((resolve) => {
        input.signal.removeEventListener('abort', onAbort);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
    const onAbort = () => { void close(); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve(); });
        });
        input.signal.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('preview_listener_unavailable');
        return { port: address.port, close };
    } catch (error) { await close(); throw error; }
}
