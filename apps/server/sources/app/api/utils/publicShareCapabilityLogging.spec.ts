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

    it('keeps a browser Artifact capability and correlation query out of Fastify and global error logs', async () => {
        const capability = 'SENTINEL_BROWSER_ARTIFACT_CAPABILITY';
        const correlation = 'SENTINEL_BROWSER_ARTIFACT_CORRELATION';
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
        const route = '/v1/plugins/availability/ui-artifacts/browser/:capability';
        app.get(`${route}/assets/app.js`, async () => ({ ok: true }));
        app.get(`${route}/assets/error.js`, async () => {
            throw new Error(
                `boom at /v1/plugins/availability/ui-artifacts/browser/${capability}/assets/error.js?correlation=${correlation}`,
            );
        });

        try {
            await app.inject({
                method: 'GET',
                url: `/v1/plugins/availability/ui-artifacts/browser/${capability}/assets/app.js?correlation=${correlation}`,
            });
            await app.inject({
                method: 'GET',
                url: `/v1/plugins/availability/ui-artifacts/browser/${capability}/assets/error.js?correlation=${correlation}`,
            });
            await app.inject({
                method: 'GET',
                url: `/v1/plugins/availability/ui-artifacts/browser/${capability}/assets/missing.js?correlation=${correlation}`,
            });
            const rendered = [...records, ...infoSpy.mock.calls.flat().map(render)].join('\n');
            expect(rendered).not.toContain(capability);
            expect(rendered).not.toContain(correlation);
            expect(rendered).toContain('/v1/plugins/availability/ui-artifacts/browser/:token/assets');
        } finally {
            infoSpy.mockRestore();
            await app.close();
        }
    });
});
