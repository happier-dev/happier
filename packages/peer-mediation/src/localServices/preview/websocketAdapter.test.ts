import { expect, it } from 'vitest';
import type { LocalServicePreviewResourceV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { proxyLocalServicePreviewWebSocketUpgrade } from './websocketAdapter.js';

it('denies a WebSocket upgrade when the registered method policy excludes GET', async () => {
    const preview: LocalServicePreviewResourceV1 = {
        previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user', id: 'account_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
        display: { title: 'Preview', addressLabel: 'loopback' }, originMode: 'host',
        policy: { allowedMethods: ['POST'], cookiePolicy: 'drop', compressionPolicy: 'identity',
            redirectPolicy: 'preserve_host_origin', maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024 },
    };
    const output: Uint8Array[] = [];
    const result = await proxyLocalServicePreviewWebSocketUpgrade({
        preview,
        request: { path: '/hmr', search: '', headers: { upgrade: 'websocket', connection: 'Upgrade',
            'sec-websocket-key': 'client-key', 'sec-websocket-version': '13' }, rawHeaders: [],
            client: { async *read() {}, write: (bytes) => { output.push(bytes); }, end() {}, destroy() {} } },
        // The upstream network is a genuine boundary; policy must refuse before dialing it.
        openTunnel: async () => { throw new Error('No registered GET authority'); },
    });
    expect(result).toEqual({ ok: false, reasonCode: 'method_not_allowed' });
    expect(output.map((bytes) => new TextDecoder().decode(bytes)).join('')).toContain('HTTP/1.1 405 Method Not Allowed');
});

it('cancels an admitted WebSocket while its upstream handshake is pending', async () => {
    const preview: LocalServicePreviewResourceV1 = {
        previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user', id: 'account_1' },
        target: { scheme: 'http', host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
        display: { title: 'Preview', addressLabel: 'loopback' }, originMode: 'host',
    };
    const abort = new AbortController();
    let requestSent!: () => void;
    const sent = new Promise<void>((resolve) => { requestSent = resolve; });
    let finishRead!: () => void;
    const finished = new Promise<void>((resolve) => { finishRead = resolve; });
    let destroyed = false;
    const pending = proxyLocalServicePreviewWebSocketUpgrade({
        preview,
        request: { path: '/hmr', search: '', signal: abort.signal,
            headers: { upgrade: 'websocket', connection: 'Upgrade',
                'sec-websocket-key': 'client-key', 'sec-websocket-version': '13' }, rawHeaders: [],
            client: { async *read() {}, write() {}, end() {}, destroy() { destroyed = true; } } },
        // The remote socket has accepted the request but has not answered the upgrade.
        openTunnel: async () => ({ tunnelId: 'tunnel', substreamId: 'pending-upgrade',
            write() { requestSent(); }, endWrite() {}, close: finishRead, abort: finishRead,
            async *read() {
                await finished;
                yield new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
            },
        }),
    });
    try {
        await sent;
        abort.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(destroyed).toBe(true);
        await expect(pending).resolves.toMatchObject({ ok: false });
    } finally {
        finishRead();
        await pending;
    }
});
