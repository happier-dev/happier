import Fastify from 'fastify';
import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { logger, serializeHttpRequestForLog } from '@/utils/logging/log';
import { enableErrorHandlers } from './enableErrorHandlers';

function render(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

describe('public-share capability logging', () => {
    it('keeps the raw capability out of Fastify success, error, and 404 log boundaries', async () => {
        const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
        const records: string[] = [];
        const destination = new Writable({
            write(chunk, _encoding, callback) {
                records.push(String(chunk));
                callback();
            },
        });
        const requestLogger = pino({
            level: 'info',
            serializers: { req: serializeHttpRequestForLog },
        }, destination);
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const app = Fastify({ loggerInstance: requestLogger });
        enableErrorHandlers(app as any);
        app.get('/v1/public-share/:token', async () => ({ ok: true }));
        app.get('/v1/public-share/:token/messages', async () => {
            throw new Error(`boom at /v1/public-share/${secret}/messages`);
        });

        try {
            await app.inject({ method: 'GET', url: `/v1/public-share/${secret}` });
            await app.inject({ method: 'GET', url: `/v1/public-share/${secret}/messages` });
            await app.inject({ method: 'GET', url: `/v1/public-share/${secret}/missing` });
            const rendered = [...records, ...infoSpy.mock.calls.flat().map(render)].join('\n');
            expect(rendered).not.toContain(secret);
            expect(rendered).toContain('/v1/public-share/:token');
        } finally {
            infoSpy.mockRestore();
            await app.close();
        }
    });
});
