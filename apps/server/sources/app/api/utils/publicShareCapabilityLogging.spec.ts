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
    it('keeps public-share capabilities and OAuth callback credentials out of request logs', async () => {
        const secret = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
        const oauthCode = 'SENTINEL_OAUTH_AUTHORIZATION_CODE';
        const oauthState = 'SENTINEL_OAUTH_STATE';
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
        const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
        const app = Fastify({ loggerInstance: requestLogger });
        enableErrorHandlers(app as any);
        app.get('/v1/public-share/:token', async () => ({ ok: true }));
        app.get('/v1/public-share/:token/messages', async () => {
            throw new Error(`boom at /v1/public-share/${secret}/messages`);
        });
        app.get('/v1/supporter/discord/callback', async () => { throw new Error('Provider unavailable'); });

        try {
            const success = await app.inject({ method: 'GET', url: `/v1/public-share/${secret}` });
            const error = await app.inject({ method: 'GET', url: `/v1/public-share/${secret}/messages` });
            const missing = await app.inject({ method: 'GET', url: `/v1/public-share/${secret}/missing` });

            expect(success.statusCode).toBe(200);
            expect(error.statusCode).toBe(500);
            expect(missing.statusCode).toBe(404);
            const query = `?code=${oauthCode}&state=${oauthState}`;
            expect((await app.inject(`/v1/supporter/discord/callback${query}`)).statusCode).toBe(500);
            expect((await app.inject(`/v1/oauth/github/callback${query}`)).statusCode).toBe(404);

            const rendered = [
                ...records,
                ...infoSpy.mock.calls.flat().map(render),
                ...errorSpy.mock.calls.flat().map(render),
            ].join('\n');
            expect(rendered).not.toContain(secret);
            expect(rendered).toContain('/v1/public-share/:token');
            expect(rendered).toContain('/v1/supporter/discord/callback');
            expect(rendered).not.toContain(oauthCode);
            expect(rendered).not.toContain(oauthState);
        } finally {
            infoSpy.mockRestore();
            errorSpy.mockRestore();
            await app.close();
        }
    });
});
