import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import type { JsonValue } from '@happier-dev/plugin-sdk';

export type CodexSocketFixtureRequest = Readonly<{ id?: number; method: string; params?: JsonValue }>;

/** The native 0.162.1 control socket accepts WebSocket upgrades, never JSON lines. */
export async function createCodexControlSocketFixture(
    socketPath: string,
    onRequest: (request: CodexSocketFixtureRequest) => JsonValue | undefined | Promise<JsonValue | undefined>,
    options?: Readonly<{ onConnection?: (socket: import('node:net').Socket) => void }>,
) {
    await mkdir(dirname(socketPath), { recursive: true });
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer,
        verifyClient: (info, done) => done(info.req.headers['sec-websocket-extensions'] === undefined),
    });
    let connections = 0;
    const requests: CodexSocketFixtureRequest[] = [];
    webSocketServer.on('connection', (socket, request) => {
        connections += 1;
        options?.onConnection?.(request.socket);
        socket.on('message', async payload => {
            const request = JSON.parse(payload.toString()) as CodexSocketFixtureRequest;
            requests.push(request);
            try {
                const result = await onRequest(request);
                if (request.id !== undefined && result !== undefined && socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify({ id: request.id, result }));
                }
            } catch {
                if (request.id !== undefined && socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Fixture request failed' } }));
                }
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(socketPath, resolve);
    });
    return { requests,
        send(message: JsonValue) {
            for (const socket of webSocketServer.clients) socket.send(JSON.stringify(message));
        },
        get connectionCount() { return connections; },
        get activeConnections() { return webSocketServer.clients.size; },
        async close() {
            for (const socket of webSocketServer.clients) socket.terminate();
            await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        },
    };
}

/** Native proxy contract: relay byte streams without parsing or decoding them. */
export const CODEX_RAW_PROXY_FIXTURE_SCRIPT = `
const socket = require('node:net').connect(process.argv[1]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('end', () => process.exit(0));
socket.on('error', () => process.exit(1));
`;

/** Client boundary fixture: receipts precede ordered notification delivery. */
export function createCodexNativeEventFixture() {
    const listeners = new Set<Parameters<import('./client.js').DisposableCodexAppServerClient['onNativeEvent']>[0]>();
    return {
        onNativeEvent(listener: Parameters<import('./client.js').DisposableCodexAppServerClient['onNativeEvent']>[0]) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        publish(method: string, params: unknown, receivedAtMs = Date.now()) {
            for (const listener of [...listeners]) listener(method, params, receivedAtMs);
        },
    };
}
