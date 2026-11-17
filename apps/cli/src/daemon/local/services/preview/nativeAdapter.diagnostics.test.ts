import { createServer } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalServicePreviewResourceV1Schema, localServicePreviewDirectBindingV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { logger } from '@/ui/logger';
import { startLocalServicePreviewNativeAdapter } from './nativeAdapter';
import { createLocalServicePreviewRegistry, registerLocalServicePreview, resolveLocalServicePreviewApplication } from './registry';

describe('native preview transport failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['http', 'websocket'] as const)('retains the %s socket refusal through the real local adapter', async kind => {
        const listener = createServer();
        await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('Expected ephemeral loopback listener');
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        const preview = LocalServicePreviewResourceV1Schema.parse({
            previewId: 'diagnostic-preview', machineId: 'machine', owner: { kind: 'user', id: 'owner' },
            target: { scheme: 'http', host: '127.0.0.1', port: address.port }, initialPath: { pathname: '/' },
            display: { title: 'Preview', addressLabel: 'Loopback' }, originMode: 'host',
        });
        const registry = createLocalServicePreviewRegistry();
        registerLocalServicePreview(registry, preview);
        const binding = localServicePreviewDirectBindingV1(preview);
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const adapter = await startLocalServicePreviewNativeAdapter({ preview, signal: new AbortController().signal,
            resolvePreview: () => resolveLocalServicePreviewApplication(registry, binding) });
        try {
            if (kind === 'http') {
                const response = await fetch(`http://127.0.0.1:${adapter.port}/`);
                expect(response.status).toBe(503);
                await response.arrayBuffer();
            } else {
                await new Promise<void>(resolve => {
                    const upgrade = request({ hostname: '127.0.0.1', port: adapter.port, headers: {
                        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
                    } });
                    upgrade.once('error', () => resolve());
                    upgrade.once('response', response => { response.resume(); response.once('end', resolve); });
                    upgrade.end();
                });
            }
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'local_service.preview.socket', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null,
            }));
        } finally { await adapter.close(); }
    });
});
