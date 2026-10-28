import Fastify, { type FastifyInstance } from 'fastify';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { encodeBase64 } from 'privacy-kit';
import { describe, expect, it } from 'vitest';
import { enableApiCompression } from './enableApiCompression';
import { enableServeUi } from './enableServeUi';

const sessionList = {
    sessions: Array.from({ length: 12 }, (_, index) => ({
        id: `session-${index}`,
        seq: index,
        metadata: encodeBase64(randomBytes(2048)),
        metadataVersion: 1,
        agentState: encodeBase64(randomBytes(1024)),
        agentStateVersion: 1,
    })),
    hasNext: false,
};

async function withApp(run: (app: FastifyInstance) => Promise<void>) {
    const app = Fastify();
    try {
        await enableApiCompression(app);
        app.get('/v2/sessions', () => sessionList);
        await run(app);
    } finally {
        await app.close();
    }
}

describe('API response compression', () => {
    it.each(['gzip', 'br'] as const)('negotiates %s and preserves the encrypted list exactly', async (encoding) => {
        await withApp(async (app) => {
            const response = await app.inject({ url: '/v2/sessions', headers: { 'accept-encoding': encoding } });
            expect(response.statusCode).toBe(200);
            expect(response.headers['content-encoding']).toBe(encoding);
            expect(response.headers.vary?.toString().toLowerCase()).toContain('accept-encoding');
            const decoded = encoding === 'gzip' ? gunzipSync(response.rawPayload) : brotliDecompressSync(response.rawPayload);
            expect(decoded.toString()).toBe(JSON.stringify(sessionList));
        });
    });

    it.each([undefined, 'identity', 'gzip;q=0, br;q=0'])('preserves identity for Accept-Encoding %s', async (encoding) => {
        await withApp(async (app) => {
            const response = await app.inject({
                url: '/v2/sessions',
                headers: encoding === undefined ? {} : { 'accept-encoding': encoding },
            });
            expect(response.headers['content-encoding']).toBeUndefined();
            expect(response.json()).toEqual(sessionList);
        });
    });

    it('honors encoding quality and merges Vary', async () => {
        await withApp(async (app) => {
            app.get('/v1/list', (_request, reply) => reply.header('vary', 'Origin').send(sessionList));
            const response = await app.inject({ url: '/v1/list', headers: { 'accept-encoding': 'br;q=0.2, gzip;q=1' } });
            expect(response.headers['content-encoding']).toBe('gzip');
            expect(response.headers.vary?.toString().toLowerCase()).toContain('origin');
            expect(response.headers.vary?.toString().toLowerCase()).toContain('accept-encoding');
        });
    });

    it('leaves small JSON responses unencoded', async () => {
        await withApp(async (app) => {
            app.get('/v1/small', () => ({ ok: true }));
            const response = await app.inject({ url: '/v1/small', headers: { 'accept-encoding': 'gzip' } });
            expect(response.headers['content-encoding']).toBeUndefined();
            expect(response.json()).toEqual({ ok: true });
        });
    });

    it.each(['/v1/updates', '/v1/updates/'])('excludes the Socket.IO path %s', async (path) => {
        await withApp(async (app) => {
            app.get(path, () => sessionList);
            const response = await app.inject({ url: `${path}?EIO=4&transport=polling`, headers: { 'accept-encoding': 'gzip' } });
            expect(response.headers['content-encoding']).toBeUndefined();
            expect(response.json()).toEqual(sessionList);
        });
    });

    it('preserves pre-encoded responses without double encoding', async () => {
        await withApp(async (app) => {
            const bytes = gzipSync(JSON.stringify(sessionList));
            app.get('/v1/preencoded', (_request, reply) => reply
                .type('application/json').header('content-encoding', 'gzip').send(bytes));
            const response = await app.inject({ url: '/v1/preencoded', headers: { 'accept-encoding': 'br, gzip' } });
            expect(response.headers['content-encoding']).toBe('gzip');
            expect(response.rawPayload).toEqual(bytes);
        });
    });

    it('leaves opted-out JSON streams and non-API JSON assets untouched', async () => {
        await withApp(async (app) => {
            const bytes = JSON.stringify(sessionList);
            app.get('/v1/stream', { compress: false }, (_request, reply) => reply.type('application/json').send(Readable.from([bytes])));
            app.get('/assets/manifest.json', () => sessionList);
            for (const url of ['/v1/stream', '/assets/manifest.json']) {
                const response = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
                expect(response.headers['content-encoding']).toBeUndefined();
                expect(response.body).toBe(bytes);
            }
        });
    });

    it.each(['/', '/v1/ui'])('preserves static UI sidecars and unencoded fallback at %s', async (prefix) => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-api-compression-ui-'));
        try {
            const bytes = JSON.stringify(sessionList);
            const encoded = gzipSync(bytes);
            await writeFile(join(dir, 'manifest.json'), bytes);
            await writeFile(join(dir, 'manifest.json.gz'), encoded);
            await writeFile(join(dir, 'plain.json'), bytes);
            await withApp(async (app) => {
                enableServeUi(app, { dir, prefix, mountRoot: prefix === '/', required: false });
                const base = prefix === '/' ? '' : prefix;
                const response = await app.inject({ url: `${base}/manifest.json`, headers: { 'accept-encoding': 'gzip' } });
                expect(response.headers['content-encoding']).toBe('gzip');
                expect(response.rawPayload).toEqual(encoded);
                expect(Number(response.headers['content-length'])).toBe(encoded.length);
                const identity = await app.inject({ url: `${base}/manifest.json`, headers: { 'accept-encoding': 'identity' } });
                expect(identity.headers['content-encoding']).toBeUndefined();
                expect(identity.body).toBe(bytes);
                const plain = await app.inject({ url: `${base}/plain.json`, headers: { 'accept-encoding': 'gzip' } });
                expect(plain.headers['content-encoding']).toBeUndefined();
                expect(plain.body).toBe(bytes);
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('delivers an opted-out stream before completion and destroys it on client cancellation', async () => {
        await withApp(async (app) => {
            const source = new PassThrough();
            try {
                app.get('/v1/live-stream', { compress: false }, (_request, reply) => reply.type('application/json').send(source));
                const address = await app.listen({ port: 0, host: '127.0.0.1' });
                const controller = new AbortController();
                const pending = fetch(`${address}/v1/live-stream`, { headers: { 'accept-encoding': 'gzip' }, signal: controller.signal });
                source.write('{"sessions":[');
                const response = await pending;
                expect(response.headers.get('content-encoding')).toBeNull();
                expect(response.headers.get('transfer-encoding')).toBe('chunked');
                const reader = response.body!.getReader();
                const first = await reader.read();
                expect(new TextDecoder().decode(first.value)).toBe('{"sessions":[');
                expect(source.readableEnded).toBe(false);
                const closed = once(source, 'close');
                controller.abort();
                await closed;
                expect(source.destroyed).toBe(true);
            } finally {
                source.destroy();
            }
        });
    });

    it('decodes negotiated responses with the CLI axios and fetch transports', async () => {
        await withApp(async (app) => {
            app.get('/v1/client-encoding', (request) => ({ list: sessionList, accepted: request.headers['accept-encoding'] }));
            const address = await app.listen({ port: 0, host: '127.0.0.1' });
            const cli = await axios.get<{ list: typeof sessionList; accepted: string }>(`${address}/v1/client-encoding`, { proxy: false });
            expect(cli.data.accepted).toMatch(/\bbr\b/);
            expect(cli.data.list).toEqual(sessionList);
            const response = await fetch(`${address}/v2/sessions`);
            expect(response.headers.get('content-encoding')).toBe('gzip');
            expect(await response.json()).toEqual(sessionList);
        });
    });
});
