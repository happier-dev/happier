import { createServer } from 'node:http';
import { once } from 'node:events';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DaemonWorkspaceFileListResponseSchema, WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { registerWorkspaceFileListHandler } from './workspaceFileList';

const nativeRipgrep = vi.hoisted(() => vi.fn());
// Ripgrep is the native process boundary. Registration, path projection, byte
// admission, RPC framing, both real ciphers and Socket.IO remain real.
vi.mock('@/integrations/ripgrep/index', () => ({ run: nativeRipgrep }));

let server: Server | undefined;
let client: Socket | undefined;
async function connect(): Promise<ServerSocket> {
    const http = createServer();
    server = new Server(http, { maxHttpBufferSize: EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Socket fixture has no address');
    const remote = once(server, 'connection');
    client = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false });
    const connected = new Promise<void>(resolve => client!.once('connect', resolve));
    client.connect();
    await connected;
    return (await remote)[0] as ServerSocket;
}

afterEach(async () => {
    client?.disconnect();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    client = undefined;
    server = undefined;
    nativeRipgrep.mockReset();
});

describe('workspace reply Socket.IO boundary', () => {
    it('closes the sending Machine socket when its acknowledgement exceeds maxHttpBufferSize', async () => {
        const remote = await connect();
        let acknowledged = false;
        client!.once(SOCKET_RPC_EVENTS.REQUEST, (_request: unknown, acknowledge: (value: unknown) => void) => {
            acknowledge('x'.repeat(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES));
        });
        const clientClosed = new Promise<void>(resolve => client!.once('disconnect', () => resolve()));
        const serverClosed = once(remote, 'disconnect');
        remote.emit(SOCKET_RPC_EVENTS.REQUEST, {}, () => { acknowledged = true; });
        await Promise.all([clientClosed, serverClosed]);
        expect(acknowledged).toBe(false);
        expect(client!.connected).toBe(false);
        expect(remote.connected).toBe(false);
    });

    it.each(['plain', 'legacy', 'dataKey'] as const)('keeps a near-boundary Unicode List reply connected through real %s encoding', async mode => {
        const key = new Uint8Array(32).fill(7);
        const content: SocketRpcContent = mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
            encryptRaw: async value => encodeBase64(encrypt(key, mode, value)),
            decryptRaw: async value => decrypt(key, mode, decodeBase64(value)),
        } };
        const rpc = new RpcHandlerManager(mode === 'plain'
            ? { scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} }
            : { scopePrefix: 'machine', encryptionKey: key, encryptionVariant: mode, logger: () => {} });
        registerWorkspaceFileListHandler(rpc, '/repo');
        const pathSuffix = `${'日本😀'.repeat(20)}.ts`;
        const rowBytes = Buffer.byteLength(JSON.stringify(`src/000000-${pathSuffix}`));
        const emptyReplyBytes = Buffer.byteLength(JSON.stringify({ ok: true, paths: [], truncated: false }));
        // Fill the actual serialized result to the admitted byte. A row-sized
        // gap could hide missing crypto or response-envelope framing.
        const count = Math.floor((WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES - emptyReplyBytes - 16 + 1) / (rowBytes + 1));
        const paths = Array.from({ length: count },
            (_, index) => `src/${String(index).padStart(6, '0')}-${pathSuffix}`);
        const remaining = WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES - emptyReplyBytes - count * (rowBytes + 1) + 1;
        paths.push(`tail/${'a'.repeat(remaining - 3 - 'tail/'.length)}`, 'overflow.txt');
        const stdout = Buffer.from(`${paths.join('\n')}\n`);
        nativeRipgrep.mockImplementation(async (_args: string[], options: { maxStdoutBytes: number }) => ({
            exitCode: 0, stdout: stdout.subarray(0, options.maxStdoutBytes).toString('utf8'), stderr: '',
            stdoutTruncated: stdout.length > options.maxStdoutBytes,
        }));
        const remote = await connect();
        let frameBytes = 0;
        client!.io.engine.on('packetCreate', packet => {
            if (packet.type === 'message' && typeof packet.data === 'string' && packet.data.startsWith('3')) {
                frameBytes = 1 + Buffer.byteLength(packet.data);
            }
        });
        client!.on(SOCKET_RPC_EVENTS.REQUEST, (request, acknowledge) => { void rpc.handleRequest(request, acknowledge); });
        const method = `machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST}`;
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams(content, { rootPath: '/repo' }, { method, callId });
        const response: unknown = await remote.timeout(30_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
            { method, params, transportResponseEnvelopeVersion: 1 });
        if (!response || typeof response !== 'object' || !('result' in response)) throw new Error('Missing real RPC transport envelope');
        const decoded = DaemonWorkspaceFileListResponseSchema.parse(await socketRpcCodec.decodeResult(content,
            { ok: true, result: response.result }, callId));
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.truncated).toBe(true);
        expect(decoded.paths.length).toBeGreaterThan(5000);
        expect(decoded.paths.every((path, index) => path === paths[index])).toBe(true);
        // true takes one byte less than the false used while admitting rows.
        expect(Buffer.byteLength(JSON.stringify(decoded))).toBe(WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES - 1);
        expect(frameBytes).toBeGreaterThan(0);
        expect(frameBytes).toBeLessThanOrEqual(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES);
        await expect(remote.timeout(30_000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
            { method, params: await socketRpcCodec.encodeParams(content, { rootPath: '/repo', limit: 1 }, { method, callId }) }))
            .resolves.toBeDefined();
        expect(client!.connected).toBe(true);
        expect(remote.connected).toBe(true);
    });
});
